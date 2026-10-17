#!/usr/bin/env node
/**
 * scripts/summary/prompt.mjs
 * ------------------------------------------------------------------
 * 30 天 GitHub 活动总结 · AI 提示词与纠正反馈（零依赖 ESM）。
 *
 * 口径：确定数字条由 scripts/summary/collect.mjs 求和，AI 只叙述、不计算；
 * system prompt 里写死 JSON schema 与硬规则（措辞风格对齐 scripts/daily/lib/ai.mjs
 * 的 SYSTEM_PROMPT：逐条 `- ` 规则、句式照抄日报口径）。
 *
 * 导出：
 *   SUMMARY_SYSTEM                          —— 英文 system prompt（含 JSON schema）
 *   buildSummaryPrompts({ collected })      —— { system, user }
 *   summaryFeedback(reason, n)              —— 按校验失败原因给可执行的英文纠正提示
 *
 * 用法：const { system, user } = buildSummaryPrompts({ collected });
 *       generateStructured({ system, user, validate: (p) => validateSummary(p, ctx),
 *                            feedback: summaryFeedback, providers: defaultProviders() });
 */

// ---------------------------------------------------------------- system prompt

const SUMMARY_SCHEMA =
  '{"en":{"headline":"…","teaser":"…","overview":"…","highlights":[{"repo":"o/r","number":123,"kind":"pr|issue|discussion|release","text":"…"}],"byRepo":[{"repo":"o/r","text":"…"}]},"zh":{…same shape…}}';

export const SUMMARY_SYSTEM = [
  "You write a neutral, factual 30-day GitHub activity summary.",
  "Reply with ONE strict JSON object only: no prose, no markdown, no code fences.",
  `Schema: ${SUMMARY_SCHEMA}`,
  "Rules:",
  "- headline: one line, at most 80 characters (count them; NEVER exceed 80) and PLAIN TEXT — no backticks, no asterisks, no hashes, no square brackets.",
  "- teaser: 1-2 sentences and AT MOST 240 characters (hard limit — count them; stay well below), written for the home-page card: the short hook above the numbers. Plain and factual, no filler, no lists, no repeating the headline.",
  "- overview: 2-3 paragraphs separated by a single blank line, about 10-16 sentences, and UNDER 2600 characters (hard limit — count characters; stay well below). Neutral and factual: only describe things that really happened in the input, no hype, no speculation, no filler, no repeating the headline. Beyond the grand totals it MUST say what was mainly worked on during the window — the concrete features, fixes, releases and review work per project, synthesized from the input — never a pile of numbers: an overview that only counts is a failure.",
  "- highlights: 3-8 entries, each one concrete fact from the input. `repo` must be a repository that appears in the input; when `number` is present it must be an item number that really exists for that repo in the input; `kind` must be one of pr / issue / discussion / release. Release entries carry only `repo` (plus optional `tag`). NEVER invent URLs — you are not given any URL and must not write any.",
  "- byRepo: ONE entry for EVERY repository in `repos` (in the order given there — do not pick a subset, do not drop a repo, do not repeat one). `repo` must match the input exactly. Every entry must do BOTH: (a) state that repository's definite numbers from its `repos[]` row VERBATIM — own commits (`commits`), `automated` as a separate ADDITIONAL count of bot commits, and `prs` / `issues` / `reviews` / `releases` — never recount or recompute; and (b) explain concretely WHAT was done in that repository during the window — the features, fixes, refactors and releases, synthesized from that repo's commit messages, PR/issue titles and release notes. An entry that only lists numbers, or that could describe any repository, is a failure.",
  "- Grand totals: use the numbers in `totals` (`commits` / `prs` / `issues` / `reviews`) VERBATIM for any overall count — never recompute, round, adjust, or derive them from detail lists.",
  "- Commits: `commits[].count` is the user's OWN commit count; `commits[].automated` is a SEPARATE, ADDITIONAL count of bot/automated commits — phrase them as additive, e.g. \"12 own commits plus 35 automated commits\" / \"12 次本人提交，另有 35 次自动提交\" — never \"of which\" / \"其中\" overlap; do NOT sum commits across repos to produce a different grand total.",
  "- Missing days: if `missing.days` is greater than 0, you MUST say explicitly how many days of the window have no data and list those dates.",
  "- NEVER mention comment counts — no \"N comments\", no \"N 条评论\", no wording that quantifies comments on any item.",
  "- If `backfillLimits` is present, earlier dates were reconstructed via GitHub Search and are approximate: star counts may be unavailable and releases cover only the user's own repositories. Do not pretend the data is complete; state it honestly but briefly.",
  "- en and zh must state exactly the same facts.",
  "- zh must be natural Simplified Chinese, not a literal machine translation.",
  "- Inline formatting: inside `overview`, `teaser` and `byRepo[].text` use EXACTLY two Markdown markers and nothing else — inline code with a single backtick `like-this` for literal identifiers, and bold with double asterisks **like this** (1-3 bolded spans total, in `overview` and/or `byRepo[].text` only). The headline must be PLAIN TEXT — no backticks, no asterisks, no other markup of any kind. Do NOT use any other Markdown anywhere (no headings, no lists, no links, no italic, no tables, no code fences). Keep raw HTML out. The JSON envelope itself must stay pure JSON with no markdown.",
].join("\n");

// ---------------------------------------------------------------- prompts

/**
 * 把 collectSummaryData 的结果压成 user prompt：
 * 只喂聚合后的 aiPayload（确定数字条 + 聚合条目，无原始事件、无 comments）。
 */
export function buildSummaryPrompts({ collected } = {}) {
  const c = collected || {};
  const user =
    `Write the 30-day GitHub activity summary (${c.windowStart ?? ""}..${c.windowEnd ?? ""}, UTC+8) as ONE strict JSON object.\n` +
    `Input:\n${JSON.stringify(c.aiPayload ?? {})}`;
  return { system: SUMMARY_SYSTEM, user };
}

// ---------------------------------------------------------------- 纠正反馈

/** 未命中具体原因时的通用提醒（最多 3 条，按 n 轮换）。 */
const GENERIC_REMINDERS = [
  "Return ONLY valid JSON, no prose, no markdown fences.",
  "Output must start with { and end with }. No other text.",
  "Output the COMPLETE JSON object ending with }; do not cut it off.",
];

/**
 * 根据上一轮校验失败原因，生成可执行的纠正提示（让模型能真正改对，而不是重复同一错误）。
 * 未命中的通用失败退回「只输出 JSON」提醒数组（最多 3 条，按 n 轮换）。
 */
export function summaryFeedback(reason, n = 0) {
  const r = String(reason || "");
  if (/出现输入之外/.test(r)) {
    return "REJECTED: you referenced a repo, item number or release that is NOT in the input. Use ONLY repository names, item numbers and tags that literally appear in the input JSON; drop everything else.";
  }
  if (/评论数/.test(r)) {
    return "REJECTED: the text mentions comment counts. Remove every comment-count phrasing (no \"N comments\", no \"N 条评论\") from overview, highlights and byRepo.";
  }
  if (/teaser/.test(r)) {
    return "REJECTED: `teaser` is missing or empty. Add a home-page teaser of 1-2 sentences and at most 240 characters to both en and zh.";
  }
  if (/纯文本/.test(r) || /headline 含/.test(r)) {
    return "REJECTED: the headline must be PLAIN TEXT. Rewrite it with no backticks, no asterisks, no hashes and no square brackets, still one line and at most 80 characters.";
  }
  if (/段数|分成 2[–-]3 段/.test(r)) {
    return "REJECTED: overview must be split into 2-3 paragraphs separated by a SINGLE BLANK LINE. Insert empty lines between paragraphs and keep total length under 2600 characters.";
  }
  if (/句数/.test(r)) {
    return "REJECTED: overview has too few sentences. Rewrite it with 10-16 sentences covering totals, main repos and notable items, still under 2600 characters.";
  }
  if (/缺几天|缺失.*天|missing/.test(r)) {
    return "REJECTED: you must state explicitly how many window days have no data and list those dates (see missing.days and missing.dates in the input).";
  }
  return GENERIC_REMINDERS[Math.min(n, GENERIC_REMINDERS.length - 1)];
}
