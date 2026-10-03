#!/usr/bin/env node
/**
 * scripts/daily/lib/ai.mjs
 * ------------------------------------------------------------------
 * 每日报告 AI 叙事生成（零依赖 ESM，Node 20+ 内置 fetch）。
 *
 * 数据流：
 *   data（每日数据 schema，见下）→ 压缩成紧凑 prompt（只喂聚合条目，不喂原始事件）
 *   → 按顺序尝试 providers（chat / responses 两种形态）→ 一次调用产出严格 JSON（en + zh 双语）
 *   → 提取 / 解析 / 校验（不合格追加“只输出 JSON”后重试一次）→ { en, zh, provider }
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
 *     replies:       [ { repo, number, title, url, author, excerpt, kind, ts, own } ]
 *   }
 *
 * 导出：
 *   generateNarrative({ data, providers })   // data.empty === true → 直接 null，不打 API
 *   defaultProviders(env = process.env)      // 同步返回 provider 列表（没 key 的跳过）
 *   resolveSenseNovaModel(apiKey, baseUrl?)  // GET {baseUrl}/models 挑模型，进程内缓存
 *
 * provider 结构：{ name, baseUrl, apiKey, model, shape }
 *   shape = "chat"      → POST {baseUrl}/chat/completions
 *   shape = "responses" → POST {baseUrl}/responses
 *
 * 用法：node scripts/daily/lib/ai.mjs --data=path.json
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- 常量

const LOG = "[daily-report]";
const SENSENOVA_BASE = "https://token.sensenova.cn/v1";
const SECTION_CAP = 30; // 每个板块最多喂 30 条
const COMMIT_MSG_CAP = 10; // 每个仓库最多喂 10 条 commit message
const COMMIT_MSG_LEN = 200; // 每条 commit message 截断到 200 字符
const RELEASE_NOTES_CAP = 800; // 每条 release notes 最多 800 字符
const MAX_TOKENS = 4096; // chat max_tokens / responses max_output_tokens 共用（中英双摘要 + JSON 结构，2000 会被截断导致解析失败）
const SUMMARY_MIN_SENTENCES = 2; // 提示词目标 4-8 句；校验放宽容差，避免把「9 句」这种好结果误拒
const SUMMARY_MAX_SENTENCES = 12;
const SUMMARY_MAX_CHARS = 1400; // summary 目标 ~900 字符，校验放宽留余量（模型常写到 ~1000+，避免误拒）
const RELEASE_NOTE_MAX_SENTENCES = 3;
const RETRY_WAIT_MS = 2000; // 429/5xx 重试前等待 ~2s
const MAX_ROUNDS = 8; // 单 provider 内部循环安全上限（json 重试×2 + rf-400 退让 + 429 重试 + 形态切换）

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- SenseNova 模型解析

// baseUrl → 已解析 model；只缓存成功结果（失败不缓存，允许下次重试）
const senseNovaModelCache = new Map();

// 进程内记住不支持 response_format 的 provider（key: name+baseUrl），后续调用直接跳过
const jsonModeUnsupported = new Set();

// JSON 提取失败时逐次加严的提醒（第 1 次请求不带提醒，之后最多追加 2 次 → 共 3 次尝试）
const JSON_REMINDERS = [
  "Return ONLY valid JSON, no prose, no markdown fences.",
  "Output must start with { and end with }. No other text.",
];

/**
 * GET {baseUrl}/models，按优先级挑模型：
 *   /6\.8.*flash.*lite/i → /flash.*lite/i → /flash/i → 第一个 id
 * 解析失败返回 null。
 */
export async function resolveSenseNovaModel(apiKey, baseUrl = SENSENOVA_BASE) {
  const base = String(baseUrl || SENSENOVA_BASE).replace(/\/+$/, "");
  if (senseNovaModelCache.has(base)) return senseNovaModelCache.get(base);

  try {
    const res = await fetch(`${base}/models`, {
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.error(`${LOG} sensenova: GET /models 失败 HTTP ${res.status}`);
      return null;
    }
    const json = await res.json().catch(() => null);
    // 兼容 data: [ { id } ] 与 models: [ "id" ] 两种返回形态
    const raw = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.models)
        ? json.models
        : [];
    const ids = raw
      .map((m) => (typeof m === "string" ? m : m && m.id))
      .filter((id) => typeof id === "string" && id.length > 0);
    if (ids.length === 0) {
      console.error(`${LOG} sensenova: /models 未返回任何模型 id`);
      return null;
    }
    const pick = (re) => ids.find((id) => re.test(id));
    const model =
      pick(/6\.8.*flash.*lite/i) || pick(/flash.*lite/i) || pick(/flash/i) || ids[0];
    console.error(`${LOG} sensenova: 已解析模型 ${model}`);
    senseNovaModelCache.set(base, model);
    return model;
  } catch (err) {
    console.error(`${LOG} sensenova: GET /models 异常 ${err && err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- provider 列表

/** 按优先级返回可用 provider；没有 key 的直接跳过。SenseNova 的 model 留空，由 generateNarrative 惰性解析。 */
export function defaultProviders(env = process.env) {
  const list = [];

  // 商汤 SenseNova（首选：Zen 免费层只能在 OpenCode 应用内使用，CI 里必然失败）
  if (env.SENSENOVA_API_KEY) {
    list.push({
      name: "sensenova",
      baseUrl: SENSENOVA_BASE,
      apiKey: env.SENSENOVA_API_KEY,
      model: env.SENSENOVA_MODEL || "", // 空 → generateNarrative 内调 resolveSenseNovaModel
      shape: "chat",
    });
  }

  // Zen（OpenCode，垫底可选回退：仅当用户将来有付费 Zen credit 才可能可用）
  if (env.OPENCODE_API_KEY) {
    list.push({
      name: "zen",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: env.OPENCODE_API_KEY,
      model: env.OPENCODE_MODEL || "mimo-v2.6-flash-free",
      shape: "chat",
    });
  }

  return list;
}

// ---------------------------------------------------------------- prompt 构建

const SYSTEM_PROMPT = [
  "You write a neutral, factual daily GitHub activity report.",
  "Reply with ONE strict JSON object only: no prose, no markdown, no code fences.",
  'Schema: {"en":{"headline":"...","summary":"...","releaseNotes":[{"repo":"...","tag":"...","summary":"..."}]},"zh":{...same shape...}}',
  "Rules:",
  "- headline: at most 80 characters.",
  "- summary: 4-8 sentences, at most about 900 characters. Name concrete specifics from the input — repository names, issue/PR numbers and titles, who replied, what a release changed — and describe what actually happened that day, in order. No filler, no repeating the headline, no generic 'a busy day'.",
  "- releaseNotes: one entry ONLY for each release in the input, matching repo+tag exactly; each summary at most 3 sentences; use [] when there are no releases.",
  "- Commits: for the user's OWN commits (commits[].messages), summarize what they actually changed by synthesizing their commit messages — group and shorten them; do NOT list the messages verbatim.",
  "- Commits: `count` is the user's OWN commit count; `automated` is a SEPARATE, ADDITIONAL count of bot/automated commits — never a subset of `count`. Phrase them as additive, e.g. \"8 own commits plus 1 automated commit by github-actions[bot]\" / \"8 次本人提交，另有 1 次由 github-actions[bot] 自动提交\" — never \"8 commits, of which 1 was automated\" / \"8 次提交，其中 1 次为自动提交\" (never \"其中\"/\"of which\" overlap).",
  "- If automatedCommits is non-zero (or a commit entry has automated > 0), mention only the automated commit count and who created them (the automatedBots logins), e.g. \"2 automated commits by github-actions[bot]\"; never describe the automated commits' contents.",
  "- Grand totals: use the numbers in `totals` (`commits` / `prs` / `issues` / `reviews`) VERBATIM for any overall count — never recompute, round, adjust, or derive them from detail lists; if `totals.commits` is 22, write 22, never \"20\". Per-repo commit numbers come from `commits[].count` (the user's own) plus `commits[].automated` (bot, additive); do NOT sum across repos to produce a different grand total.",
  "- Issues: the issues total covers items you opened, closed, or commented on. Summarize it as \"opened or closed N issues\" (新开或关闭 N 个 issue) — never \"opened and closed\" / \"新开并关闭\", and never imply that all of them were closed. When the per-item actions are known, describe what actually happened (e.g. \"opened 3 issues, one of which was later closed\").",
  "- en and zh must state exactly the same facts.",
  "- zh must be natural Simplified Chinese, not a literal machine translation.",
  "- Neutral and factual: no hype, no speculation, no invented facts; keep repo names, numbers and tags verbatim from the input.",
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
  };
  const user =
    `Write the daily report for ${data.date} as ONE strict JSON object.\n` +
    `Input:\n${JSON.stringify(payload)}`;
  return { system: SYSTEM_PROMPT, user };
}

// ---------------------------------------------------------------- 解析与校验

/**
 * 从返回文本里稳提取 JSON：剥 ```json 围栏 → 首个 `{` 到末个 `}` → JSON.parse。
 * 失败返回 null。
 */
function parseJsonPayload(text) {
  let t = String(text ?? "").trim();
  if (!t) return null;
  t = t.replace(/```(?:json)?/gi, "").trim(); // 剥围栏
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  const candidates = [];
  if (first !== -1 && last > first) candidates.push(t.slice(first, last + 1));
  candidates.push(t); // 兜底：整段直接就是 JSON
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

/** 粗算句数：中文句号/叹号/问号直接计数（中文句间通常无空格）；英文句末标点需后接空白或结尾，避免小数点、缩写点误判。 */
function countSentences(text) {
  const s = String(text).trim();
  if (!s) return 0;
  const cjk = (s.match(/[。！？]/g) || []).length;
  const latin = (s.match(/[.!?]+(?=\s|$)/g) || []).length;
  let n = cjk + latin;
  if (!/[.!?。！？]\s*$/.test(s)) n += 1; // 末尾没有句号的残句也计入
  return n;
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

    const headline = String(sec.headline ?? "").trim();
    const summary = String(sec.summary ?? "").trim();
    if (!headline) return { ok: false, reason: `${lang}.headline 为空` };
    if (headline.length > 80) {
      return { ok: false, reason: `${lang}.headline 超长 ${headline.length} > 80` };
    }
    if (!summary) return { ok: false, reason: `${lang}.summary 为空` };
    const sentences = countSentences(summary);
    if (sentences < SUMMARY_MIN_SENTENCES || sentences > SUMMARY_MAX_SENTENCES) {
      return {
        ok: false,
        reason: `${lang}.summary 句数 ${sentences} 不在 ${SUMMARY_MIN_SENTENCES}-${SUMMARY_MAX_SENTENCES}`,
      };
    }
    if (summary.length > SUMMARY_MAX_CHARS) {
      return {
        ok: false,
        reason: `${lang}.summary 超长 ${summary.length} > ${SUMMARY_MAX_CHARS} 字符`,
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
      const text = String(note.summary ?? "").trim();
      if (!releaseKeys.has(`${repo}@@${tag}`)) {
        return { ok: false, reason: `${lang}.releaseNotes 出现输入之外的 release: ${repo}@${tag}` };
      }
      if (!text) {
        return { ok: false, reason: `${lang}.releaseNotes ${repo}@${tag} summary 为空` };
      }
      const noteSentences = countSentences(text);
      if (noteSentences > RELEASE_NOTE_MAX_SENTENCES) {
        return {
          ok: false,
          reason: `${lang}.releaseNotes ${repo}@${tag} 句数 ${noteSentences} > ${RELEASE_NOTE_MAX_SENTENCES}`,
        };
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
 *   · JSON 提取/校验失败 → 逐次加严提醒，最多追加 2 次（共 3 次尝试）→ 换下一家
 */
async function attemptProvider(provider, system, user, data) {
  const base = String(provider.baseUrl || "").replace(/\/+$/, "");
  const providerKey = `${provider.name}\u0000${base}`;
  let shape = provider.shape === "responses" ? "responses" : "chat";
  let prompt = user;
  let retriedStatus = false; // 429/5xx 已重试过
  let jsonTries = 0; // 已因 JSON/校验失败追加提醒的次数（最多 JSON_REMINDERS.length 次）
  let triedResponses = false; // SenseNova 404/405 → responses 已切换过

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const url = `${base}/${shape === "responses" ? "responses" : "chat/completions"}`;
    // chat 形态请求 JSON 模式；已知该 provider 不支持则跳过
    const useJsonMode =
      shape === "chat" && !jsonModeUnsupported.has(providerKey);
    const body =
      shape === "responses"
        ? {
            model: provider.model,
            input: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            max_output_tokens: MAX_TOKENS,
          }
        : {
            model: provider.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            temperature: 0.4,
            max_tokens: MAX_TOKENS,
            ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
          };

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
      });
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

    // SenseNova chat 形态 404/405：同一 provider 换 /responses 形态再试一次
    if (
      (res.status === 404 || res.status === 405) &&
      provider.name === "sensenova" &&
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
    const parsed = parseJsonPayload(content);
    const checked = parsed
      ? validateNarrative(parsed, data)
      : { ok: false, reason: "无法从返回文本中提取 JSON" };
    if (checked.ok) return { ok: true, value: checked.value };

    if (jsonTries < JSON_REMINDERS.length) {
      const reminder = JSON_REMINDERS[jsonTries];
      jsonTries += 1;
      prompt = `${user}\n${reminder}`;
      console.error(
        `${LOG} ${provider.name}: 返回不合约束（${checked.reason}），追加提醒后重试（第 ${jsonTries + 1}/${
          JSON_REMINDERS.length + 1
        } 次）`
      );
      continue;
    }
    return { ok: false, reason: `返回不合约束（${checked.reason}）` };
  }
  return { ok: false, reason: `超过内部重试上限 ${MAX_ROUNDS} 次` };
}

/** 规范化 provider：补 shape、惰性解析 SenseNova 模型；无效则返回 null（并记日志）。 */
async function normalizeProvider(raw) {
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
  if (provider.name === "sensenova" && !provider.model) {
    const model = await resolveSenseNovaModel(provider.apiKey, provider.baseUrl);
    if (!model) {
      console.error(`${LOG} ${name}: 无法解析模型，跳过`);
      return null;
    }
    provider.model = model;
  }
  if (!provider.model) {
    console.error(`${LOG} ${name}: 缺 model，跳过`);
    return null;
  }
  return provider;
}

// ---------------------------------------------------------------- 主入口

/**
 * 生成每日叙事。成功返回 { en, zh, provider }；以下情况返回 null：
 *   data.empty === true（不打 API，省 token）／没有可用 provider／全部 provider 失败。
 */
export async function generateNarrative({ data, providers }) {
  if (data == null) {
    console.error(`${LOG} data 为空，跳过`);
    return null;
  }
  if (data.empty === true) {
    console.error(`${LOG} data.empty === true，跳过调用（省 token）`);
    return null;
  }
  const list = Array.isArray(providers) ? providers : [];
  if (list.length === 0) {
    console.error(`${LOG} 没有可用 provider（未配置 API key）`);
    return null;
  }

  const { system, user } = buildPrompts(data);

  for (const raw of list) {
    const provider = await normalizeProvider(raw);
    if (!provider) continue;
    console.error(`${LOG} ${provider.name}: 尝试（shape=${provider.shape}, model=${provider.model}）`);
    const outcome = await attemptProvider(provider, system, user, data);
    if (outcome.ok) {
      console.error(`${LOG} ${provider.name}: 成功`);
      return { en: outcome.value.en, zh: outcome.value.zh, provider: provider.name };
    }
    console.error(`${LOG} ${provider.name}: 失败 — ${outcome.reason}`);
  }

  console.error(`${LOG} 所有 provider 均失败`);
  return null;
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
