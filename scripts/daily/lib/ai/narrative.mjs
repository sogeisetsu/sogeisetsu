#!/usr/bin/env node
/**
 * scripts/daily/lib/ai/narrative.mjs
 * ------------------------------------------------------------------
 * 每日报告的 AI 叙事：prompt 构建、双语 JSON 校验、生成入口（零依赖 ESM，Node 20+）。
 *
 * 数据流：
 *   data（每日数据 schema，见 scripts/daily/lib/ai.mjs 头注释）→ 压缩成紧凑 prompt
 *   → generateStructured（ai/structured.mjs：按 config/providers.json 的链逐腿尝试）
 *   → 提取 / 解析 / 校验（不合格追加“只输出 JSON”后重试一次）→ { en, zh, provider, model }
 *
 * 口径：本函数不判断「今天是否值得生成」—— 那是调用方（daily/index.mjs）的职责，
 * 口径是 hasVisibleActivity（含 discussion / release / star / 回复等附加段），
 * 与 totals 口径的 data.empty 并不等价。
 *
 * 用法：node scripts/daily/lib/ai/narrative.mjs --data=path.json
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { AUTOMATED_OVERLAP_RE, HEADLINE_MAX_CHARS } from "../../../lib/rules.mjs";
import { LOG } from "./transport.mjs";
import { generateStructured } from "./structured.mjs";
import { defaultProviders } from "./defaults.mjs";
import { countSentences, fitHeadline, fitSentences, fitText, unescapeProse } from "./prose.mjs";

// ---------------------------------------------------------------- 常量与 prompt 体积上限

const SECTION_CAP = 30; // 每个板块最多喂 30 条
const DAILY_COMMIT_MSG_CAP = 10; // 每个仓库最多喂 10 条 commit message（日报口径；与总结的同名上限只是巧合同值）
const COMMIT_MSG_LEN = 200; // 每条 commit message 截断到 200 字符
const RELEASE_NOTES_CAP = 800; // 每条 release notes 最多 800 字符

const SUMMARY_MIN_SENTENCES = 2; // 提示词目标 4-8 句；校验放宽容差，避免把「9 句」这种好结果误拒
const SUMMARY_MAX_SENTENCES = 12;
const SUMMARY_MAX_CHARS = 1400; // summary 目标 ~900 字符；模型偶写到 ~1800，超出部分按句界截断而非拒绝
const RELEASE_NOTE_MAX_SENTENCES = 3;

// ---------------------------------------------------------------- prompt 构建

const SYSTEM_PROMPT = [
  "You write a neutral, factual daily GitHub activity report.",
  "Reply with ONE strict JSON object only: no prose, no markdown, no code fences.",
  'Schema: {"en":{"headline":"...","summary":"...","releaseNotes":[{"repo":"...","tag":"...","summary":"..."}]},"zh":{...same shape...}}',
  "Rules:",
  "- headline: one line, at most 80 characters (count them; NEVER exceed 80).",
  "- summary: 4-8 sentences and UNDER 1200 characters (hard limit — count characters; stay well below). Name concrete specifics from the input — repository names, issue/PR numbers and titles, who replied, what a release changed — and describe what actually happened that day, in order. No filler, no repeating the headline, no generic 'a busy day'.",
  "- releaseNotes: one entry ONLY for each release in the input, matching repo+tag exactly; each summary at most 3 sentences; use [] when there are no releases.",
  "- Commits: for the user's OWN commits (commits[].messages), summarize what they actually changed by synthesizing their commit messages — group and shorten them; do NOT list the messages verbatim.",
  "- Commits: `count` is the user's OWN commit count; `automated` is a SEPARATE, ADDITIONAL count of bot/automated commits — never a subset of `count`. Phrase them as additive, e.g. \"8 own commits plus 1 automated commit by github-actions[bot]\" / \"8 次本人提交，另有 1 次由 github-actions[bot] 自动提交\" — never \"8 commits, of which 1 was automated\" / \"8 次提交，其中 1 次为自动提交\" (never \"其中\"/\"of which\" overlap).",
  "- If automatedCommits is non-zero (or a commit entry has automated > 0), mention only the automated commit count and who created them (the automatedBots logins), e.g. \"2 automated commits by github-actions[bot]\"; never describe the automated commits' contents.",
  "- Grand totals: use the numbers in `totals` (`commits` / `prs` / `issues` / `reviews`) VERBATIM for any overall count — never recompute, round, adjust, or derive them from detail lists; if `totals.commits` is 22, write 22, never \"20\". Per-repo commit numbers come from `commits[].count` (the user's own) plus `commits[].automated` (bot, additive); do NOT sum across repos to produce a different grand total.",
  "- Issues: the issues total covers items you opened, closed, or commented on. Summarize it as \"opened or closed N issues\" (新开或关闭 N 个 issue) — never \"opened and closed\" / \"新开并关闭\", and never imply that all of them were closed. When the per-item actions are known, describe what actually happened (e.g. \"opened 3 issues, one of which was later closed\").",
  "- `comments` on an issue/PR row is that item's total comment count (live REST value at collection time, bots and the user included) — use it only to describe interaction heat; NEVER add it to `totals` and never adjust issue/PR counts from it.",
  "- Discussions: `discussions` lists the user's own discussion activity — `action:\"started\"` means the user opened that discussion, `action:\"commented\"` means the user replied inside someone else's discussion; `comments` is the discussion's total comment count. Mention started discussions with their title and repo; for `commented`, phrase it as joining/commenting in an existing discussion, NEVER as starting it. Others' replies to the user's discussions arrive in `replies` with kind `discussion_comment` — count them as replies received.",
  "- Truncation: `truncated` reports whether any section hit a collection cap. If `truncated.<section>.hits` is true for a section you mention, you MUST say that only the capped number is shown and that more may exist — e.g. \"only the first 25 were examined, so some state changes may be missing\" / \"仅检查了前 25 条，部分状态变更可能未收录\". Use the section's `cap` for the number. Never present a truncated section as if it were complete.",
  "- en and zh must state exactly the same facts.",
  "- zh must be natural Simplified Chinese, not a literal machine translation.",
  "- Neutral and factual: no hype, no speculation, no invented facts; keep repo names, numbers and tags verbatim from the input.",
  "- Inline formatting: inside SUMMARY (not the headline) use EXACTLY two Markdown markers and nothing else — inline code with a single backtick `like-this`, and bold with double asterisks **like this**. Inline code is expected, not optional: wrap EVERY literal identifier in backticks — repository names such as `sogeisetsu/sogeisetsu` and `iOfficeAI/OfficeCLI`, bot logins such as `github-actions[bot]`, file/script paths such as `scripts/daily/verify.mjs` and `~/.opencode`, config keys, commands, commit SHAs, version/tag names, and anything else literal that you judge should be code. Bold is also expected, not optional: in the summary, bold the single most important number or outcome (e.g. one key commit total, a standout figure like a 0%→100% success jump, or the headline result). Aim for 1–3 bolded spans total so emphasis stays meaningful. The headline must be PLAIN TEXT — no backticks, no asterisks, no other markup of any kind. Do NOT use any other Markdown anywhere (no headings, no lists, no links, no italic, no tables, no code fences). Keep raw HTML out. The JSON envelope itself must stay pure JSON with no markdown.",
  "- Escaping: the JSON envelope is JSON, but the PROSE inside it is plain text — write quotation marks as ordinary characters (\" or “”), never backslash-escaped (no \\\" inside the summary text), and never emit literal \\n / \\t.",
].join("\n");

const cap = (list) => (Array.isArray(list) ? list.slice(0, SECTION_CAP) : []);

/** 把 data 压成紧凑 user prompt：只含聚合条目 + 总数 + 日期。 */
function buildPrompts(data) {
  const payload = {
    date: data.date,
    windowStart: data.windowStart,
    windowEnd: data.windowEnd,
    username: data.username,
    totals: data.totals || {},
    // commit 明细：只留消息字符串（丢 sha/ts），每仓库最多 10 条、每条 200 字符
    commits: cap(data.commits).map((c) => ({
      repo: c?.repo,
      count: c?.count,
      own: c?.own,
      automated: c?.automated,
      automatedBots: (Array.isArray(c?.automatedBots) ? c.automatedBots : []).slice(0, 3), // 最多喂 3 个 bot login
      messages: (Array.isArray(c?.messages) ? c.messages : [])
        .slice(0, DAILY_COMMIT_MSG_CAP)
        .map((m) =>
          String((m && typeof m === "object" ? m.message : m) ?? "").slice(0, COMMIT_MSG_LEN)
        )
        .filter((s) => s.length > 0),
    })),
    automatedCommits: data.automatedCommits ?? 0,
    pullRequests: cap(data.pullRequests),
    reviews: cap(data.reviews),
    issues: cap(data.issues),
    releases: cap(data.releases).map((r) => ({
      repo: r?.repo,
      tag: r?.tag,
      name: r?.name,
      url: r?.url,
      publishedAt: r?.publishedAt,
      notes: String(r?.notes || "").slice(0, RELEASE_NOTES_CAP),
    })),
    stars: cap(data.stars),
    replies: cap(data.replies),
    // 他人 close/merge/reopen 的状态变化：去掉 url/own 省 token
    stateChanges: cap(data.stateChanges).map((s) => ({
      repo: s?.repo,
      number: s?.number,
      title: s?.title,
      action: s?.action,
      actor: s?.actor,
      ts: s?.ts,
    })),
    // 截断提示：各段是否因人工上限只采集/展示了部分数据
    truncated: data.truncated || {},
    // 我发起 / 我评论的讨论：去掉 url 省 token（repo+number 足够定位）
    discussions: cap(data.discussions).map((d) => ({
      repo: d?.repo,
      number: d?.number,
      title: d?.title,
      category: d?.category,
      comments: d?.comments,
      action: d?.action,
      ts: d?.ts,
    })),
  };
  const user =
    `Write the daily report for ${data.date} as ONE strict JSON object.\n` +
    `Input:\n${JSON.stringify(payload)}`;
  return { system: SYSTEM_PROMPT, user };
}

/** 校验双语 JSON 结构；通过则返回规范化后的 { en, zh }，否则 { ok:false, reason }。 */
function validateNarrative(raw, data) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "根节点不是 JSON 对象" };
  }
  // 只允许输出输入中出现过的 release（repo+tag 精确匹配）
  const releaseKeys = new Set(
    (Array.isArray(data.releases) ? data.releases : []).map(
      (r) => `${r?.repo ?? ""}@@${r?.tag ?? ""}`
    )
  );

  const value = {};
  for (const lang of ["en", "zh"]) {
    const sec = raw[lang];
    if (!sec || typeof sec !== "object") return { ok: false, reason: `缺少 ${lang} 段` };

    // 硬性长度用代码强制（模型无法稳定遵守字符上限）：超长按句界/词界截断，而不是整段拒绝
    const headline = fitHeadline(unescapeProse(String(sec.headline ?? "")).trim(), HEADLINE_MAX_CHARS);
    const summaryRaw = unescapeProse(String(sec.summary ?? "")).trim();
    // 自动提交写成「其中/包含」的包含关系 → 拒收重试（本人与机器人提交是相加关系）
    const overlap = AUTOMATED_OVERLAP_RE.exec(summaryRaw);
    if (overlap) {
      return {
        ok: false,
        reason: `${lang}.summary 把自动提交写成包含关系（「${overlap[0]}」），应写成「本人 N 次，另有 M 次」`,
      };
    }
    const summary = fitText(
      summaryRaw,
      SUMMARY_MAX_CHARS,
      SUMMARY_MIN_SENTENCES,
      SUMMARY_MAX_SENTENCES
    );
    if (!headline) return { ok: false, reason: `${lang}.headline 为空` };
    if (!summary) return { ok: false, reason: `${lang}.summary 为空` };
    const sentences = countSentences(summary);
    if (sentences < SUMMARY_MIN_SENTENCES) {
      return {
        ok: false,
        reason: `${lang}.summary 句数 ${sentences} < ${SUMMARY_MIN_SENTENCES}`,
      };
    }

    let notes = sec.releaseNotes;
    // 没有 release 时允许省略 releaseNotes
    if (notes === undefined && releaseKeys.size === 0) notes = [];
    if (!Array.isArray(notes)) return { ok: false, reason: `${lang}.releaseNotes 不是数组` };

    const normNotes = [];
    for (const note of notes) {
      if (!note || typeof note !== "object") {
        return { ok: false, reason: `${lang}.releaseNotes 元素不是对象` };
      }
      const repo = String(note.repo ?? "").trim();
      const tag = String(note.tag ?? "").trim();
      const text = fitSentences(
        unescapeProse(String(note.summary ?? "")).trim(),
        RELEASE_NOTE_MAX_SENTENCES
      );
      if (!releaseKeys.has(`${repo}@@${tag}`)) {
        return { ok: false, reason: `${lang}.releaseNotes 出现输入之外的 release: ${repo}@${tag}` };
      }
      if (!text) {
        return { ok: false, reason: `${lang}.releaseNotes ${repo}@${tag} summary 为空` };
      }
      normNotes.push({ repo, tag, summary: text });
    }

    value[lang] = { headline, summary, releaseNotes: normNotes };
  }
  return { ok: true, value };
}

/**
 * 生成每日叙事。成功返回 { en, zh, provider, model, attempts }；以下情况返回 null：
 *   没有可用 provider／全部 provider 失败。
 *
 * 注意：本函数不判断「今天是否值得生成」——那是调用方（index.mjs）的职责，
 * 口径是 hasVisibleActivity（含 discussion/release/star/回复等附加段），
 * 与 totals 口径的 data.empty 并不等价。历史上在这里按 data.empty 二次拦截，
 * 导致「只发了 discussion 的一天」永远拿不到叙述，并让上游每轮空转重试。
 */
export async function generateNarrative({ data, providers, onProviderFailure, budgetMs }) {
  if (data == null) {
    console.error(`${LOG} data 为空，跳过`);
    return null;
  }

  const { system, user } = buildPrompts(data);
  const res = await generateStructured({
    system,
    user,
    validate: (parsed) => validateNarrative(parsed, data),
    providers,
    onProviderFailure,
    budgetMs,
  });
  if (!res) return null;
  return {
    en: res.value.en,
    zh: res.value.zh,
    provider: res.provider,
    model: res.model,
    attempts: res.attempts,
  };
}

// ---------------------------------------------------------------- CLI

async function main() {
  const arg = process.argv.find((a) => a.startsWith("--data="));
  if (!arg) {
    console.error(`${LOG} 用法: node scripts/daily/lib/ai.mjs --data=path.json`);
    process.exitCode = 1;
    return;
  }
  const dataPath = path.resolve(arg.slice("--data=".length));
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  const result = await generateNarrative({ data, providers: defaultProviders() });
  if (result) console.log(JSON.stringify(result, null, 2));
  else console.log("all providers failed");
}

// 仅当作为入口直接执行时跑 CLI（被 import 时不执行）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(`${LOG} 错误: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
  });
}
