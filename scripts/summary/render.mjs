/**
 * scripts/summary/render.mjs — 「近 30 天 GitHub 活动 AI 总结」渲染层
 * ------------------------------------------------------------------
 * 零依赖 ESM（Node 20+）。只读数据、产出「已经可以整段写进文件」的 HTML 字符串：
 *
 *   renderSummaryPage({ summary, username })  → docs/summary.html 全文
 *   summaryCard({ summary })                 → docs/index.html 顶部卡片片段
 *
 * 数据契约（docs/summary.json，由 scripts/summary 编排层写入，本文件只读）：
 * {
 *   windowStart, windowEnd, days, username, generatedAt,
 *   missing:  { days, dates[] },
 *   totals:   { commits, prs, issues, reviews },   // 确定数字，由代码求和
 *   automatedCommits,                              // 与 totals.commits「相加」，不是包含
 *   backfilled: [ "YYYY-MM-DD", ... ],             // Search 重建的较早日期（只展示起止）
 *   ai: { en: { headline, teaser, overview, highlights[], byRepo[] },
 *         zh: { 同构 } } | null,                   // null → 「AI 摘要暂不可用」
 *   aiProvider, aiModel, aiFailure,                // 消费：provider/model 旁注 + 失败卡
 *   dataHash, sources, backfillLimits              // 本渲染层不消费，仅透传语义
 * }
 * overview 是章节式：空行分块、行首 `### ` 小标题（splitBlocks → <h3 class="ai-h3">），
 * 其余块 → <p>；highlight / byRepo 仍按句切段（splitParagraphs）。
 * 标题前缀 `窗口区间 · headline` 由 windowPrefix 用 windowStart/windowEnd 代码拼装
 * （日期过 esc），与 provider/model 一样绝不取自 AI 文本。
 * highlights[] / byRepo[] 的 repo / number / url 由校验器从真实数据注入：
 * 链接只认注入的 url（过 safeHref），AI 文本里的一切只当纯文本走 aiInlineToHtml。
 *
 * 样式与双语机制全部复用 scripts/daily/render.mjs（i18n → localStorage 键
 * gh-report-lang + <html data-lang>）。总结页专属 CSS 只写在本文件 EXTRA_CSS，
 * 经 htmlDoc({ ..., extraCss }) → pageStyle 的追加钩子注入；首页卡片只允许用
 * pageStyle 已有的类（index 页没有 extraCss 钩子）。
 */

import {
  esc,
  safeHref,
  i18n,
  icon,
  section,
  pill,
  statsStrip,
  topbarRight,
  footerBlock,
  htmlDoc,
  TOGGLE_SCRIPT,
  SEP,
  aiInlineToHtml,
  splitParagraphs,
} from '../daily/render.mjs';
import { sanitizeReason } from '../daily/lib/ai.mjs';

// ---------------------------------------------------------------- 防御小工具

/** 有限数字（缺字段 / NaN / null → 0）。 */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** 数组守卫（缺字段 / 非数组 → []）。 */
const A = (x) => (Array.isArray(x) ? x : []);
/** 字符串化（null / undefined → ''）。 */
const S = (v) => (v == null ? '' : String(v));
/** 对象守卫（null / 非对象 → {}）。 */
const O = (v) => (v && typeof v === 'object' ? v : {});

/** ISO 时间 → `YYYY-MM-DD HH:MM · UTC+8`；不可解析时返回 ''。 */
function fmtUtc8(ts) {
  const ms = typeof ts === 'number' ? ts : Date.parse(S(ts));
  if (!Number.isFinite(ms)) return '';
  const t = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())} · UTC+8`;
}

/** extLink 风格的外链（安全降级为不可点的 span）。 */
function extLink(url, text) {
  const href = safeHref(url);
  const label = esc(text);
  if (!href) return `<span class="link">${label}</span>`;
  return (
    `<a class="link" href="${esc(href)}" target="_blank" ` +
    `rel="noopener noreferrer">${label}</a>`
  );
}

// ---------------------------------------------------------------- 双语正文

/**
 * 章节式正文切块：只按空行（`/\n\s*\n/`）分块，绝不在句末标点处切。
 * 首行（trim 后）以 `### ` 开头的块 → { type: 'h' }，并剥掉行首的 `### `
 * （渲染成 <h3 class="ai-h3">）；其余块 → { type: 'p' }；空块丢弃。
 */
export function splitBlocks(text) {
  const src = S(text).replace(/\r\n?/g, '\n');
  const out = [];
  for (const raw of src.split(/\n\s*\n/)) {
    const block = raw.trim();
    if (!block) continue;
    if (block.startsWith('### ')) out.push({ type: 'h', text: block.slice(4).trim() });
    else out.push({ type: 'p', text: block });
  }
  return out;
}

/** 块列表 → 逐块 <h3 class="ai-h3"> / <p>，块内仍走 aiInlineToHtml 内联子集。 */
function blocksHtml(text) {
  return splitBlocks(text)
    .map((b) =>
      b.type === 'h'
        ? `<h3 class="ai-h3">${aiInlineToHtml(b.text)}</h3>`
        : `<p>${aiInlineToHtml(b.text)}</p>`
    )
    .join('');
}

/** 一段文本 → splitParagraphs 切段 + aiInlineToHtml 渲染，逐段包 <p>。 */
function parasHtml(text, lang) {
  return splitParagraphs(S(text), lang)
    .map((p) => `<p>${aiInlineToHtml(p)}</p>`)
    .join('');
}

/**
 * 双语正文块：en/zh 相同（或只有一份）时只渲染一份；不同则两份
 * `<div class="{cls} i18n" data-lang>`（照 aiSummaryBlock 的写法）。
 * 两边都空时返回 ''。
 */
function bilingualBlock(enText, zhText, lang, cls) {
  const e = S(enText);
  const z = S(zhText) || e;
  if (!e.trim() && !z.trim()) return '';
  if (e === z) return `<div class="${cls}">${parasHtml(e, lang)}</div>`;
  return (
    `<div class="${cls} i18n" data-lang="en">${parasHtml(e, 'en')}</div>` +
    `<div class="${cls} i18n" data-lang="zh">${parasHtml(z, 'zh')}</div>`
  );
}

/**
 * bilingualBlock 的章节式版本（overview 专用）：同样的 en/zh 相等去重 +
 * data-lang 双份结构，只是块内渲染换成 splitBlocks（### → h3，其余 → p）。
 * highlights / byRepo 仍走 splitParagraphs 的 bilingualBlock，不在此列。
 */
function bilingualBlocks(enText, zhText, cls) {
  const e = S(enText);
  const z = S(zhText) || e;
  if (!e.trim() && !z.trim()) return '';
  if (e === z) return `<div class="${cls}">${blocksHtml(e)}</div>`;
  return (
    `<div class="${cls} i18n" data-lang="en">${blocksHtml(e)}</div>` +
    `<div class="${cls} i18n" data-lang="zh">${blocksHtml(z)}</div>`
  );
}

/**
 * 标题的窗口前缀：`<span class="mono">{start} – {end}</span> · `（U+2013 连接
 * 两端日期、U+00B7 分隔标题）。日期取 summary.windowStart / windowEnd —— 代码
 * 拼装 + esc，绝不取自 AI 文本；任一日期缺失/空白 → 返回 ''（标题退回纯
 * headline，不带前缀也不带分隔符）。
 */
function windowPrefix(start, end) {
  const a = S(start).trim();
  const b = S(end).trim();
  if (!a || !b) return '';
  return `<span class="mono">${esc(a)} – ${esc(b)}</span> · `;
}

/** AI 徽章（与日报 aiSummaryBlock 同款）。 */
const AI_BADGE = `<span class="ai-badge">${icon('spark')}${i18n('AI summary', 'AI 摘要')}</span>`;

/** 与日报一致的降级文案。 */
const AI_UNAVAILABLE = () =>
  `<p class="ai-unavailable">${i18n(
    'AI summary temporarily unavailable.',
    'AI 摘要暂不可用。'
  )}</p>`;

/**
 * AI 块的 provider / model 旁注（.ai-top 内徽章右侧小字；.ai-provider 类由
 * scripts/daily/render.mjs 提供，这里只拼标记，不定义样式）。
 * provider 为空整段不渲染；model 缺失退化成只有 provider（历史数据没有 aiModel）。
 * 两个值都是代码字段（summary.aiProvider / aiModel，非 AI 文本），渲染前过
 * sanitizeReason + i18n(内部 esc) 兜底 —— 采集侧万一漏脱敏也不会把 token 摆上页面。
 */
function providerNote(provider, model) {
  const p = sanitizeReason(S(provider)).trim();
  if (!p) return '';
  const m = sanitizeReason(S(model)).trim();
  return `<span class="ai-provider">${i18n(
    m ? `via ${p} / ${m}` : `via ${p}`,
    m ? `由 ${p} / ${m} 生成` : `由 ${p} 生成`
  )}</span>`;
}

/**
 * AI 全失败时的可见性块（总结侧，与日报 aiFailureBlock 同构）：
 * 逐条 `<provider> / <model>：<原因>` + 常驻 issue 链接。attempt 的 model 为空
 * → 只显示 `<provider>：<原因>`。provider / model / reason 都过 sanitizeReason
 * （reason 来自网络层；provider / model 是代码字段，同样过一道做深度防御）再 esc。
 * issue 缺失 → 只渲染原因行、没有链接；既无有效行也无链接 → 返回 ''（维持原降级形态）。
 * .ai-failure / .ai-failure-line 类由 scripts/daily/render.mjs 提供。
 */
function failureBlock(failure) {
  const f = O(failure);
  const attempts = A(f.attempts);
  const issue = O(f.issue);
  const issueNum = Number(issue.number);
  const href = safeHref(issue.url);
  const lines = attempts
    .map((a) => {
      const at = O(a);
      const head = [sanitizeReason(S(at.provider)).trim(), sanitizeReason(S(at.model)).trim()]
        .filter(Boolean)
        .join(' / ');
      if (!head) return '';
      const reason = sanitizeReason(S(at.reason)).trim();
      return `<span class="ai-failure-line">${esc(head)}：${esc(reason)}</span>`;
    })
    .filter(Boolean)
    .join('');
  const link =
    Number.isFinite(issueNum) && issueNum > 0 && href
      ? `<a class="link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${i18n(
          `View failure details #${issueNum} →`,
          `查看失败详情 #${issueNum} →`
        )}</a>`
      : '';
  if (!lines && !link) return '';
  return `<div class="ai-failure">${lines}${link}</div>`;
}

/** 无 AI headline 时的页面默认标题。 */
const DEFAULT_HEADLINE = {
  en: 'GitHub activity · last 30 days',
  zh: 'GitHub 动态 · 近 30 天',
};

// ---------------------------------------------------------------- highlights

/**
 * kind → 中英标签 + 徽章配色（复用 .badge / .chip 系列）。
 * 未知 kind 降级成中性 chip，原样展示 token。
 */
function kindBadge(kind) {
  const k = S(kind).trim().toLowerCase();
  const map = {
    pr: { en: 'PR', zh: 'PR', cls: 'badge-opened' },
    issue: { en: 'Issue', zh: 'Issue', cls: 'badge-commented' },
    discussion: { en: 'Discussion', zh: '讨论', cls: 'badge-reviewed' },
    release: { en: 'Release', zh: '发布', cls: 'badge-merged' },
  };
  const m = map[k];
  if (m) return `<span class="badge ${m.cls}">${i18n(m.en, m.zh)}</span>`;
  if (k) return `<span class="chip chip-kind">${i18n(k, k)}</span>`;
  return '';
}

/** `#number` 标签；无有效编号（如 release）时返回 null，链接标签退回 repo。 */
function refLabel(number) {
  const n = Number(number);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number.isInteger(n) ? `#${n}` : `#${S(number)}`;
}

/**
 * highlights 列表体：en / zh 按下标配对（契约声明同构），链接只用注入的 url。
 * 每行：kind 徽章 + repo + 链接，下面走 aiInlineToHtml 的双语正文。
 */
function highlightsBody(ai) {
  const en = O(ai.en);
  const zh = O(ai.zh);
  const listEn = A(en.highlights);
  const listZh = A(zh.highlights);
  const count = Math.max(listEn.length, listZh.length);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const a = O(listEn[i]);
    const b = O(listZh[i]);
    const base = listEn[i] ? a : b; // repo / number / url 是校验器注入的，与语言无关
    const repo = S(base.repo).trim();
    const label = refLabel(base.number) || repo;
    const head = [kindBadge(base.kind || base.type), repo && refLabel(base.number) ? `<span class="repo">${esc(repo)}</span>` : '', label ? extLink(base.url, label) : '']
      .filter(Boolean)
      .join('');
    const text = bilingualBlock(a.text ?? b.text, b.text ?? a.text, 'zh', 'ai-summary');
    if (!head && !text) continue;
    rows.push(`<li>${head ? `<div class="row-lead">${head}</div>` : ''}${text}</li>`);
  }
  return rows.length ? `<ul class="list">${rows.join('')}</ul>` : '';
}

// ---------------------------------------------------------------- by repository

/** byRepo 列表体：`.repo` 标题 + 双语正文（同样按 index 配对）。 */
function byRepoBody(ai) {
  const listEn = A(O(ai.en).byRepo);
  const listZh = A(O(ai.zh).byRepo);
  const count = Math.max(listEn.length, listZh.length);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const a = O(listEn[i]);
    const b = O(listZh[i]);
    const repo = S(a.repo || b.repo).trim();
    const text = bilingualBlock(a.text ?? b.text, b.text ?? a.text, 'zh', 'ai-summary');
    if (!repo && !text) continue;
    rows.push(
      `<li>${repo ? `<div class="repo byrepo-title">${esc(repo)}</div>` : ''}${text}</li>`
    );
  }
  return rows.length ? `<ul class="list">${rows.join('')}</ul>` : '';
}

// ---------------------------------------------------------------- AI 卡片

/**
 * AI 总览卡（页面用）：badge + provider 旁注 + headline + overview 双语
 * （overview 走 splitBlocks 章节式渲染）；ai 为 null 走降级文案，
 * 降级段之后按需追加失败可见性块（meta.provider / meta.model / meta.failure
 * 由 renderSummaryPage 从 summary 代码字段注入，与 AI 文本无关）。
 */
function aiOverviewCard(ai, meta = {}) {
  const m = O(meta);
  const top = `<div class="ai-top">${AI_BADGE}${providerNote(m.provider, m.model)}</div>`;
  const fail = failureBlock(m.failure);
  if (!ai || typeof ai !== 'object') {
    return `<section class="card ai">${top}${AI_UNAVAILABLE()}${fail}</section>`;
  }
  const en = O(ai.en);
  const zh = O(ai.zh);
  const hEn = S(en.headline);
  const hZh = S(zh.headline) || hEn;
  const oEn = S(en.overview);
  const oZh = S(zh.overview) || oEn;
  const hasHead = (hEn || hZh).trim() !== '';
  const hasOver = (oEn || oZh).trim() !== '';
  if (!hasHead && !hasOver) {
    return `<section class="card ai">${top}${AI_UNAVAILABLE()}${fail}</section>`;
  }
  const head = hasHead ? `<h2 class="ai-headline">${i18n(hEn || hZh, hZh || hEn)}</h2>` : '';
  const over = hasOver ? bilingualBlocks(oEn, oZh, 'ai-summary') : '';
  return `<section class="card ai">${top}${head}${over}</section>`;
}

// ---------------------------------------------------------------- 提示卡

/** 缺日提示（虚线 trunc-notice 卡）；无缺日返回 ''。 */
function missingNotice(missing) {
  const m = O(missing);
  const days = num(m.days);
  if (days <= 0) return '';
  const dates = A(m.dates).map((d) => S(d).trim()).filter(Boolean);
  const listEn = dates.join(', ');
  const listZh = dates.join('、');
  const en =
    `Data missing for ${days} day${days === 1 ? '' : 's'} in this window` +
    `${dates.length ? `: ${listEn}` : ''}.`;
  const zh =
    `窗口内 ${days} 天缺数据` + `${dates.length ? `：${listZh}` : ''}。`;
  return (
    `<section class="card">` +
    `<p class="trunc-notice">${i18n(en, zh)}</p>` +
    `</section>`
  );
}

/** 回填（Search 重建）说明：只列起止日期，不逐日列；无回填返回 ''。 */
function backfillNotice(backfilled) {
  const dates = A(backfilled).map((d) => S(d).trim()).filter(Boolean);
  if (!dates.length) return '';
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const n = dates.length;
  const en =
    `The earlier ${n} day${n === 1 ? '' : 's'} (${first} ~ ${last}) were rebuilt ` +
    'from GitHub Search and may be incomplete; stars cannot be rebuilt and ' +
    'releases cover only your own repositories.';
  const zh =
    `较早的 ${n} 天（${first} ~ ${last}）为 Search 重建，可能不完整；` +
    '星标无法重建、发布只覆盖自有仓库。';
  return (
    `<section class="card">` +
    `<p class="trunc-notice">${i18n(en, zh)}</p>` +
    `</section>`
  );
}

// ---------------------------------------------------------------- 首页卡片

/** 首页卡片短文案上限（与 validate-summary 的 TEASER_MAX_CHARS 同口径）。 */
const CARD_TEASER_MAX_CHARS = 240;

/**
 * 首页卡片短文案：优先 AI teaser（结构里的 1–2 句短字段）。
 * 旧 docs/summary.json（AI 输出无 teaser）回退成「overview 第一个正文块截断」
 * （走 splitBlocks，### 小标题块绝不当 teaser），保证老数据也不会把 10–16 句
 * 的整段搬上首页，更不会开天窗。
 */
function cardTeaser(sec, fallbackSec) {
  const t = S(O(sec).teaser).trim();
  if (t) return t;
  const blocks = splitBlocks(S(O(sec).overview) || S(O(fallbackSec).overview));
  const first = blocks.find((b) => b.type === 'p');
  const p = first ? first.text : '';
  if (p.length <= CARD_TEASER_MAX_CHARS) return p;
  return `${p.slice(0, CARD_TEASER_MAX_CHARS).trim()}…`;
}

/**
 * 首页顶部总结卡片片段：一个 `<section class="card ai">`，不带 html/head、
 * 不带 .wrap / hero，可直接嵌进 renderIndexPage 的 .wrap。
 * summary 为 null（或非对象）返回 ''；ai 缺失且无失败明细也返回 ''（首页照常
 * 渲染，不报错）—— ai 缺失但 aiFailure 有内容时则摆出「暂不可用 + 失败卡」。
 *
 * 卡片只放短文案（窗口前缀 + headline + teaser）+ 确定数字 + 按钮 —— 完整
 * overview 留在 summary.html，首页不放，避免卡片被 10–16 句的整段撑得过长。
 *
 * 注意：index 页没有 extraCss 钩子，这里只允许用 pageStyle 已有的类
 * （card/ai-badge/ai-headline/ai-summary/ai-provider/row-meta/mono/ghbtn 等）。
 */
export function summaryCard({ summary } = {}) {
  const s = O(summary);
  if (summary == null || typeof summary !== 'object' || Array.isArray(summary)) return '';
  const totals = O(s.totals);
  const c = num(totals.commits);
  const p = num(totals.prs);
  const i = num(totals.issues);
  const r = num(totals.reviews);
  const auto = num(s.automatedCommits);

  // 按钮行：首页没有 extraCss 钩子，卡片片段只能用 pageStyle 已有的类；
  // .foot 自带上边框 + 上间距，读作「卡片页脚动作行」
  const btn =
    `<div class="foot">` +
    `<a class="ghbtn" href="./summary.html">${i18n(
      'Read the full 30-day summary →',
      '查看完整 30 天总结 →'
    )}</a>` +
    `</div>`;

  // provider / model / 失败明细都读 summary 的代码字段（AI 文本不参与）；
  // .ai-provider / .ai-failure 类由 scripts/daily/render.mjs 提供
  const top = `<div class="ai-top">${AI_BADGE}${providerNote(s.aiProvider, s.aiModel)}</div>`;
  const fail = failureBlock(s.aiFailure);
  const ai = s.ai && typeof s.ai === 'object' ? s.ai : null;
  if (!ai) {
    // ai 缺失且没有失败明细 → 照旧返回空串（首页不开天窗、不摆空卡）；
    // 有失败明细 → 把「暂不可用 + 失败卡」摆出来，这正是本次要的可见性
    if (!fail) return '';
    return `<section class="card ai">${top}${AI_UNAVAILABLE()}${fail}${btn}</section>`;
  }

  const en = O(ai.en);
  const zh = O(ai.zh);
  const hEn = S(en.headline);
  const hZh = S(zh.headline) || hEn;
  const tEn = cardTeaser(en, zh);
  const tZh = cardTeaser(zh, en);
  const hasHead = (hEn || hZh).trim() !== '';
  const hasTeaser = (tEn || tZh).trim() !== '';
  if (!hasHead && !hasTeaser) {
    return `<section class="card ai">${top}${AI_UNAVAILABLE()}${fail}${btn}</section>`;
  }
  // 标题 = 代码拼的窗口区间前缀 + AI headline（前缀与分隔符都不来自 AI 文本）
  const head = hasHead
    ? `<h2 class="ai-headline">${windowPrefix(s.windowStart, s.windowEnd)}${i18n(hEn || hZh, hZh || hEn)}</h2>`
    : '';
  const teaser = bilingualBlock(tEn, tZh, 'en', 'ai-summary');

  // 确定数字一行（简洁，不整块 statsStrip）
  const nums = `<div class="row-meta mono">${i18n(
    `${c} commits · ${p} pull requests · ${i} issues · ${r} reviews`,
    `${c} 次提交 · ${p} 个 PR · ${i} 个 Issue · ${r} 次评审`
  )}</div>`;
  // 机器人提交：相加表述，不是「其中」
  const bot =
    auto > 0
      ? `<div class="row-meta">${i18n(
          `${c} own commits plus ${auto} automated commits`,
          `${c} 次本人提交，另有 ${auto} 次由机器人自动提交`
        )}</div>`
      : '';

  return (
    `<section class="card ai">` +
    top +
    head +
    teaser +
    nums +
    bot +
    btn +
    `</section>`
  );
}

// ---------------------------------------------------------------- 总结页

/**
 * docs/summary.html 全文。结构自上而下：
 * topbar（返回链接 + topbarRight）→ hero（eyebrow / AI headline / 窗口区间）
 * → 确定数字条 + 机器人提交行 → 缺日提示 → 回填说明
 * → AI 总览卡 → Highlights → By repository → footer + 口径说明。
 */
export function renderSummaryPage({ summary, username } = {}) {
  const s = O(summary);
  const user = S(username != null ? username : s.username).trim();
  const totals = O(s.totals);
  const ai = s.ai && typeof s.ai === 'object' ? s.ai : null;

  const c = num(totals.commits);
  const auto = num(s.automatedCommits);
  const parts = [];

  // top bar（照 renderReportPage 的写法）
  parts.push(
    `<div class="topbar">` +
      `<a class="back" href="./index.html">${i18n('← All reports', '← 全部日报')}</a>` +
      topbarRight(user) +
      `</div>`
  );

  // hero
  const hEn = ai ? S(O(ai.en).headline) : '';
  const hZh = ai ? S(O(ai.zh).headline) : '';
  const headline =
    (hEn || hZh).trim() !== ''
      ? i18n(hEn || hZh, hZh || hEn)
      : i18n(DEFAULT_HEADLINE.en, DEFAULT_HEADLINE.zh);
  const subBits = [];
  const start = S(s.windowStart).trim();
  const end = S(s.windowEnd).trim();
  const win = start && end ? `${start} ~ ${end}` : start || end;
  if (win) subBits.push(`<span class="mono">${esc(`${win} · UTC+8`)}</span>`);
  const gen = fmtUtc8(s.generatedAt);
  if (gen) subBits.push(i18n(`Generated ${gen}`, `生成于 ${gen}`));
  // hero 标题 = 代码拼的窗口区间前缀 + AI headline（与首页卡片 h2 同一拼法；
  // 日期缺失时 windowPrefix 返回 ''，退回纯 headline）
  const headPrefix = windowPrefix(start, end);
  parts.push(
    `<header class="hero">` +
      `<p class="eyebrow">${
        user
          ? i18n(`@${user} · Last 30 days`, `@${user} · 近 30 天`)
          : i18n('Last 30 days', '近 30 天')
      }</p>` +
      `<h1>${headPrefix}${headline}</h1>` +
      (subBits.length ? `<p class="hero-sub">${subBits.join(SEP)}</p>` : '') +
      `</header>`
  );

  // 确定数字条（非 AI）+ 机器人提交行（相加关系）
  parts.push(statsStrip(totals));
  if (auto > 0) {
    parts.push(
      `<p class="stats-note">${i18n(
        `${c} own commits plus ${auto} automated commits`,
        `${c} 次本人提交，另有 ${auto} 次由机器人自动提交`
      )}</p>`
    );
  }

  // 缺日 / 回填提示
  parts.push(missingNotice(s.missing));
  parts.push(backfillNotice(s.backfilled));

  // AI 总览（meta 全部来自 summary 的代码字段：provider / model 旁注 + 失败卡）
  parts.push(
    aiOverviewCard(ai, { provider: s.aiProvider, model: s.aiModel, failure: s.aiFailure })
  );

  // Highlights
  const hl = highlightsBody(ai || {});
  if (hl) parts.push(section('spark', 'Highlights', '要点', pill(A(O(ai).highlights).length || A(O(ai).zh.highlights).length, 0), hl));

  // By repository
  // 与 Highlights 一致：标题右侧给出条数（每个有活动的仓库一条），别让两条板块一个有一个没有
  const br = byRepoBody(ai || {});
  if (br) {
    parts.push(
      section(
        'commit',
        'By repository',
        '按仓库',
        pill(A(O(ai).byRepo).length || A(O(ai).zh.byRepo).length, 0),
        br
      )
    );
  }

  // footer + 固定口径说明
  parts.push(footerBlock(s.generatedAt));
  parts.push(
    `<p class="foot-note">${i18n(
      'A 30-day window = the 30 most recent finalized calendar days (UTC+8); ' +
        'numbers are summed in code and commit counts exclude merge commits.',
      '30 天窗口 = 最近 30 个已定稿的自然日（UTC+8）；' +
        '数字由代码求和，提交统计不含合并提交。'
    )}</p>`
  );

  const body =
    `<div class="wrap">\n${parts.filter(Boolean).join('\n')}\n</div>\n` +
    `<script>${TOGGLE_SCRIPT}</script>`;

  return htmlDoc({
    title: 'Last 30 days · GitHub activity',
    body,
    assetPrefix: '',
    extraCss: EXTRA_CSS,
  });
}

// ---------------------------------------------------------------- 追加 CSS

/**
 * 总结页专属样式（经 htmlDoc → pageStyle(extraCss) 追加在基础样式之后）。
 * 能复用的类一律复用，这里只补基础样式没有的几处：
 *   .stats-note        —— 数字条下的机器人提交行（基础样式里 stats 自带 16px
 *                         下边距，此行要向上收紧再留出卡片间距）
 *   .foot-note         —— footer 之后的口径说明（基础样式没有对应类）
 *   .ai-h3             —— overview 章节式渲染的 ### 小标题（splitBlocks → h3；
 *                         首页卡片不放 overview，故只在本页补）
 *   .card > .trunc-notice:first-child / .list .ai-summary / .byrepo-title
 *                      —— 既有类的定位修正：trunc-notice 默认 margin-top 12px
 *                         是给「卡内追加」场景的，独立提示卡里要去掉；列表项内
 *                         的 ai-summary 默认 margin:0 会贴住标题；.repo 只有
 *                         等宽字体没有标题字号/字重。
 * .ai-provider / .ai-failure / .ai-failure-line 是共享类，定义在
 * scripts/daily/render.mjs，这里绝不重复定义。
 */
const EXTRA_CSS = `
/* ---- 30-day summary (scripts/summary/render.mjs) ---- */
.stats-note{margin:-8px 0 16px;font-size:.8rem;color:var(--on-surface-variant)}
.foot-note{margin:10px 0 0;font-size:.78rem;color:var(--on-surface-variant);max-width:64em}
.ai-h3{margin:14px 0 6px;font-size:.95rem;font-weight:800;color:var(--on-surface)}
.ai-h3:first-child{margin-top:0}
.card > .trunc-notice:first-child{margin-top:0}
.list .ai-summary{margin:9px 0 0}
.byrepo-title{font-size:.92rem;font-weight:750;color:var(--on-surface)}
`;
