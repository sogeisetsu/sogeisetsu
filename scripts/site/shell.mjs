#!/usr/bin/env node
/**
 * scripts/site/shell.mjs
 * ------------------------------------------------------------------
 * 站点外壳（零依赖 ESM，Node 20+）：转义 / 双语 / 图标 / 分区骨架 / 页脚 /
 * 语言切换脚本 / 整页文档模板。
 *
 * 这是 daily 与 summary 两条产品线**共用**的外壳：各自的 render 只负责「数据 → 正文」，
 * 页面骨架一律从这里取。对 summary/render.mjs 的契约（逐项依赖，签名不可变）：
 *   esc safeHref i18n icon section pill statsStrip topbarRight footerBlock
 *   htmlDoc TOGGLE_SCRIPT SEP
 * 另外给 site/indexPage.mjs：fmtDateShort；内部通用小工具：num / toMs / utc8。
 *
 * 硬约束：本文件不 import 任何采集 / IO / AI 模块（边界测试规则 e）。
 * 依赖方向只有一条：shell → css（htmlDoc 要把 pageStyle 摊进 <style>）。
 */

import { pageStyle } from "./css.mjs";

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ---------------------------------------------------------------- escaping

/** Escape a value for HTML text / attribute context. Copied from render-svg.mjs. */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Reject hrefs that could execute or leave the page in a surprising way.
 * Accepts absolute http(s) links (GitHub item URLs) and relative links
 * (index -> day pages). Anything protocol-ish and unknown is dropped.
 */
export function safeHref(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return null;
  if (/^(javascript|data|vbscript|file|blob):/i.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------- 时间与数字

/**
 * Break an instant into Asia/Shanghai (UTC+8) wall-clock parts.
 */
export function utc8(ms) {
  const t = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    hh: pad(t.getUTCHours()),
    mm: pad(t.getUTCMinutes()),
  };
}

export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function toMs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0;
  const parsed = Date.parse(String(ts == null ? '' : ts));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function fmtDateShort(value) {
  const s = String(value == null ? '' : value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return { en: s, zh: s };
  const y = m[1];
  const mo = Number(m[2]);
  const da = Number(m[3]);
  return {
    en: `${MONTHS_SHORT[mo - 1] || m[2]} ${da}, ${y}`,
    zh: `${y}年${mo}月${da}日`,
  };
}

// ---------------------------------------------------------------- 双语

/**
 * Render a value that exists in both languages. When the two strings are
 * identical only one copy is emitted; otherwise both are baked in and CSS
 * shows exactly one based on <html data-lang>.
 */
export function i18n(en, zh) {
  const a = en == null ? '' : String(en);
  const b = zh == null || zh === '' ? a : String(zh);
  if (a === b) return esc(a);
  return (
    `<span class="i18n" data-lang="en">${esc(a)}</span>` +
    `<span class="i18n" data-lang="zh">${esc(b)}</span>`
  );
}

export const SEP = '<span class="dot">·</span>';

// ---------------------------------------------------------------- 顶栏

function langToggle() {
  return (
    `<div class="langtoggle" role="group" aria-label="Language / 语言">` +
    `<button type="button" class="langbtn" data-set-lang="en" aria-pressed="true">EN</button>` +
    `<button type="button" class="langbtn" data-set-lang="zh" aria-pressed="false">中文</button>` +
    `</div>`
  );
}

/** GitHub mark (Octicons), filled with currentColor. */
function githubIcon() {
  return (
    `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">` +
    `<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>` +
    `</svg>`
  );
}

/**
 * Pill button linking to the user's GitHub profile. Omitted when there is no
 * username, so the top bar never carries a dead link.
 */
function githubButton(username) {
  const u = String(username == null ? '' : username).trim();
  if (!u) return '';
  const href = `https://github.com/${encodeURIComponent(u)}`;
  return (
    `<a class="ghbtn" href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="GitHub profile">` +
    githubIcon() +
    `<span class="ghbtn-label">GitHub</span>` +
    `</a>`
  );
}

/** Right-aligned cluster: GitHub profile button + language toggle. */
export function topbarRight(username) {
  return `<div class="topbar-right">${githubButton(username)}${langToggle()}</div>`;
}

// ---------------------------------------------------------------- 图标

const ICONS = {
  commit:
    '<circle cx="12" cy="12" r="3.6"/><path d="M2 12h6.4M15.6 12H22"/>',
  pr:
    '<circle cx="6.5" cy="6" r="2.6"/><circle cx="6.5" cy="18" r="2.6"/>' +
    '<circle cx="17.5" cy="18" r="2.6"/><path d="M6.5 8.6v6.8M17.5 15.4V9.6a3 3 0 0 0-3-3H10"/>',
  review:
    '<path d="M2.2 12S5.8 5.5 12 5.5 21.8 12 21.8 12 18.2 18.5 12 18.5 2.2 12 2.2 12Z"/>' +
    '<circle cx="12" cy="12" r="3"/>',
  issue:
    '<circle cx="12" cy="12" r="9"/>' +
    '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
  release:
    '<path d="M12 3l8.5 4.7v8.6L12 21l-8.5-4.7V7.7L12 3Z"/>' +
    '<path d="M3.5 7.7 12 12.4l8.5-4.7M12 12.4V21"/>',
  star:
    '<path d="M12 3.4l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8L6.7 20l1-6-4.4-4.2 6-.9L12 3.4Z"/>',
  reply:
    '<path d="M20.5 11.6a8 8 0 0 1-8.7 8 8.9 8.9 0 0 1-3.5-.7L3.5 20.5l1.6-5A8 8 0 0 1 12 3.6a8 8 0 0 1 8.5 8Z"/>',
  discussion:
    '<path d="M20.5 11.6a8 8 0 0 1-8.7 8 8.9 8.9 0 0 1-3.5-.7L3.5 20.5l1.6-5A8 8 0 0 1 12 3.6a8 8 0 0 1 8.5 8Z"/>' +
    '<path d="M8.5 9.5h7M8.5 13h4.5"/>',
  spark:
    '<path d="M12 3l1.7 5.6L19 10.3l-5.3 1.7L12 17.6l-1.7-5.6L5 10.3l5.3-1.7L12 3Z"/>' +
    '<path d="M18.5 15.5l.8 2.4 2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8.8-2.4Z" fill="currentColor" stroke="none"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.7 6.7 0 0 0 10.5 10.5Z"/>',
};

export function icon(name) {
  const body = ICONS[name] || '<circle cx="12" cy="12" r="4"/>';
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `focusable="false">${body}</svg>`
  );
}

// ---------------------------------------------------------------- 分区骨架

export function section(iconName, titleEn, titleZh, pillHtml, body) {
  return (
    `<section class="card">` +
    `<header class="sec-head">` +
    `<span class="sec-icon">${icon(iconName)}</span>` +
    `<h2 class="sec-title">${i18n(titleEn, titleZh)}</h2>` +
    `${pillHtml}` +
    `</header>` +
    `${body}` +
    `</section>`
  );
}

/**
 * Count pill: use the authoritative total whenever it is a real number —
 * INCLUDING a legitimate 0 — and fall back to the row count only when the
 * total is missing or not a number. (0 is a valid total: e.g. a commits
 * section rendered only for automated commits must still read 0.)
 */
export function pill(total, fallback) {
  const hasTotal =
    total !== null && total !== undefined && total !== '' && Number.isFinite(Number(total));
  const value = hasTotal ? Number(total) : Number(fallback) || 0;
  return `<span class="pill">${esc(value)}</span>`;
}

export function statsStrip(totals) {
  const defs = [
    { key: 'commits', en: 'Commits', zh: '提交' },
    { key: 'prs', en: 'Pull requests', zh: 'PR' },
    { key: 'issues', en: 'Issues', zh: 'Issue' },
    { key: 'reviews', en: 'Reviews', zh: '评审' },
  ];
  const chips = defs
    .map(
      (d) =>
        `<div class="stat"><div class="stat-num">${esc(num(totals[d.key]))}</div>` +
        `<div class="stat-label">${i18n(d.en, d.zh)}</div></div>`
    )
    .join('');
  return `<div class="stats">${chips}</div>`;
}

// ---------------------------------------------------------------- 页脚与文档外壳

export function footerBlock(generatedAt) {
  const ms = toMs(generatedAt);
  const when = ms
    ? (() => {
        const t = utc8(ms);
        return (
          `<time datetime="${esc(generatedAt)}">` +
          `${esc(`${t.date} ${t.hh}:${t.mm} · UTC+8`)}</time>`
        );
      })()
    : '';
  return (
    `<footer class="foot">` +
    `<span>${i18n(
      'Data from public GitHub activity; commit counts exclude merge commits.',
      '数据来自 GitHub 公开活动；提交统计不含合并提交。'
    )}</span>` +
    (when ? `<span class="foot-gen">${i18n('Generated', '生成于')} ${when}</span>` : '') +
    `</footer>`
  );
}

const LANG_BOOTSTRAP =
  "try{var l=localStorage.getItem('gh-report-lang');" +
  "if(l==='zh'||l==='en'){document.documentElement.setAttribute('data-lang',l);" +
  "document.documentElement.lang=(l==='zh')?'zh-CN':'en';}}catch(e){}";

export const TOGGLE_SCRIPT =
  "(function(){" +
  "function sync(l){var a=document.querySelectorAll('[data-set-lang]');" +
  "for(var i=0;i<a.length;i++){a[i].setAttribute('aria-pressed'," +
  "a[i].getAttribute('data-set-lang')===l?'true':'false');}}" +
  "function set(l){if(l!=='en'&&l!=='zh')return;var e=document.documentElement;" +
  "e.setAttribute('data-lang',l);e.lang=(l==='zh')?'zh-CN':'en';" +
  "try{localStorage.setItem('gh-report-lang',l);}catch(err){}sync(l);}" +
  "document.addEventListener('click',function(ev){var t=ev.target;" +
  "var b=(t&&t.closest)?t.closest('[data-set-lang]'):null;if(!b)return;" +
  "set(b.getAttribute('data-set-lang'));});" +
  "sync(document.documentElement.getAttribute('data-lang')||'en');})();";

export function htmlDoc({ title, body, assetPrefix = '', extraCss = '' }) {
  return `<!doctype html>
<html lang="en" data-lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="${assetPrefix}favicon.svg">
<script>${LANG_BOOTSTRAP}</script>
<style>${pageStyle(assetPrefix, extraCss)}</style>
</head>
<body>
${body}
</body>
</html>
`;
}
