#!/usr/bin/env node
/**
 * scripts/summary/validate-summary.mjs
 * ------------------------------------------------------------------
 * 30 天 GitHub 活动总结 · AI 输出校验（零依赖 ESM，同步函数）。
 *
 * 口径（为什么这么写）：
 *   · ctx = { repos, items, releases, missing } 全部来自真实单日数据
 *     （collect.mjs 的 buildItemIndex + collectSummaryData().missing），
 *     AI 输出里的 repo / 编号 / tag 必须能在集合里命中，命中不了就拒收让上层纠正重试。
 *   · URL 一律由本校验器从输入数据注入（模型给什么都不采纳）—— 模型编不出链接。
 *   · 硬长度不整段拒绝：headline 走 fitHeadline、overview 超 2600 走 fitText 按句界截断
 *     （与日报 validateNarrative 同一手法）；纯文本违规 / 句数 / 段数 / 条目集合 / 评论数
 *     这些「改一次就能对」的问题才拒收。
 *   · reason 用中文、简短可执行 —— 它会打进日志并被 summaryFeedback 消费。
 *
 * 导出：
 *   validateSummary(raw, ctx) → { ok: true, value } | { ok: false, reason }
 *   ctx = { repos: Set, items: Map, releases: Map, missing: { days, dates } }
 *   value = { en: { headline, overview, highlights, byRepo }, zh: { 同} }
 *
 * 用法：validate: (parsed) => validateSummary(parsed, ctx)   // generateStructured 的同步校验器
 */

import { countSentences, fitHeadline, fitText } from "../daily/lib/ai.mjs";

// ---------------------------------------------------------------- 常量

const HEADLINE_MAX_CHARS = 80;
const OVERVIEW_MAX_CHARS = 2600;
const OVERVIEW_MIN_SENTENCES = 6; // 提示词目标 10-16 句；校验放宽容差，避免把「8 句」好结果误拒
const OVERVIEW_FIT_KEEP_MAX = 60;
const HIGHLIGHTS_MIN = 3;
const HIGHLIGHTS_MAX = 8;
const HIGHLIGHT_TEXT_MAX = 400;
const BY_REPO_MAX = 8;
const BY_REPO_TEXT_MAX = 800;
const KINDS = new Set(["pr", "issue", "discussion", "release"]);
// 评论数禁令：中英都要逮（大小写不敏感）
const COMMENT_COUNT_RE = /\d+\s*条评论|\d+\s*comments?\b/i;
// headline 纯文本违规字符：只拦「markdown 内联标记」这一类的两种（反引号/星号）。
// 井号、方括号在 HTML 里是普通字符（渲染层会 esc、不做 markdown 解析），放行以免
// 让「issue #42」这种正当措辞把好结果误拒成重试循环。
const HEADLINE_BAD_CHARS = { "`": "反引号", "*": "星号" };

// ---------------------------------------------------------------- 小工具

/** 空行分段（去掉空白段）。 */
function countParagraphs(text) {
  return String(text)
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .length;
}

/** 在文本里找第一个评论数表述，返回匹配串或 null。 */
function findCommentCount(text) {
  const m = String(text).match(COMMENT_COUNT_RE);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------- 校验

/**
 * 同步校验 + 规范化 AI 输出：
 *   通过 → { ok: true, value: { en, zh } }（截断与 URL 注入都已应用）
 *   失败 → { ok: false, reason }（中文、可执行，交 summaryFeedback 生成纠正提示）
 */
export function validateSummary(raw, ctx) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "根节点不是 JSON 对象" };
  }
  const repos = ctx?.repos instanceof Set ? ctx.repos : new Set();
  const items = ctx?.items instanceof Map ? ctx.items : new Map();
  const releases = ctx?.releases instanceof Map ? ctx.releases : new Map();
  const missingDays = Number(ctx?.missing?.days) || 0;

  const value = {};
  for (const lang of ["en", "zh"]) {
    const sec = raw[lang];
    if (!sec || typeof sec !== "object" || Array.isArray(sec)) {
      return { ok: false, reason: `缺少 ${lang} 段` };
    }

    // --- headline：非空 → 纯文本拒收（先于截断）→ fitHeadline 截断
    const headlineRaw = String(sec.headline ?? "").trim();
    if (!headlineRaw) return { ok: false, reason: `${lang}.headline 为空` };
    const badChar = headlineRaw.split("").find((ch) => HEADLINE_BAD_CHARS[ch]);
    if (badChar) {
      return {
        ok: false,
        reason: `${lang}.headline 含${HEADLINE_BAD_CHARS[badChar]}，必须纯文本`,
      };
    }
    const headline = fitHeadline(headlineRaw, HEADLINE_MAX_CHARS);

    // --- overview：非空 → 句数 → 空行分段 → 评论数禁令（看原文，不看截断后）→ 超长按句界截断
    const overviewRaw = String(sec.overview ?? "").trim();
    if (!overviewRaw) return { ok: false, reason: `${lang}.overview 为空` };
    const sentences = countSentences(overviewRaw);
    if (sentences < OVERVIEW_MIN_SENTENCES) {
      return { ok: false, reason: `${lang}.overview 句数不足（${sentences} < ${OVERVIEW_MIN_SENTENCES}）` };
    }
    const paragraphs = countParagraphs(overviewRaw);
    if (paragraphs < 2) {
      return { ok: false, reason: `${lang}.overview 必须用空行分成 2–3 段（当前 ${paragraphs} 段）` };
    }
    const badOverview = findCommentCount(overviewRaw);
    if (badOverview) {
      return { ok: false, reason: `不许提评论数: ${lang}.overview 出现 "${badOverview}"` };
    }
    const overview =
      overviewRaw.length > OVERVIEW_MAX_CHARS
        ? fitText(overviewRaw, OVERVIEW_MAX_CHARS, OVERVIEW_MIN_SENTENCES, OVERVIEW_FIT_KEEP_MAX)
        : overviewRaw;

    // --- highlights：数组 → 条数 → 逐条集合校验（URL 由校验器注入）
    const highlightsRaw = sec.highlights;
    if (!Array.isArray(highlightsRaw)) {
      return { ok: false, reason: `${lang}.highlights 不是数组` };
    }
    if (highlightsRaw.length < HIGHLIGHTS_MIN) {
      return { ok: false, reason: `${lang}.highlights 至少 ${HIGHLIGHTS_MIN} 条（当前 ${highlightsRaw.length} 条）` };
    }
    const highlights = [];
    for (let i = 0; i < Math.min(highlightsRaw.length, HIGHLIGHTS_MAX); i += 1) {
      const h = highlightsRaw[i];
      const at = `${lang}.highlights[${i}]`;
      if (!h || typeof h !== "object" || Array.isArray(h)) {
        return { ok: false, reason: `${at} 不是对象` };
      }
      const repo = String(h.repo ?? "").trim();
      const kind = String(h.kind ?? "").trim();
      const textRaw = String(h.text ?? "").trim();
      if (!repo) return { ok: false, reason: `${at}.repo 为空` };
      if (!repos.has(repo)) {
        return { ok: false, reason: `highlights 出现输入之外的条目: ${repo}` };
      }
      if (!KINDS.has(kind)) {
        return { ok: false, reason: `${at}.kind 非法: ${kind || "(空)"}` };
      }
      if (!textRaw) return { ok: false, reason: `${at}.text 为空` };
      const badText = findCommentCount(textRaw);
      if (badText) {
        return { ok: false, reason: `不许提评论数: ${at}.text 出现 "${badText}"` };
      }
      const text = textRaw.slice(0, HIGHLIGHT_TEXT_MAX);

      if (kind === "release") {
        const tag = h.tag === undefined || h.tag === null ? "" : String(h.tag).trim();
        let match = null;
        if (tag) {
          match = releases.get(`${repo}@@${tag}`) || null;
          if (!match) {
            return { ok: false, reason: `highlights 出现输入之外的 release: ${repo}@${tag}` };
          }
        } else {
          for (const rel of releases.values()) {
            if (rel.repo === repo) {
              match = rel;
              break;
            }
          }
          if (!match) {
            return { ok: false, reason: `highlights 出现输入之外的 release: ${repo}` };
          }
        }
        const entry = { repo, kind, text, url: String(match.url ?? "") };
        if (tag) entry.tag = match.tag;
        highlights.push(entry);
        continue;
      }

      // pr / issue / discussion：编号必须是正整数且真实存在于该仓库
      const number = h.number;
      if (!Number.isInteger(number) || number <= 0) {
        return { ok: false, reason: `${at}.number 必须是正整数: ${JSON.stringify(number ?? null)}` };
      }
      const item = items.get(`${repo}#${number}`);
      if (!item) {
        return { ok: false, reason: `highlights 出现输入之外的条目: ${repo}#${number}` };
      }
      highlights.push({ repo, number, kind, text, url: String(item.url ?? "") });
    }

    // --- byRepo：数组 → 逐条集合校验 → 截断
    const byRepoRaw = sec.byRepo;
    if (!Array.isArray(byRepoRaw)) {
      return { ok: false, reason: `${lang}.byRepo 不是数组` };
    }
    const byRepo = [];
    for (let i = 0; i < byRepoRaw.length; i += 1) {
      const b = byRepoRaw[i];
      const at = `${lang}.byRepo[${i}]`;
      if (!b || typeof b !== "object" || Array.isArray(b)) {
        return { ok: false, reason: `${at} 不是对象` };
      }
      const repo = String(b.repo ?? "").trim();
      const textRaw = String(b.text ?? "").trim();
      if (!repo) return { ok: false, reason: `${at}.repo 为空` };
      if (!repos.has(repo)) {
        return { ok: false, reason: `byRepo 出现输入之外的仓库: ${repo}` };
      }
      if (!textRaw) return { ok: false, reason: `${at}.text 为空` };
      const badText = findCommentCount(textRaw);
      if (badText) {
        return { ok: false, reason: `不许提评论数: ${at}.text 出现 "${badText}"` };
      }
      byRepo.push({ repo, text: textRaw.slice(0, BY_REPO_TEXT_MAX) });
      if (byRepo.length >= BY_REPO_MAX) break;
    }
    if (byRepo.length === 0 && repos.size > 0) {
      return { ok: false, reason: `${lang}.byRepo 为空（有活动时至少 1 条）` };
    }

    value[lang] = { headline, overview, highlights, byRepo };
  }

  // --- 缺日必须写明：en 或 zh 的 overview 里至少一处出现 missing.days 这个数字（粗判）
  if (missingDays > 0) {
    const needle = String(missingDays);
    if (!value.en.overview.includes(needle) && !value.zh.overview.includes(needle)) {
      return { ok: false, reason: `overview 未写明缺几天（missing.days=${missingDays}）` };
    }
  }

  return { ok: true, value };
}
