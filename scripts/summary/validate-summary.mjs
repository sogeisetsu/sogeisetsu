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
 *   · 硬长度不整段拒绝：headline 走 fitHeadline、teaser 超长走 fitText 按句界截断
 *     （与日报 validateNarrative 同一手法）；overview 超 4200 按「空行块」整块截断
 *     （保序、至少留 2 块，见 fitOverviewByBlock）。纯文本违规 / 句数 / 段数 /
 *     markdown 标记 / 条目集合 / 评论数这些「改一次就能对」的问题才拒收
 *     （teaser 缺失也拒收 —— 首页卡片必须有短文案）。
 *   · overview 是章节式：3–6 段正文（### 小标题不计入段数），行首 `### ` 唯一放行的
 *     块级标记（渲染层切成 <h3 class="ai-h3">），其余 markdown（列表 / 链接 / 表格 /
 *     代码块 / 斜体 / 其他层级标题 / 引用）一律拒收，reason 带 "markdown" 供纠正提示命中。
 *     入库前先 normalizeOverview：`### 标题` 与正文之间缺空行（模型偶发）时补一个空行，
 *     保证段数统计与渲染层分块都拿到规范形态（不拒收、不重试）。
 *   · 段数上限不砍真实内容：highlights 固定 8 条；byRepo 的上限随 ctx.repos 放大
 *     （提示词要求「每个有活动的仓库都要有一条」，固定 8 条会把真实仓库悄悄截掉），
 *     只在 24 条硬顶上收口。缺仓库仍不拒收 —— 按约定只在提示词里要求。
 *   · 自动提交是相加项（`count` 与 `automated` 互不相交）：overview / byRepo 里出现
 *     「其中/包含 … 自动提交」「includes … automated commits」这类包含式说法就拒收，
 *     让 summaryFeedback 提示改成「本人 N 次，另有 M 次」。正则见
 *     daily/lib/ai.mjs 的 AUTOMATED_OVERLAP_RE（verify 共用同一份）。
 *   · reason 用中文、简短可执行 —— 它会打进日志并被 summaryFeedback 消费。
 *
 * 导出：
 *   validateSummary(raw, ctx) → { ok: true, value } | { ok: false, reason }
 *   ctx = { repos: Set, items: Map, releases: Map, missing: { days, dates } }
 *   value = { en: { headline, teaser, overview, highlights, byRepo }, zh: { 同} }
 *
 * 用法：validate: (parsed) => validateSummary(parsed, ctx)   // generateStructured 的同步校验器
 */

import { AUTOMATED_OVERLAP_RE, countSentences, fitHeadline, fitText } from "../daily/lib/ai.mjs";

// ---------------------------------------------------------------- 常量

const HEADLINE_MAX_CHARS = 80;
const TEASER_MAX_CHARS = 240; // 首页卡片短文案（1–2 句）；超长按句界截断，不整段拒绝
const OVERVIEW_MAX_CHARS = 4200; // 章节式 overview（3–6 段 + ### 小标题）的硬上限
const OVERVIEW_MIN_SENTENCES = 6; // 提示词目标 10-16 句；校验放宽容差，避免把「8 句」好结果误拒
const OVERVIEW_FIT_KEEP_BLOCKS = 80; // 超长时按空行块截断的块数硬顶（原句向常量 OVERVIEW_FIT_KEEP_MAX=60 作废）
const HIGHLIGHTS_MIN = 3;
const HIGHLIGHTS_MAX = 8;
const HIGHLIGHT_TEXT_MAX = 400;
const BY_REPO_MAX = 8; // 保底条数（窗口里仓库少时也不放宽，保持页面紧凑）
const BY_REPO_CEIL = 24; // 硬顶：只防模型刷长尾，不替它砍掉真实出现过的仓库
const BY_REPO_TEXT_MAX = 800;
const KINDS = new Set(["pr", "issue", "discussion", "release"]);
// 评论数禁令：中英都要逮（大小写不敏感）
const COMMENT_COUNT_RE = /\d+\s*条评论|\d+\s*comments?\b/i;
// headline 纯文本违规字符：只拦「markdown 内联标记」这一类的两种（反引号/星号）。
// 井号、方括号在 HTML 里是普通字符（渲染层会 esc、不做 markdown 解析），放行以免
// 让「issue #42」这种正当措辞把好结果误拒成重试循环。
const HEADLINE_BAD_CHARS = { "`": "反引号", "*": "星号" };
// overview 的 markdown 拒收矩阵（只管 overview；teaser / highlights / byRepo 不在此列）。
// 口径：提示词只放行三样 —— 行首 `### ` 小标题（渲染层 splitBlocks 切成 <h3 class="ai-h3">）、
// 行内 `code`、`**bold**`（aiInlineToHtml 只渲染这两种内联），其余标记一律拒收让模型改。
// 防误伤（每条都刻意收窄）：
//   · 列表 / 有序列表 / 引用 / 表格只看「行首」（行中出现不算）；表格行要求同一行首尾都是 |；
//   · 标题只拦 `# ` / `## ` / `#### `… 层级，`### ` 因 `#{4,}` 与 `#{1,2}` 都接不上而放行；
//   · 斜体用 (?<!\*)\*(?!\*) 夹住两端：`**bold**` 的四个星位全被 lookaround 挡掉，
//     词内孤立单星（不成对）也不命中；再要求开星后 / 闭星前不是空白，避免「A * B * C」
//     这类乘号写法被当成斜体。
const OVERVIEW_MD_CHECKS = [
  ["列表", /^[ \t]*[-*+][ \t]/m],
  ["有序列表", /^[ \t]*\d+[.)][ \t]/m],
  ["代码块", /```/],
  ["表格行", /^[ \t]*\|[^\n]*\|[ \t]*$/m],
  ["引用", /^[ \t]*>[ \t]/m],
  ["链接", /\]\(/],
  ["斜体", /(?<!\*)\*(?!\*)(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/],
  ["其他标题", /^[ \t]*(?:#{1,2}|#{4,})[ \t]/m],
];

// ---------------------------------------------------------------- 小工具

/**
 * 空行分块，只数「正文块」：`### ` 开头的小标题块是分节标题、不计入段数
 * （章节式 overview 允许 3–6 段正文 + 若干小标题，段数下限仍是 2）。
 */
function countBodyBlocks(text) {
  return String(text)
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("### "))
    .length;
}

/**
 * 章节式 overview 入库规范化：`### 小标题` 与紧随其后的正文之间必须空行分隔。
 *
 * 为什么要有这一道（2026-10-19 线上事故）：模型偶发不守提示词，把标题与首段
 * 挤在一起（`### 标题\n正文…`）。渲染层是按空行分块的，旧实现会把「标题＋整段
 * 正文」当成一个标题块，整段套上 <h3 class="ai-h3"> 的字号与 800 字重（小章节
 * 全部消失）。在数据层先把形态摆正，`countBodyBlocks()` / `fitOverviewByBlock()`
 * / render 的 `splitBlocks()` 就不必各自打补丁，后续任何消费者拿到的都是规范形态。
 *
 * 只补这一处：`### ` 行的下一行非空且不是另一个 `### ` 时插入一个空行。
 * 不拒收、不触发重试 —— 这是确定性兜底，不能因为模型的小毛病把好输出打成重试循环。
 */
function normalizeOverview(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    if (!line.trim().startsWith("### ")) continue;
    const next = lines[i + 1];
    if (next === undefined) continue;
    const nt = next.trim();
    if (nt && !nt.startsWith("### ")) out.push("");
  }
  return out.join("\n");
}

/** 在文本里找第一个被禁的 markdown 标记，返回「列表/链接/…」标签或 null。 */
function findOverviewMarkdown(text) {
  const s = String(text);
  for (const [label, re] of OVERVIEW_MD_CHECKS) {
    if (re.test(s)) return label;
  }
  return null;
}

/**
 * overview 超长时按「空行块」截断（不是按句）：整块保留、顺序不变，直到再加
 * 下一块会把文本顶过 maxChars 为止；至少留 2 块（与段数下限对齐，别把正文截成
 * 单块又被校验打回）。首块自己就超预算时，退回 fitText 按句截断；保底 2 块
 * 拼起来仍超预算（第二块巨大）也退回 fitText —— 硬上限 4200 优先于保块。
 * OVERVIEW_FIT_KEEP_BLOCKS 是块数硬顶，防模型刷长尾小块绕过字符预算。
 */
function fitOverviewByBlock(text, maxChars) {
  const blocks = String(text)
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!blocks.length) return "";
  const fallback = () => fitText(text, maxChars, OVERVIEW_MIN_SENTENCES, OVERVIEW_FIT_KEEP_BLOCKS);
  if (blocks[0].length > maxChars) return fallback();
  const kept = [];
  let len = 0;
  for (const b of blocks) {
    if (kept.length >= OVERVIEW_FIT_KEEP_BLOCKS) break;
    const add = b.length + (kept.length ? 2 : 0); // 块间的空行分隔符
    if (kept.length >= 2 && len + add > maxChars) break;
    kept.push(b);
    len += add;
  }
  const out = kept.join("\n\n");
  return out.length > maxChars ? fallback() : out;
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

    // --- teaser：首页卡片短文案，必填（缺了就拒收让上层纠正）；超长按句界截断（1–2 句上限）
    const teaserRaw = String(sec.teaser ?? "").trim();
    if (!teaserRaw) return { ok: false, reason: `${lang}.teaser 为空` };
    const teaser = fitText(teaserRaw, TEASER_MAX_CHARS, 1, 2);
    if (!teaser) return { ok: false, reason: `${lang}.teaser 为空` };

    // --- overview：非空 → 规范化（### 标题后补空行）→ 句数 → 正文块数
    //     （### 小标题不计）→ markdown 拒收 → 评论数禁令（看原文，不看截断后）
    //     → 超长按空行块截断
    const trimmed = String(sec.overview ?? "").trim();
    if (!trimmed) return { ok: false, reason: `${lang}.overview 为空` };
    const overviewRaw = normalizeOverview(trimmed);
    const sentences = countSentences(overviewRaw);
    if (sentences < OVERVIEW_MIN_SENTENCES) {
      return { ok: false, reason: `${lang}.overview 句数不足（${sentences} < ${OVERVIEW_MIN_SENTENCES}）` };
    }
    const blocks = countBodyBlocks(overviewRaw);
    if (blocks < 2) {
      return {
        ok: false,
        reason: `${lang}.overview 段数不足（须用空行分成 3–6 段正文、至少 2 段，### 小标题不计入；当前 ${blocks} 段）`,
      };
    }
    const badMd = findOverviewMarkdown(overviewRaw);
    if (badMd) {
      // reason 必须含 "markdown" —— summaryFeedback 按这个子串给纠正提示
      return {
        ok: false,
        reason: `${lang}.overview 含未允许的 markdown（${badMd}），只允许行首 ### 小标题、行内 \`code\` 与 **bold**`,
      };
    }
    const badOverview = findCommentCount(overviewRaw);
    if (badOverview) {
      return { ok: false, reason: `不许提评论数: ${lang}.overview 出现 "${badOverview}"` };
    }
    // 自动提交是相加项（count 与 automated 互不相交）：写成「其中/包含」的包含关系要重写
    const overlapOverview = AUTOMATED_OVERLAP_RE.exec(overviewRaw);
    if (overlapOverview) {
      return {
        ok: false,
        reason: `${lang}.overview 把自动提交写成包含关系（「${overlapOverview[0]}」），应写成「本人 N 次，另有 M 次」`,
      };
    }
    const overview =
      overviewRaw.length > OVERVIEW_MAX_CHARS
        ? fitOverviewByBlock(overviewRaw, OVERVIEW_MAX_CHARS)
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
    // 条数上限随输入里真实出现过的仓库数放大：提示词要求「每个有活动的仓库都要有一条」，
    // 8 条固定上限会把真实仓库悄悄砍掉（2026-09 窗口实测 16 个仓库只剩 8 条）。
    // 仍保留 8 条保底与 24 条硬顶防长尾；缺仓库不拒收（按约定不加硬约束）。
    const byRepoCap = Math.min(BY_REPO_CEIL, Math.max(BY_REPO_MAX, repos.size));
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
      const overlapText = AUTOMATED_OVERLAP_RE.exec(textRaw);
      if (overlapText) {
        return {
          ok: false,
          reason: `${at}.text 把自动提交写成包含关系（「${overlapText[0]}」），应写成「本人 N 次，另有 M 次」`,
        };
      }
      byRepo.push({ repo, text: textRaw.slice(0, BY_REPO_TEXT_MAX) });
      if (byRepo.length >= byRepoCap) break;
    }
    if (byRepo.length === 0 && repos.size > 0) {
      return { ok: false, reason: `${lang}.byRepo 为空（有活动时至少 1 条）` };
    }

    value[lang] = { headline, teaser, overview, highlights, byRepo };
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
