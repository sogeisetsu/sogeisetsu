#!/usr/bin/env node
/**
 * scripts/daily/lib/ai.mjs
 * ------------------------------------------------------------------
 * 每日报告 AI 叙事生成（零依赖 ESM，Node 20+ 内置 fetch）。
 *
 * 数据流：
 *   data（每日数据 schema，见下）→ 压缩成紧凑 prompt（只喂聚合条目，不喂原始事件）
 *   → 按顺序尝试 providers（OpenCode Go 两条 → sensenova；chat / responses 两种形态）→ 一次调用产出严格 JSON（en + zh 双语）
 *   → 提取 / 解析 / 校验（不合格追加“只输出 JSON”后重试一次）→ { en, zh, provider, model }
 *
 * data schema（输入契约）：
 *   {
 *     date, windowStart, windowEnd, username, generatedAt, empty,
 *     totals:      { commits, prs, issues, reviews },
 *     commits:       [ { repo, count, own } ],
 *     pullRequests:  [ { repo, number, title, url, action, ts, own } ],
 *     reviews:       [ { repo, number, title, url, ts, own } ],
 *     issues:        [ { repo, number, title, url, action, ts, own } ],
 *     releases:      [ { repo, tag, name, url, publishedAt, notes } ],
 *     stars:         [ { repo, delta, total } ],
 *     replies:       [ { repo, number, title, url, author, excerpt, kind, ts, own } ],
 *     stateChanges:  [ { repo, number, title, action, actor, ts } ],
 *     discussions:   [ { repo, number, title, category, comments, action, ts } ],
 *     truncated:     { events|targets|replies|stateChanges: { cap, hits } }  // hits=true 表示该段被上限截断
 *   }
 *
 * 导出：
 *   generateNarrative({ data, providers, budgetMs? })   // 是否有内容值得叙述由调用方判断；本函数不按 empty 自行拦截
 *   generateStructured({ system, user, validate, providers, feedback, onProviderFailure, budgetMs })
 *                                            // 通用结构化生成入口：日报与 30 天总结共用同一套重试/校验循环
 *   defaultProviders(env = process.env)      // = providersForLane("daily", env)（配置在 config/providers.json）
 *   sanitizeReason(text, maxLen?)            // 失败原因脱敏：key / Bearer / 长 token / URL 一律替换 + 截断
 *
 * provider 结构：{ name, endpoint, baseUrl, apiKey, model, shape, headers?, reasoningEffort?, extraBody?, responseFormat? }
 *   name = **稳定 slug**（`attempts[].provider` / 页面徽章用它），model = 真实 API id
 *   链顺序 / 参数 / 预算一律来自 `config/providers.json`（`scripts/daily/lib/providers.mjs` 解析），
 *   本文件不再持有「哪条腿在链里」这类事实。
 *   shape = "chat"      → POST {baseUrl}/chat/completions
 *   shape = "responses" → POST {baseUrl}/responses
 *   headers（可选）      → 追加到请求头（OpenCode Go 要求自报 user-agent / 会话 id）
 *   reasoningEffort（可选）→ chat 形态的 reasoning_effort 取值，默认 "none"（关思考）。
 *   extraBody（可选）    → 合并进 chat 请求体（sensenova 借它发 thinking:{type:"disabled"} 关思考）
 *   responseFormat（可选）→ false 表示从不发 `response_format:{type:"json_object"}`（默认发）
 *   endpoint（可选）     → endpoint 名（`sensenova` 的 404/405 → responses 形态特判按它判断）
 *
 * 用法：node scripts/daily/lib/ai.mjs --data=path.json
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { providersForLane } from "./providers.mjs";

// ---------------------------------------------------------------- 常量

const LOG = "[daily-report]";
const SECTION_CAP = 30; // 每个板块最多喂 30 条
const COMMIT_MSG_CAP = 10; // 每个仓库最多喂 10 条 commit message
const COMMIT_MSG_LEN = 200; // 每条 commit message 截断到 200 字符
const RELEASE_NOTES_CAP = 800; // 每条 release notes 最多 800 字符
const MAX_TOKENS = 49152; // chat max_tokens / responses 共用；实测最坏 17213 completion tokens（含 reasoning），16384 会被截断，49152 ≈ 2.9x 余量
const MAX_TOKENS_CAP = 65536; // 截断时自适应扩容上限（各家 output 上限远高于此）
const SUMMARY_MIN_SENTENCES = 2; // 提示词目标 4-8 句；校验放宽容差，避免把「9 句」这种好结果误拒
const SUMMARY_MAX_SENTENCES = 12;
const SUMMARY_MAX_CHARS = 1400; // summary 目标 ~900 字符；模型偶写到 ~1800，超出部分按句界截断而非拒绝
const HEADLINE_MAX_CHARS = 80; // headline 硬上限；超出按分隔符/词界截断
const RELEASE_NOTE_MAX_SENTENCES = 3;
const RETRY_WAIT_MS = 2000; // 429/5xx 重试前等待 ~2s
const MAX_ROUNDS = 12; // 单 provider 内部循环安全上限（json 重试×3 + rf-400 退让 + 429 重试 + 形态切换 + 截断重试）
const CHAT_TIMEOUT_MS = 180000; // chat/responses POST 超时；总结线唯一的稳定腿实测 51.8–83.0s，90s 太贴边
const MIN_ATTEMPT_MS = 1000; // 剩余 lane 预算低于这个值就别再发请求（否则一定在预算外拖一个必败的往返）

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 带超时的 fetch：AbortController + setTimeout，finally 里清定时器，避免句柄泄漏。 */
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- provider 进程内状态

// 进程内记住不支持 response_format 的 provider（key: name+baseUrl），后续调用直接跳过
const jsonModeUnsupported = new Set();

// 校验失败后的纠正提醒（第 1 次请求不带提醒，之后最多追加 MAX_CORRECTIONS 次 → 共 4 次尝试）：
// JSON 类失败用通用 JSON 提醒；超长/句数类失败给出可执行的长度反馈。
// 长度问题是重灾区：模型在重输入下的自然输出常达 1500-1900 字符，超过校验上限；只重复“输出 JSON”无法纠正，必须明确要求变短。
const JSON_REMINDERS = [
  "Return ONLY valid JSON, no prose, no markdown fences.",
  "Output must start with { and end with }. No other text.",
  "Output the COMPLETE JSON object ending with }; do not cut it off.",
];
const MAX_CORRECTIONS = 3;

/** 根据上一轮校验失败原因，生成可执行的纠正提示（让模型能真正改对，而不是重复同一错误）。 */
function buildRetryFeedback(reason, n) {
  const r = String(reason || "");
  if (/headline 超长/.test(r)) {
    return "REJECTED: the headline was too long. Rewrite with a headline of AT MOST 72 characters (count them); keep only the single most important fact.";
  }
  if (/summary 超长/.test(r)) {
    return "REJECTED: the summary was too long. Rewrite the summary with 4-6 sentences and UNDER 1100 characters (hard limit). Keep the concrete repository names, numbers and tags, but drop secondary detail.";
  }
  if (/句数/.test(r)) {
    return "REJECTED: the summary sentence count was outside 4-8. Rewrite with 4-6 sentences.";
  }
  if (/包含关系|自动提交/.test(r)) {
    return 'REJECTED: automated commits are SEPARATE and ADDITIONAL — never a subset of the user\'s own commits. Rewrite additive: "8 own commits plus 1 automated commit" / "8 次本人提交，另有 1 次自动提交"; never "其中" / "of which" / "includes" / "包含".';
  }
  if (/releaseNotes/.test(r)) {
    return "REJECTED: check releaseNotes — one entry per input release, repo+tag exactly matching, each summary at most 3 sentences.";
  }
  return JSON_REMINDERS[Math.min(n, JSON_REMINDERS.length - 1)];
}

/**
 * 失败原因脱敏（写进 issue 正文 / 页面失败卡前必过）。
 *
 * 口径：宁可多替换，绝不漏 key。依次抹掉
 *   · `Bearer <token>` 授权头
 *   · `sk-…` / `oc_…` 形态的 API key
 *   · 任意 ≥24 位的 `[A-Za-z0-9_-]` 串（长 token / 长 session id / commit sha 一律算敏感）
 *   · `http(s)://…` URL（baseUrl / query 都可能藏在里面）
 * 最后单条截断到 maxLen 字符（默认 300，模型返回的 snippet 上限也在这量级）。
 */
export function sanitizeReason(text, maxLen = 300) {
  let s = String(text ?? "");
  s = s.replace(/Bearer\s+\S+/gi, "<redacted>");
  s = s.replace(/\b(?:sk-|oc_)[A-Za-z0-9_-]{6,}/g, "<redacted>");
  s = s.replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>");
  s = s.replace(/https?:\/\/\S+/gi, "<redacted-url>");
  s = s.trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

// ---------------------------------------------------------------- provider 列表

/**
 * 日报线的 provider 列表 —— 等价 `providersForLane("daily", env)`。
 *
 * 链顺序、模型 id、参数（reasoningEffort / extraBody / responseFormat）、endpoint 头**全部**来自
 * `config/providers.json`；本文件不再写死任何一条腿。改链路 / 改参数 = 改那个 JSON + 跑
 * `node scripts/providers.mjs check`（`check.mjs` 里会跑）。
 *
 * 配置缺失 / JSON 损坏 / schema 不合法时，`providers.mjs` 会 warn 并回落到内置 FALLBACK_CHAIN
 * （deepseek → sensenova）：CI 不能因为一个坏 JSON 全挂，但提交前预检会让坏配置直接红。
 */
export function defaultProviders(env = process.env) {
  return providersForLane("daily", env);
}

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
].join("\n");

/**
 * 「自动提交是相加项」的包含式误用检测 —— 日报叙述、30 天总结、verify 共用一份正则。
 *
 * 口径：`count`（本人提交）与 `automated`（机器人提交）互不相交，相加才等于总提交数。
 * 模型偶发写成包含关系（线上实证：zh 总结「368 次提交……其中提交数包含 336 次自动提交」，
 * en 同名句 "the commit figure includes 336 automated commits"）。只拦「提交数紧邻
 * 其中/包含/包括…自动提交」这一族说法，不拦正常的中文「其中」（如「若干 issue 已关闭，其中…」）。
 * 反向的「自动提交不计入总数」是正确说法，故「计入」前必须不是「不」。
 */
export const AUTOMATED_OVERLAP_RE = new RegExp(
  [
    String.raw`(?:其中|包含|包括)[^。\n]{0,12}(?:\d+\s*)?(?:次)?自动提交`,
    String.raw`自动提交[^。\n]{0,12}(?<!不)(?:计入|包含在|算在|并入|已包含)`,
    String.raw`\b(?:includes?|including|contains?|containing)\b[^.\n]{0,24}automated\s+commits?`,
    String.raw`\bautomated\s+commits?\b[^.\n]{0,24}(?:(?<!not )(?:included in|counted in)|part of)\b`,
    String.raw`\bcommits?\b[^.\n]{0,24}\bof which\b`,
  ].join("|"),
  "i"
);

/**
 * 旧的日报叙述能否安全沿用（`index.mjs` 的「AI 失败 + 数据未变」分支用）。
 *
 * 目的：让措辞规则对**已发布**的叙述也生效 —— 旧规则下写出的「其中…自动提交」
 * 不能因为这次 AI 全挂而被原样带回页面。summary 或任一 releaseNotes 命中包含式
 * 就返回 false，调用方宁可出失败卡也不沿用。
 */
export function narrativeWordingOk(ai) {
  for (const lang of ["en", "zh"]) {
    const sec = (ai && ai[lang]) || {};
    if (AUTOMATED_OVERLAP_RE.test(String(sec.summary ?? ""))) return false;
    const notes = Array.isArray(sec.releaseNotes) ? sec.releaseNotes : [];
    for (const note of notes) {
      if (AUTOMATED_OVERLAP_RE.test(String((note && note.summary) ?? ""))) return false;
    }
  }
  return true;
}

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
        .slice(0, COMMIT_MSG_CAP)
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

// ---------------------------------------------------------------- 解析与校验

/** 从首个 `{` 起按括号配平扫出完整 JSON（正确处理字符串内的 { } 与转义），用于剔除 JSON 前后的散文。 */
function balancedJsonSlice(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // 括号不配平（多为截断）
}

/**
 * 从返回文本里稳提取 JSON：剥 ```json 围栏 → 括号配平切片 / 首 { 到末 } → 去掉裸控制字符 → JSON.parse。
 * 多个候选逐个尝试，失败返回 null。
 */
function parseJsonPayload(text) {
  let t = String(text ?? "").trim();
  if (!t) return null;
  t = t.replace(/```(?:json)?/gi, "").trim(); // 剥围栏
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  const candidates = [];
  const balanced = balancedJsonSlice(t);
  if (balanced) candidates.push(balanced);
  if (first !== -1 && last > first) candidates.push(t.slice(first, last + 1));
  candidates.push(t); // 兜底：整段直接就是 JSON
  for (const raw of candidates) {
    // 裸控制字符（字符串内未转义的换行/制表符）会让 JSON.parse 失败，去掉后再试一次
    for (const candidate of [raw, raw.replace(/[\u0000-\u001F]+/g, " ")]) {
      try {
        return JSON.parse(candidate);
      } catch {
        // 继续尝试下一个候选
      }
    }
  }
  return null;
}

/** 粗算句数：中文句号/叹号/问号直接计数（中文句间通常无空格）；英文句末标点需后接空白或结尾，避免小数点、缩写点误判。 */
export function countSentences(text) {
  const s = String(text).trim();
  if (!s) return 0;
  const cjk = (s.match(/[。！？]/g) || []).length;
  const latin = (s.match(/[.!?]+(?=\s|$)/g) || []).length;
  let n = cjk + latin;
  if (!/[.!?。！？]\s*$/.test(s)) n += 1; // 末尾没有句号的残句也计入
  return n;
}

/** 按句末标点切句（中英兼顾），保留标点、去掉空段。 */
export function splitSentences(text) {
  const s = String(text).trim();
  if (!s) return [];
  const out = [];
  let buf = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    buf += ch;
    const cjkEnd = ch === "。" || ch === "！" || ch === "？";
    const latinEnd = (ch === "." || ch === "!" || ch === "?") && (i + 1 >= s.length || /\s/.test(s[i + 1]));
    if (cjkEnd || latinEnd) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 拼接句子：前句以中文句末标点结尾时不留空格（中文句间通常无空格），否则用空格。 */
function joinSentences(sentences) {
  let out = "";
  for (let i = 0; i < sentences.length; i += 1) {
    if (i === 0) { out = sentences[i]; continue; }
    const prev = sentences[i - 1];
    out += (/[。！？]$/.test(prev) ? "" : " ") + sentences[i];
  }
  return out;
}

/** 保留前 keepMax 句（用于 release notes 等）。 */
function fitSentences(text, keepMax) {
  const s = String(text).trim();
  if (!s) return "";
  const sentences = splitSentences(s);
  if (sentences.length <= keepMax) return s;
  return joinSentences(sentences.slice(0, keepMax)).trim();
}

/**
 * headline 超长时优先在分隔符处断开，其次按词边界断开；保证不超过 maxChars。
 */
export function fitHeadline(text, maxChars) {
  const s = String(text).trim();
  if (s.length <= maxChars) return s;
  const seps = ["；", ";", " | ", "—", " - "];
  let cut = -1;
  for (const sep of seps) {
    const i = s.indexOf(sep);
    if (i > 0 && i <= maxChars && (cut === -1 || i < cut)) cut = i;
  }
  if (cut >= Math.max(20, Math.floor(maxChars * 0.3))) return s.slice(0, cut).trim();
  const head = s.slice(0, maxChars);
  const sp = head.lastIndexOf(" ");
  return (sp >= Math.floor(maxChars * 0.6) ? head.slice(0, sp) : head).trim();
}

/**
 * 把过长文本截断到 maxChars 内，尽量保留完整句子（句界优先），并保证句数落在 [keepMin, keepMax]。
 * 用于强制模型无法稳定遵守的硬性长度上限：宁可截短，也不因超长整段失败。
 */
export function fitText(text, maxChars, keepMin, keepMax) {
  const s = String(text).trim();
  if (!s) return "";
  if (s.length <= maxChars && countSentences(s) <= keepMax) return s;
  let sentences = splitSentences(s);
  if (sentences.length === 0) return s.slice(0, maxChars).trim();
  if (sentences.length > keepMax) sentences = sentences.slice(0, keepMax);
  const kept = [];
  for (const sent of sentences) {
    const trial = joinSentences([...kept, sent]);
    if (kept.length > 0 && trial.length > maxChars) break;
    kept.push(sent);
  }
  const needMin = Math.min(keepMin, sentences.length);
  const chosen = kept.length < needMin ? sentences.slice(0, needMin) : kept;
  const joined = joinSentences(chosen);
  return (joined.length > maxChars ? joined.slice(0, maxChars) : joined).trim();
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
    const headline = fitHeadline(String(sec.headline ?? "").trim(), HEADLINE_MAX_CHARS);
    const summaryRaw = String(sec.summary ?? "").trim();
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
      const text = fitSentences(String(note.summary ?? "").trim(), RELEASE_NOTE_MAX_SENTENCES);
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

/** 按 shape 从响应 JSON 中取回文本。 */
function extractContent(json, shape) {
  if (shape === "responses") {
    if (typeof json.output_text === "string" && json.output_text.trim()) {
      return json.output_text;
    }
    const parts = [];
    for (const item of Array.isArray(json.output) ? json.output : []) {
      for (const c of Array.isArray(item?.content) ? item.content : []) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
    return parts.join("");
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  }
  return "";
}

// ---------------------------------------------------------------- 单 provider 尝试

/**
 * 对一个 provider 完整尝试（含内部重试）：
 *   · chat 形态默认带 response_format JSON 模式；带 rf 收到 400 → 去掉 rf 重试一次，
 *     并在进程内记住该 provider 不支持（后续调用直接跳过），绝不因此放弃该 provider
 *   · 429/5xx → 等 ~2s 重试一次 → 仍失败换下一家
 *   · SenseNova chat 404/405 → 同 provider 换 responses 形态再试一次
 *   · JSON 提取/校验失败 → 逐次加严提醒，最多追加 3 次（共 4 次尝试）→ 换下一家
 *   · 截断（finish_reason=length）或空输出（200 但 content 为空，reasoning 吃光预算）
 *     → 打印 usage/reasoning 诊断并翻倍 max_tokens 重试（上限 65536）
 *   · chat 默认发 reasoning_effort=none 关闭思考（避免 CoT 吃光 max_tokens 导致 content 为空）；400 时去掉重试。
 *     取值可由 provider.reasoningEffort 覆盖 —— minimax 不认 "none"（400），而整个去掉参数
 *     它又会无约束地思考到超时，所以它单独配 "low"
 *   · provider.headers（可选）原样追加进请求头（OpenCode Go 的 user-agent / 会话 id 走这里）
 *   · provider.extraBody（可选）合并进 chat 请求体（sensenova 的 thinking:{type:"disabled"} 走这里）
 *   · provider.responseFormat === false → 从不发 json_object（默认发）
 *   · deadline（可选，epoch ms）→ lane 总预算：每次发请求前剩余 ≤ MIN_ATTEMPT_MS 就立刻放弃，
 *     否则 timeout = min(CHAT_TIMEOUT_MS, 剩余)。**这是本函数唯一为 lane 预算加的分支**
 *     ——重试 / 纠正 / 截断翻倍 / JSON 模式退让 / 形态切换一律不动。
 *
 * `validate(parsed)` 是同步校验器，返回 { ok:true, value } 或 { ok:false, reason }；
 * `feedback(reason, n)` 按失败原因生成可执行的纠正提示（默认 buildRetryFeedback，日报专用）。
 */
async function attemptProvider(provider, system, user, validate, feedback = buildRetryFeedback, deadline = Infinity) {
  const base = String(provider.baseUrl || "").replace(/\/+$/, "");
  const providerKey = `${provider.name}\u0000${base}`;
  let shape = provider.shape === "responses" ? "responses" : "chat";
  let prompt = user;
  let retriedStatus = false; // 429/5xx 已重试过
  let corrections = 0; // 已因 JSON/校验失败追加纠正提示的次数（最多 MAX_CORRECTIONS 次）
  let triedResponses = false; // SenseNova 404/405 → responses 已切换过
  let reasoningOff = true; // chat 形态默认发 reasoning_effort=none 关思考；400 时去掉重试
  // 实测（2026-10-22，真实日报 prompt，deepseek-v4.1-flash）：none → reasoning_tokens=0 / 8.5s；
  // low → 1077 / 17.1s；整个不带参数 → 2799 / 24.0s。所以 "none" 对它是真关掉的，不是被忽略。
  let maxTokens = MAX_TOKENS; // 截断时自适应翻倍（上限 MAX_TOKENS_CAP）

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    // lane 预算：剩余 ≤ 1s 就不再发请求（否则一定在预算外拖一个必败的往返）
    const remaining = deadline - Date.now();
    if (remaining <= MIN_ATTEMPT_MS) {
      return { ok: false, reason: "lane 预算耗尽" };
    }
    const timeoutMs = Number.isFinite(deadline) ? Math.min(CHAT_TIMEOUT_MS, remaining) : CHAT_TIMEOUT_MS;
    const url = `${base}/${shape === "responses" ? "responses" : "chat/completions"}`;
    // chat 形态请求 JSON 模式；已知该 provider 不支持（或配置写死 responseFormat:false）则跳过
    const useJsonMode =
      shape === "chat" && provider.responseFormat !== false && !jsonModeUnsupported.has(providerKey);
    const body =
      shape === "responses"
        ? {
            model: provider.model,
            input: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            max_output_tokens: maxTokens,
          }
        : {
            model: provider.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            temperature: 0.3,
            max_tokens: maxTokens,
            ...(reasoningOff ? { reasoning_effort: provider.reasoningEffort || "none" } : {}),
            ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
            // provider 自定义请求体片段（sensenova 的 thinking:{type:"disabled"} 走这里）；
            // 只作用于 chat 形态，responses 形态不带（那边的参数名不同）
            ...(provider.extraBody && typeof provider.extraBody === "object" ? provider.extraBody : {}),
          };

    let res;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${provider.apiKey}`,
            // provider 自定义头（OpenCode Go 要求自报 user-agent + 稳定会话 id）
            ...(provider.headers && typeof provider.headers === "object" ? provider.headers : {}),
          },
          body: JSON.stringify(body),
        },
        timeoutMs
      );
    } catch (err) {
      return { ok: false, reason: `网络异常 ${err && err.message}` };
    }

    // 429 / 5xx：等 ~2s 重试一次，再失败就换下一家
    if (res.status === 429 || res.status >= 500) {
      if (!retriedStatus) {
        retriedStatus = true;
        console.error(
          `${LOG} ${provider.name}: HTTP ${res.status}，${RETRY_WAIT_MS}ms 后重试一次`
        );
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      return { ok: false, reason: `HTTP ${res.status}（已重试仍失败）` };
    }

    // SenseNova chat 形态 404/405：同一 provider 换 /responses 形态再试一次。
    // 按 endpoint 判断（不按 name）：name 是可随便改的稳定 slug，线上历史数据与测试都依赖它不变。
    if (
      (res.status === 404 || res.status === 405) &&
      provider.endpoint === "sensenova" &&
      shape === "chat" &&
      !triedResponses
    ) {
      triedResponses = true;
      shape = "responses";
      console.error(
        `${LOG} ${provider.name}: chat 形态 HTTP ${res.status}，改用 responses 形态重试`
      );
      continue;
    }

    // 400：先去掉可能不被支持的 reasoning_effort，再退让 response_format（都不放弃 provider）
    if (res.status === 400 && shape === "chat" && reasoningOff) {
      reasoningOff = false;
      console.error(`${LOG} ${provider.name}: HTTP 400 且请求带了 reasoning_effort，去掉后重试`);
      continue;
    }
    // 带 response_format 收到 400：去掉 JSON 模式重试一次，并进程内记住该 provider 不支持（不放弃该 provider）
    if (res.status === 400 && useJsonMode) {
      jsonModeUnsupported.add(providerKey);
      console.error(
        `${LOG} ${provider.name}: HTTP 400 且请求带了 response_format，改为不带 JSON 模式重试（该 provider 进程内不再发送）`
      );
      continue;
    }

    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, reason: `HTTP ${res.status} ${snippet}` };
    }

    const json = await res.json().catch(() => null);
    if (!json) return { ok: false, reason: "响应体不是 JSON" };

    const content = extractContent(json, shape);
    // 截断检测：chat 看 finish_reason=length；responses 看 incomplete_details / status=incomplete
    const truncated =
      (shape === "chat" && json?.choices?.[0]?.finish_reason === "length") ||
      (shape === "responses" &&
        (json?.incomplete_details != null || json?.status === "incomplete"));
    // 空输出检测：OpenCode Go 上的模型即使发 reasoning_effort=none 也计 reasoning tokens，
    // max_tokens 被思考吃光时会回 200 + content 为空 + finish_reason=stop —— 截断那支逮不到，
    // 只会被当成「提取不到 JSON」空转 4 轮纠正再换下一家。这类纯预算问题与截断同法处理。
    const emptyContent = content.trim() === "";
    let checked;
    if (truncated || emptyContent) {
      const finish = json?.choices?.[0]?.finish_reason ?? json?.status ?? "?";
      const usage = json?.usage ? JSON.stringify(json.usage) : "n/a";
      const reasoningLen =
        typeof (json?.choices?.[0]?.message?.reasoning ?? json?.choices?.[0]?.message?.reasoning_content) === "string"
          ? String(json?.choices?.[0]?.message?.reasoning ?? json?.choices?.[0]?.message?.reasoning_content).length
          : 0;
      console.error(
        `${LOG} ${provider.name}: ${truncated ? "输出被截断" : "输出为空"}（finish_reason=${finish}, content_len=${content.length}, reasoning_len=${reasoningLen}, max_tokens=${maxTokens}, usage=${usage}）`
      );
      // CoT 吃光 max_tokens 时 content 为空：先尝试抬高预算，到顶仍不行才算失败
      if (maxTokens < MAX_TOKENS_CAP) {
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CAP);
        console.error(`${LOG} ${provider.name}: 提高 max_tokens 至 ${maxTokens} 后重试`);
        continue;
      }
      checked = {
        ok: false,
        reason: truncated ? "输出被 max_tokens 截断" : "输出为空（reasoning 可能吃光 max_tokens）",
      };
    } else {
      const parsed = parseJsonPayload(content);
      checked = parsed
        ? validate(parsed)
        : { ok: false, reason: "无法从返回文本中提取 JSON" };
    }
    if (checked.ok) return { ok: true, value: checked.value };

    // 失败时打印原始返回片段，便于事后诊断（prose / 截断 / 结构不符）
    console.error(
      `${LOG} ${provider.name}: 返回不合约束（${checked.reason}），原始返回前 400 字: ${String(content).slice(0, 400)}`
    );

    if (corrections < MAX_CORRECTIONS) {
      const hint = feedback(checked.reason, corrections);
      corrections += 1;
      prompt = `${user}\n\n${hint}`;
      console.error(
        `${LOG} ${provider.name}: 返回不合约束（${checked.reason}），追加纠正提示后重试（第 ${corrections + 1}/${
          MAX_CORRECTIONS + 1
        } 次）`
      );
      continue;
    }
    return { ok: false, reason: `返回不合约束（${checked.reason}）` };
  }
  return { ok: false, reason: `超过内部重试上限 ${MAX_ROUNDS} 次` };
}

/** 规范化 provider：补 shape；无效则返回 null（并记日志）。模型一律由 provider 自身写死，不再动态解析。 */
function normalizeProvider(raw) {
  if (!raw || typeof raw !== "object") {
    console.error(`${LOG} 跳过无效 provider 条目`);
    return null;
  }
  const provider = { ...raw, shape: raw.shape === "responses" ? "responses" : "chat" };
  const name = provider.name || "?";
  if (!provider.baseUrl || !provider.apiKey) {
    console.error(`${LOG} ${name}: 缺 baseUrl/apiKey，跳过`);
    return null;
  }
  if (!provider.model) {
    console.error(`${LOG} ${name}: 缺 model，跳过`);
    return null;
  }
  return provider;
}

// ---------------------------------------------------------------- 主入口

/**
 * 通用结构化生成入口：按顺序尝试 providers。
 *   成功 → { value, provider, model, attempts }
 *   没有可用 provider / 全部 provider 失败 → null（attempts 只在成功时随返回值给出；
 *   需要在失败时拿到逐条原因就传 onProviderFailure）
 *
 * `validate(parsed)`（同步）决定「这份 JSON 能不能收」，`feedback(reason, n)`（可选）
 * 给出针对性的纠正提示；日报的 generateNarrative 与 30 天总结都走这里，
 * 重试/JSON 模式/截断/退让行为完全一致。
 *
 * `onProviderFailure({ provider, model, reason })`（可选）：每有一条 provider 失败就回调一次 —
 * 调用方（日报 / 总结编排）据此收集 attempts，写失败记录并开常驻 issue。
 *
 * `budgetMs`（可选）：**整条 lane 的总预算**（来自 `config/providers.json` 的 `lanes.<lane>.budgetMs`）。
 * 入口算 deadline，交给 attemptProvider 收敛每条腿的单次超时；预算在腿之间耗尽时，
 * 对**剩余每条腿各补一条合成 attempt**（reason=「未尝试（超出 lane 预算 N 分钟）」）并照常回调
 * onProviderFailure —— 于是自然落进现有的失败记录 + 常驻 issue + 页面失败卡，**绝不静默截断**。
 * 不传 = 不设预算（总结线现状：deepseek 实测 51.8–83.0s + sensenova 兜底）。
 */
export async function generateStructured({
  system,
  user,
  validate,
  providers,
  feedback,
  onProviderFailure,
  budgetMs,
} = {}) {
  const list = Array.isArray(providers) ? providers : [];
  if (list.length === 0) {
    console.error(`${LOG} 没有可用 provider（未配置 API key）`);
    return null;
  }
  if (typeof validate !== "function") {
    console.error(`${LOG} 缺少 validate 校验器`);
    return null;
  }

  const hasBudget = Number.isFinite(budgetMs) && budgetMs > 0;
  const deadline = hasBudget ? Date.now() + budgetMs : Infinity;
  const budgetLabel = hasBudget
    ? budgetMs >= 60000
      ? `${Math.round(budgetMs / 60000)} 分钟`
      : `${Math.round(budgetMs / 1000)} 秒`
    : "";
  const budgetReason = `未尝试（超出 lane 预算 ${budgetLabel}）`;

  const notifyFailure = (failed) => {
    if (typeof onProviderFailure !== "function") return;
    try {
      onProviderFailure(failed);
    } catch (err) {
      // 回调是调用方的可见性旁路，它的异常不该影响生成流程
      console.error(`${LOG} onProviderFailure 回调异常: ${err && err.message ? err.message : String(err)}`);
    }
  };

  // 先规范化整条链，预算耗尽时才能对「剩余每条腿」都补出 provider/model 正确的合成 attempt
  const normalized = [];
  for (const raw of list) {
    const provider = await normalizeProvider(raw);
    if (provider) normalized.push(provider);
  }
  if (normalized.length === 0) {
    console.error(`${LOG} 没有可用 provider（条目都不完整）`);
    return null;
  }

  const attempts = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const provider = normalized[i];
    // 预算在腿之间耗尽：剩下的腿全部记成「未尝试」，不留「这条腿没提过」的黑洞
    if (deadline - Date.now() <= MIN_ATTEMPT_MS) {
      for (const skipped of normalized.slice(i)) {
        const failed = { provider: skipped.name, model: skipped.model, reason: budgetReason };
        console.error(`${LOG} ${skipped.name}: 跳过 — ${budgetReason}`);
        attempts.push(failed);
        notifyFailure(failed);
      }
      break;
    }
    console.error(`${LOG} ${provider.name}: 尝试（shape=${provider.shape}, model=${provider.model}）`);
    const outcome = await attemptProvider(provider, system, user, validate, feedback, deadline);
    if (outcome.ok) {
      console.error(`${LOG} ${provider.name}: 成功`);
      return { value: outcome.value, provider: provider.name, model: provider.model, attempts };
    }
    console.error(`${LOG} ${provider.name}: 失败 — ${outcome.reason}`);
    const failed = { provider: provider.name, model: provider.model, reason: outcome.reason };
    attempts.push(failed);
    notifyFailure(failed);
  }

  console.error(`${LOG} 所有 provider 均失败`);
  return null;
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
