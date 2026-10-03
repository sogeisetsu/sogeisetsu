/**
 * render.mjs — zero-dependency ESM renderer for the daily GitHub-activity
 * report published on GitHub Pages.
 *
 *   import { renderReportPage, renderIndexPage, renderMarkdown } from './render.mjs';
 *
 *   renderReportPage({ data, ai })      -> full "<!doctype html>…</html>" string
 *   renderIndexPage({ days, generatedAt }) -> archive index page
 *   renderMarkdown({ data, ai })        -> human-readable .md committed next to the html
 *
 * Design language: Material Design 3, matching scripts/render-svg.mjs — same
 * tonal palette, same system FONT_STACK, light + dark via prefers-color-scheme.
 *
 * Hard rules honoured here:
 *   · Zero external assets. No fonts, images, stylesheets, scripts or network.
 *   · Every dynamic string passes through esc() before it reaches the document.
 *   · The site is served from a subpath (https://sogeisetsu.github.io/sogeisetsu/),
 *     so every internal link is RELATIVE and never begins with "/".
 *   · Both languages are baked into the same document; a tiny inline script
 *     flips data-lang on <html>, updates lang, and remembers the choice.
 */

const FONT_STACK =
  '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ---------------------------------------------------------------- escaping

/** Escape a value for HTML text / attribute context. Copied from render-svg.mjs. */
function esc(value) {
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
function safeHref(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return null;
  if (/^(javascript|data|vbscript|file|blob):/i.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) return null;
  return s;
}

/** Markdown inline escaping: keep link text and list items from breaking. */
function mdInline(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/[*_[\]]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function mdUrl(url) {
  const href = safeHref(url);
  if (!href) return null;
  return href.replace(/[()<>]/g, (c) => encodeURIComponent(c));
}

function mdLink(text, url) {
  const href = mdUrl(url);
  if (!href) return mdInline(text);
  return `[${mdInline(text)}](<${href}>)`;
}

/** Un-escape the HTML entities we emit, so a link target can be inspected. */
function unesc(value) {
  return String(value == null ? '' : value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Apply a tiny, bounded inline-markdown subset (`code`, **bold**, *italic*,
 * _italic_) to a string that is ALREADY HTML-escaped. Placeholders keep code
 * spans out of the emphasis passes, so their contents are never rewritten.
 */
function renderInlineEmphasis(escaped) {
  let s = String(escaped == null ? '' : escaped);
  const codes = [];
  s = s.replace(/`([^`\n]+?)`/g, (_m, code) => {
    codes.push(code);
    return `\uE000${codes.length - 1}\uE001`;
  });
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_\n]+?)_/g, '<em>$1</em>');
  s = s.replace(/\uE000(\d+)\uE001/g, (_m, i) => `<code>${codes[Number(i)] || ''}</code>`);
  return s;
}

/**
 * Render a SAFE inline-markdown subset for UNTRUSTED text (other people's
 * comments and release notes). The whole string is HTML-escaped first, so raw
 * HTML can never survive; only a whitelist of inline markers is then expanded.
 * Links are accepted only for http(s) targets; other markers stay literal.
 * Regexes are bounded so a stray `**` cannot swallow the rest of the string.
 */
function mdInlineToHtml(text) {
  let s = esc(text);
  const stash = [];
  s = s.replace(/\[([^\]\n]+?)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
    const href = safeHref(unesc(url));
    if (!href) return m;
    stash.push(
      `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">` +
        `${renderInlineEmphasis(label)}</a>`
    );
    return `\uE002${stash.length - 1}\uE003`;
  });
  s = renderInlineEmphasis(s);
  s = s.replace(/\uE002(\d+)\uE003/g, (_m, i) => stash[Number(i)] || '');
  return s;
}

/**
 * Break an instant into Asia/Shanghai (UTC+8) wall-clock parts.
 */
function utc8(ms) {
  const t = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    hh: pad(t.getUTCHours()),
    mm: pad(t.getUTCMinutes()),
  };
}

/**
 * Explicit UTC+8 window label: `YYYY-MM-DD HH:MM – HH:MM · UTC+8`. A finalized
 * day (before the current Shanghai day) runs 00:00 – 24:00; the rolling current
 * day ends at the generator wall-clock time. Returns null with no timestamp.
 */
function windowLabel(date, generatedAt) {
  const ms = toMs(generatedAt);
  if (!ms) return null;
  const gen = utc8(ms);
  const reportDate = String(date == null ? '' : date).trim().slice(0, 10);
  const finalized = /^\d{4}-\d{2}-\d{2}$/.test(reportDate) && reportDate < gen.date;
  const shownDate = finalized ? reportDate : gen.date;
  const end = finalized ? '24:00' : `${gen.hh}:${gen.mm}`;
  const label = `${shownDate} 00:00 – ${end} · UTC+8`;
  return { en: label, zh: label };
}

// ---------------------------------------------------------------- values

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const A = (x) => (Array.isArray(x) ? x : []);

function toMs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0;
  const parsed = Date.parse(String(ts == null ? '' : ts));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmtTime(ts) {
  const t = toMs(ts);
  if (!t) return '';
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

function fmtDate(value) {
  const s = String(value == null ? '' : value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return { en: s, zh: s };
  const y = m[1];
  const mo = Number(m[2]);
  const da = Number(m[3]);
  return {
    en: `${MONTHS_EN[mo - 1] || m[2]} ${da}, ${y}`,
    zh: `${y}年${mo}月${da}日`,
  };
}

function fmtDateShort(value) {
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

// ---------------------------------------------------------------- bilingual

/**
 * Render a value that exists in both languages. When the two strings are
 * identical only one copy is emitted; otherwise both are baked in and CSS
 * shows exactly one based on <html data-lang>.
 */
function i18n(en, zh) {
  const a = en == null ? '' : String(en);
  const b = zh == null || zh === '' ? a : String(zh);
  if (a === b) return esc(a);
  return (
    `<span class="i18n" data-lang="en">${esc(a)}</span>` +
    `<span class="i18n" data-lang="zh">${esc(b)}</span>`
  );
}

const UNTITLED = () => i18n('(untitled)', '(无标题)');

// ---------------------------------------------------------------- fragments

const SEP = '<span class="dot">·</span>';

function repoSpan(repo) {
  return repo ? `<span class="repo">${esc(repo)}</span>` : '';
}

function timeHtml(ts) {
  const label = fmtTime(ts);
  return label ? `${SEP}<time class="time">${esc(label)}</time>` : '';
}

function dateHtml(value) {
  const s = String(value == null ? '' : value);
  if (!s) return '';
  const f = fmtDateShort(s);
  return `${SEP}<time class="time">${i18n(f.en, f.zh)}</time>`;
}

function extLink(url, text, cls) {
  const href = safeHref(url);
  const classes = `link${cls ? ` ${cls}` : ''}`;
  const label = esc(text);
  if (!href) return `<span class="${classes}">${label}</span>`;
  return (
    `<a class="${classes}" href="${esc(href)}" target="_blank" ` +
    `rel="noopener noreferrer">${label}</a>`
  );
}

function actionBadge(action) {
  const map = {
    opened: { en: 'Opened', zh: '开启', cls: 'badge-opened' },
    merged: { en: 'Merged', zh: '已合并', cls: 'badge-merged' },
    closed: { en: 'Closed', zh: '已关闭', cls: 'badge-closed' },
    commented: { en: 'Commented', zh: '评论', cls: 'badge-commented' },
    reviewed: { en: 'Reviewed', zh: '评审', cls: 'badge-reviewed' },
  };
  const m = map[String(action == null ? '' : action).toLowerCase()];
  if (!m) return '';
  return `<span class="badge ${m.cls}">${i18n(m.en, m.zh)}</span>`;
}

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
function topbarRight(username) {
  return `<div class="topbar-right">${githubButton(username)}${langToggle()}</div>`;
}

// ---------------------------------------------------------------- icons

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
  spark:
    '<path d="M12 3l1.7 5.6L19 10.3l-5.3 1.7L12 17.6l-1.7-5.6L5 10.3l5.3-1.7L12 3Z"/>' +
    '<path d="M18.5 15.5l.8 2.4 2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8.8-2.4Z" fill="currentColor" stroke="none"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.7 6.7 0 0 0 10.5 10.5Z"/>',
};

function icon(name) {
  const body = ICONS[name] || '<circle cx="12" cy="12" r="4"/>';
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `focusable="false">${body}</svg>`
  );
}

// ---------------------------------------------------------------- sections

function section(iconName, titleEn, titleZh, pillHtml, body) {
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

/** Count pill: prefer the authoritative total, fall back to the row count. */
function pill(total, fallback) {
  const primary = Number(total) || 0;
  const value = primary > 0 ? primary : Number(fallback) || 0;
  return `<span class="pill">${esc(value)}</span>`;
}

function commitsSection(items, totals) {
  const rows = items
    .map((it) => {
      const own = it.own
        ? `<span class="chip chip-own">${i18n('Owned', '自有')}</span>`
        : `<span class="chip chip-ext">${i18n('External', '外部')}</span>`;
      return (
        `<li class="row">` +
        `<div class="row-lead">` +
        `<span class="row-name">${esc(it.repo)}</span>${own}` +
        `</div>` +
        `<span class="row-count"><span class="num">${esc(num(it.count))}</span>` +
        `<span class="unit">${i18n('commits', '次提交')}</span></span>` +
        `</li>`
      );
    })
    .join('');
  return section('commit', 'Commits', '提交', pill(totals.commits, items.length), `<ul class="list">${rows}</ul>`);
}

function prSection(items, totals) {
  const rows = items
    .map((it) => {
      const title = String(it.title || '').trim() ? it.title : UNTITLED();
      return (
        `<li class="row row-block">` +
        `<div class="row-head">${actionBadge(it.action)}${extLink(it.url, title, 'row-title')}</div>` +
        `<div class="row-meta">${repoSpan(it.repo)}${SEP}<span class="num">#${esc(it.number)}</span>${timeHtml(it.ts)}</div>` +
        `</li>`
      );
    })
    .join('');
  return section('pr', 'Pull requests', 'PR', pill(totals.prs, items.length), `<ul class="list">${rows}</ul>`);
}

function reviewsSection(items, totals) {
  const rows = items
    .map((it) => {
      const title = String(it.title || '').trim() ? it.title : UNTITLED();
      return (
        `<li class="row row-block">` +
        `<div class="row-head">${actionBadge('reviewed')}${extLink(it.url, title, 'row-title')}</div>` +
        `<div class="row-meta">${repoSpan(it.repo)}${SEP}<span class="num">#${esc(it.number)}</span>${timeHtml(it.ts)}</div>` +
        `</li>`
      );
    })
    .join('');
  return section('review', 'Reviews', '评审', pill(totals.reviews, items.length), `<ul class="list">${rows}</ul>`);
}

function issuesSection(items, totals) {
  const rows = items
    .map((it) => {
      const title = String(it.title || '').trim() ? it.title : UNTITLED();
      return (
        `<li class="row row-block">` +
        `<div class="row-head">${actionBadge(it.action)}${extLink(it.url, title, 'row-title')}</div>` +
        `<div class="row-meta">${repoSpan(it.repo)}${SEP}<span class="num">#${esc(it.number)}</span>${timeHtml(it.ts)}</div>` +
        `</li>`
      );
    })
    .join('');
  return section('issue', 'Issues', 'Issue', pill(totals.issues, items.length), `<ul class="list">${rows}</ul>`);
}

function stateChangeBadge(action, actor) {
  const map = {
    closed: { en: 'Closed', zh: '关闭', cls: 'badge-closed' },
    merged: { en: 'Merged', zh: '合并', cls: 'badge-merged' },
    reopened: { en: 'Reopened', zh: '重新打开', cls: 'badge-opened' },
  };
  const m = map[String(action == null ? '' : action).toLowerCase()];
  if (!m) return '';
  const login = String(actor == null ? '' : actor).trim();
  const en = login ? `${m.en} by @${login}` : m.en;
  const zh = login ? `被 @${login} ${m.zh}` : m.zh;
  return `<span class="badge ${m.cls}">${i18n(en, zh)}</span>`;
}

function stateChangesSection(items) {
  const rows = items
    .map((it) => {
      const title = String(it.title || '').trim() ? it.title : UNTITLED();
      return (
        `<li class="row row-block">` +
        `<div class="row-head">${stateChangeBadge(it.action, it.actor)}${extLink(it.url, title, 'row-title')}</div>` +
        `<div class="row-meta">${repoSpan(it.repo)}${SEP}<span class="num">#${esc(it.number)}</span>${timeHtml(it.ts)}</div>` +
        `</li>`
      );
    })
    .join('');
  return section('issue', 'Status changes', '状态变更', pill(items.length, items.length), `<ul class="list">${rows}</ul>`);
}

function releasesSection(items, ai) {
  const keyOf = (repo, tag) => `${String(repo || '')}\u0000${String(tag || '')}`;
  const enNotes = new Map();
  const zhNotes = new Map();
  for (const rn of A(ai && ai.en && ai.en.releaseNotes)) {
    if (rn) enNotes.set(keyOf(rn.repo, rn.tag), rn.summary || '');
  }
  for (const rn of A(ai && ai.zh && ai.zh.releaseNotes)) {
    if (rn) zhNotes.set(keyOf(rn.repo, rn.tag), rn.summary || '');
  }

  const rows = items
    .map((it) => {
      const k = keyOf(it.repo, it.tag);
      const en = enNotes.get(k);
      const zh = zhNotes.get(k);
      const aiNote =
        (en && String(en).trim()) || (zh && String(zh).trim())
          ? `<p class="ai-note"><span class="ai-tag">AI</span> ${i18n(en, zh)}</p>`
          : '';
      const notes = String(it.notes || '').trim()
        ? `<p class="release-notes">${mdInlineToHtml(it.notes)}</p>`
        : '';
      const title = String(it.name || '').trim() ? it.name : it.tag || UNTITLED();
      return (
        `<li class="release">` +
        `<div class="release-head">` +
        `<span class="release-tag">${esc(it.tag || '')}</span>` +
        `${extLink(it.url, title, 'release-title')}` +
        `${dateHtml(it.publishedAt)}` +
        `</div>` +
        `<div class="row-meta">${repoSpan(it.repo)}</div>` +
        `${notes}${aiNote}` +
        `</li>`
      );
    })
    .join('');
  return section('release', 'Releases', '发布', pill(items.length, items.length), `<ul class="list">${rows}</ul>`);
}

function starsSection(items) {
  const rows = items
    .map((it) => {
      const hasDelta = it.delta !== null && it.delta !== undefined;
      const delta = hasDelta ? `+${esc(num(it.delta))}` : '—';
      const deltaCls = hasDelta ? 'delta' : 'delta delta-none';
      return (
        `<li class="row">` +
        `<div class="row-lead"><span class="row-name">${esc(it.repo)}</span></div>` +
        `<span class="row-count"><span class="${deltaCls}">${delta}</span>` +
        `<span class="unit">★ ${esc(num(it.total))}</span></span>` +
        `</li>`
      );
    })
    .join('');
  return section('star', 'Stars', '标星', pill(items.length, items.length), `<ul class="list">${rows}</ul>`);
}

function repliesSection(items) {
  const kindLabel = (kind) => {
    const k = String(kind == null ? '' : kind).toLowerCase();
    if (k === 'review') return { en: 'Review', zh: '评审' };
    if (k === 'comment' || k === 'issue_comment') return { en: 'Comment', zh: '评论' };
    if (k) return { en: kind, zh: kind };
    return null;
  };
  const rows = items
    .map((it) => {
      const k = kindLabel(it.kind);
      const chip = k ? `<span class="chip chip-kind">${i18n(k.en, k.zh)}</span>` : '';
      const title = String(it.title || '').trim() ? it.title : UNTITLED();
      const excerpt = String(it.excerpt || '').trim()
        ? `<p class="excerpt">${mdInlineToHtml(it.excerpt)}</p>`
        : '';
      return (
        `<li class="reply">` +
        `<div class="reply-head">` +
        `<span class="author">@${esc(it.author || 'unknown')}</span>${chip}` +
        `${extLink(it.url, title, 'reply-title')}` +
        `</div>` +
        `${excerpt}` +
        `<div class="row-meta">${repoSpan(it.repo)}${SEP}<span class="num">#${esc(it.number)}</span>${timeHtml(it.ts)}</div>` +
        `</li>`
      );
    })
    .join('');
  return section('reply', 'Replies', '回复', pill(items.length, items.length), `<ul class="list">${rows}</ul>`);
}

function statsStrip(totals) {
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

function aiSummaryBlock(ai) {
  const badge = `<span class="ai-badge">${icon('spark')}${i18n('AI summary', 'AI 摘要')}</span>`;
  if (!ai || typeof ai !== 'object') {
    return (
      `<section class="card ai">` +
      `<div class="ai-top">${badge}</div>` +
      `<p class="ai-unavailable">${i18n(
        'AI summary temporarily unavailable.',
        'AI 摘要暂不可用。'
      )}</p>` +
      `</section>`
    );
  }
  const en = ai.en && typeof ai.en === 'object' ? ai.en : {};
  const zh = ai.zh && typeof ai.zh === 'object' ? ai.zh : {};
  const headline = i18n(en.headline, zh.headline);
  const summary = i18n(en.summary, zh.summary);
  const hasHeadline = String(en.headline || zh.headline || '').trim() !== '';
  const hasSummary = String(en.summary || zh.summary || '').trim() !== '';
  return (
    `<section class="card ai">` +
    `<div class="ai-top">${badge}</div>` +
    (hasHeadline ? `<h2 class="ai-headline">${headline}</h2>` : '') +
    (hasSummary ? `<p class="ai-summary">${summary}</p>` : '') +
    (hasHeadline || hasSummary
      ? ''
      : `<p class="ai-unavailable">${i18n(
          'AI summary temporarily unavailable.',
          'AI 摘要暂不可用。'
        )}</p>`) +
    `</section>`
  );
}

function emptyState() {
  return (
    `<section class="card empty-card">` +
    `<div class="empty-art">${icon('moon')}</div>` +
    `<h2 class="empty-title">${i18n('A quiet day', '安静的一天')}</h2>` +
    `<p class="empty-sub">${i18n(
      'No public commits, pull requests, issues, reviews, releases, stars or replies were recorded in this window.',
      '该时间窗口内没有记录到公开的提交、PR、Issue、评审、发布、标星或回复。'
    )}</p>` +
    `</section>`
  );
}

function footerBlock(generatedAt) {
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
    `<span>${i18n('Data from GitHub public activity.', '数据来自 GitHub 公开活动。')}</span>` +
    (when ? `<span class="foot-gen">${i18n('Generated', '生成于')} ${when}</span>` : '') +
    `</footer>`
  );
}

// ---------------------------------------------------------------- document shell

const LANG_BOOTSTRAP =
  "try{var l=localStorage.getItem('gh-report-lang');" +
  "if(l==='zh'||l==='en'){document.documentElement.setAttribute('data-lang',l);" +
  "document.documentElement.lang=(l==='zh')?'zh-CN':'en';}}catch(e){}";

const TOGGLE_SCRIPT =
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

const STAGGER = Array.from({ length: 14 }, (_, i) =>
  `.wrap > *:nth-child(${i + 1}){animation-delay:${(i * 0.045).toFixed(3)}s}`
).join('\n');

const PAGE_STYLE = `
:root{
  color-scheme:light dark;
  --surface:#FEF7FF;
  --surface-dim:#F3EDF7;
  --card:#FFFFFF;
  --on-surface:#1D1B20;
  --on-surface-variant:#49454F;
  --outline:#79747E;
  --outline-variant:#CAC4D0;
  --primary:#6750A4;
  --on-primary:#FFFFFF;
  --primary-container:#EADDFF;
  --on-primary-container:#21005D;
  --secondary-container:#E8DEF8;
  --on-secondary-container:#1D1B20;
  --tertiary-container:#FFD8E4;
  --on-tertiary-container:#31111D;
  --ok:#386A20;
  --ok-container:#C6EFA6;
  --on-ok-container:#0E2A05;
  --err:#B3261E;
  --err-container:#FFDAD6;
  --on-err-container:#410002;
  --aura:rgba(103,80,164,.12);
  --shadow:0 1px 2px rgba(0,0,0,.05);
  --font:${FONT_STACK};
  --mono:${MONO_STACK};
}
@media (prefers-color-scheme: dark){
  :root{
    --surface:#141218;
    --surface-dim:#211F26;
    --card:#1D1B20;
    --on-surface:#E6E0E9;
    --on-surface-variant:#CAC4D0;
    --outline:#938F99;
    --outline-variant:#49454F;
    --primary:#D0BCFF;
    --on-primary:#381E72;
    --primary-container:#4F378B;
    --on-primary-container:#EADDFF;
    --secondary-container:#4A4458;
    --on-secondary-container:#E8DEF8;
    --tertiary-container:#633B48;
    --on-tertiary-container:#FFD8E4;
    --ok:#A6D98A;
    --ok-container:#2C4A22;
    --on-ok-container:#C8F0B0;
    --err:#F2B8B5;
    --err-container:#8C1D18;
    --on-err-container:#FFDAD6;
    --aura:rgba(208,188,255,.10);
    --shadow:0 1px 2px rgba(0,0,0,.35);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  font-family:var(--font);
  font-size:16px;
  line-height:1.6;
  color:var(--on-surface);
  background:var(--surface);
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
.wrap{max-width:820px;margin:0 auto;padding:clamp(20px,5vw,40px) clamp(16px,4vw,28px) 72px}
a{color:var(--primary);text-decoration:none}
a:focus-visible,button:focus-visible{outline:2px solid var(--primary);outline-offset:2px;border-radius:8px}
.mono{font-family:var(--mono)}
.num{font-variant-numeric:tabular-nums}

.i18n[data-lang]{display:inline}
html[data-lang="en"] .i18n[data-lang="zh"],
html[data-lang="zh"] .i18n[data-lang="en"]{display:none}

/* ---- top bar + language toggle ---- */
.topbar{display:flex;align-items:center;gap:12px;margin-bottom:clamp(24px,5vw,40px)}
.topbar .langtoggle{margin-left:auto}
.back{
  display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:8px 14px;
  border-radius:999px;font-size:.86rem;font-weight:650;color:var(--on-surface-variant);
  transition:background .18s ease,color .18s ease;
}
.back:hover{background:var(--surface-dim);color:var(--on-surface)}
.langtoggle{
  display:inline-flex;gap:2px;padding:3px;border-radius:999px;
  background:var(--surface-dim);border:1px solid var(--outline-variant);
}
.langbtn{
  appearance:none;border:0;background:transparent;color:var(--on-surface-variant);
  font:inherit;font-size:.82rem;font-weight:700;letter-spacing:.02em;
  min-height:34px;padding:6px 15px;border-radius:999px;cursor:pointer;
  transition:background .18s ease,color .18s ease;
}
.langbtn:hover{color:var(--on-surface)}
html[data-lang="en"] .langbtn[data-set-lang="en"],
html[data-lang="zh"] .langbtn[data-set-lang="zh"]{
  background:var(--primary);color:var(--on-primary);
}
.topbar-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.topbar-right .langtoggle{margin-left:0}
.ghbtn{
  display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:8px 14px;
  border-radius:999px;border:1px solid var(--outline-variant);background:transparent;
  font-size:.86rem;font-weight:650;line-height:1;color:var(--on-surface-variant);
  transition:background .18s ease,color .18s ease,border-color .18s ease;
}
.ghbtn:hover{background:var(--surface-dim);color:var(--on-surface);border-color:var(--outline)}
.ghbtn svg{width:17px;height:17px;flex:none;display:block}

/* ---- hero ---- */
.hero{margin-bottom:clamp(22px,4vw,32px)}
.eyebrow{
  margin:0 0 10px;font-size:.76rem;font-weight:800;letter-spacing:.16em;
  text-transform:uppercase;color:var(--primary);
}
h1{margin:0;font-size:clamp(2rem,7vw,3rem);line-height:1.04;letter-spacing:-.025em;font-weight:800}
.hero-sub{margin:12px 0 0;color:var(--on-surface-variant);font-size:.94rem;display:flex;flex-wrap:wrap;gap:6px;align-items:center}

/* ---- cards ---- */
.card{
  background:var(--card);border:1px solid var(--outline-variant);border-radius:18px;
  padding:clamp(18px,3.5vw,24px);margin:0 0 16px;box-shadow:var(--shadow);
}
.sec-head{display:flex;align-items:center;gap:12px}
.sec-icon{
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:36px;height:36px;border-radius:12px;
  background:var(--primary-container);color:var(--on-primary-container);
}
.sec-icon svg{width:20px;height:20px}
.sec-title{margin:0;font-size:1.02rem;font-weight:750;letter-spacing:-.01em}
.pill{
  margin-left:auto;font-size:.78rem;font-weight:800;font-variant-numeric:tabular-nums;
  min-width:2em;text-align:center;padding:.16em .6em;border-radius:999px;
  background:var(--secondary-container);color:var(--on-secondary-container);
}

/* ---- stat strip ---- */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 16px}
.stat{background:var(--card);border:1px solid var(--outline-variant);border-radius:16px;padding:15px 15px 13px;box-shadow:var(--shadow)}
.stat-num{font-size:clamp(1.5rem,5vw,1.95rem);font-weight:800;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat-label{margin-top:7px;font-size:.75rem;font-weight:700;color:var(--on-surface-variant);letter-spacing:.01em}

/* ---- lists ---- */
.list{list-style:none;margin:14px 0 0;padding:0}
.list > li{padding:15px 2px}
.list > li + li{border-top:1px solid var(--outline-variant)}
.row{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
.row-block{display:block}
.row-lead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.row-name{font-family:var(--mono);font-size:.88rem;font-weight:650;overflow-wrap:anywhere}
.row-head{display:flex;flex-wrap:wrap;align-items:center;gap:9px;min-width:0}
.row-title,.reply-title,.release-title{font-weight:650;color:var(--on-surface)}
.row-meta{margin-top:7px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:.8rem;color:var(--on-surface-variant)}
.row-count{display:inline-flex;align-items:baseline;gap:7px;white-space:nowrap;font-variant-numeric:tabular-nums}
.row-count .num{font-size:1.05rem;font-weight:800;color:var(--on-surface)}
.unit{font-size:.75rem;font-weight:700;color:var(--on-surface-variant)}
.repo{font-family:var(--mono);font-size:.8rem}
.time{font-variant-numeric:tabular-nums;font-size:.78rem;white-space:nowrap}
.dot{color:var(--outline);padding:0 1px}

.link{color:inherit;text-decoration:underline;text-decoration-color:var(--outline);text-underline-offset:3px;transition:color .15s ease,text-decoration-color .15s ease}
.link:hover{color:var(--primary);text-decoration-color:var(--primary)}

/* ---- chips + badges ---- */
.chip{font-size:.7rem;font-weight:750;letter-spacing:.02em;padding:.2em .55em;border-radius:999px;white-space:nowrap}
.chip-own{background:var(--primary-container);color:var(--on-primary-container)}
.chip-ext{background:var(--surface-dim);color:var(--on-surface-variant);border:1px solid var(--outline-variant)}
.chip-kind{background:var(--secondary-container);color:var(--on-secondary-container)}
.badge{
  display:inline-flex;align-items:center;flex:none;
  font-size:.68rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  padding:.28em .62em;border-radius:999px;white-space:nowrap;
}
.badge-opened{background:var(--primary-container);color:var(--on-primary-container)}
.badge-merged{background:var(--ok-container);color:var(--on-ok-container)}
.badge-closed{background:var(--err-container);color:var(--on-err-container)}
.badge-commented,.badge-reviewed{background:var(--secondary-container);color:var(--on-secondary-container)}

/* ---- releases ---- */
.release-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.release-tag{
  font-family:var(--mono);font-size:.75rem;font-weight:750;
  background:var(--tertiary-container);color:var(--on-tertiary-container);
  padding:.22em .6em;border-radius:9px;
}
.release-notes{
  margin:12px 0 0;font-size:.9rem;color:var(--on-surface-variant);
  white-space:pre-wrap;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden;
}
.ai-note{
  margin:12px 0 0;padding:10px 13px;border-radius:12px;font-size:.88rem;
  background:var(--primary-container);color:var(--on-primary-container);
}
.ai-tag{font-size:.66rem;font-weight:800;letter-spacing:.1em;margin-right:8px;opacity:.85}

/* ---- replies ---- */
.reply-head{display:flex;flex-wrap:wrap;align-items:center;gap:9px}
.author{font-family:var(--mono);font-size:.86rem;font-weight:750;color:var(--primary)}
.excerpt{
  margin:10px 0 0;padding:2px 0 2px 14px;border-left:3px solid var(--outline-variant);
  color:var(--on-surface-variant);font-size:.9rem;white-space:pre-wrap;overflow-wrap:anywhere;
}
.excerpt code,.release-notes code{
  font-family:var(--mono);font-size:.86em;padding:.12em .42em;border-radius:6px;
  background:var(--surface-dim);color:var(--on-surface);overflow-wrap:anywhere;
}
.excerpt strong,.release-notes strong{color:var(--on-surface);font-weight:750}
.excerpt em,.release-notes em{font-style:italic}
.excerpt a,.release-notes a{text-decoration:underline;text-underline-offset:2px}

/* ---- AI block ---- */
.card.ai{
  border:1px solid transparent;
  background:
    linear-gradient(var(--card),var(--card)) padding-box,
    linear-gradient(135deg,var(--primary-container),var(--tertiary-container)) border-box;
}
.ai-top{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.ai-badge{
  display:inline-flex;align-items:center;gap:8px;
  font-size:.73rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--primary);
}
.ai-badge svg{width:16px;height:16px}
.ai-headline{margin:0 0 8px;font-size:clamp(1.15rem,3.6vw,1.5rem);line-height:1.25;font-weight:800;letter-spacing:-.015em}
.ai-summary{margin:0;font-size:.98rem;color:var(--on-surface-variant)}
.ai-unavailable{
  margin:0;display:flex;align-items:center;gap:10px;
  background:var(--surface-dim);border:1px dashed var(--outline);
  color:var(--on-surface-variant);border-radius:12px;padding:14px 16px;font-size:.92rem;font-weight:650;
}

/* ---- empty + footer ---- */
.empty-card{text-align:center;padding:clamp(30px,7vw,52px)}
.empty-art{color:var(--primary);opacity:.9;margin-bottom:12px}
.empty-art svg{width:54px;height:54px}
.empty-title{margin:0 0 10px;font-size:1.25rem;font-weight:800}
.empty-sub{margin:0 auto;max-width:36em;color:var(--on-surface-variant);font-size:.95rem}
.foot{
  margin-top:30px;padding-top:18px;border-top:1px solid var(--outline-variant);
  display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;
  color:var(--on-surface-variant);font-size:.8rem;
}
.foot time{font-variant-numeric:tabular-nums}

/* ---- index archive ---- */
.daylist{list-style:none;margin:0 0 16px;padding:0;background:var(--card);border:1px solid var(--outline-variant);border-radius:18px;overflow:hidden;box-shadow:var(--shadow)}
.day{display:flex;gap:18px;align-items:baseline;padding:16px clamp(16px,3.5vw,22px);border-top:1px solid var(--outline-variant);color:inherit;transition:background .16s ease}
.daylist > li:first-child .day{border-top:0}
.day:hover{background:var(--surface-dim)}
.day-date{font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;letter-spacing:-.01em;flex:none}
.day-head{color:var(--on-surface-variant);font-size:.92rem;min-width:0;overflow-wrap:anywhere}
.day-head-empty{font-style:italic;opacity:.8}
.day-plain{color:var(--on-surface-variant)}

/* ---- motion ---- */
@media (prefers-reduced-motion: no-preference){
  .wrap > *{animation:rise .5s cubic-bezier(.2,.7,.3,1) both}
${STAGGER}
}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){
  *{animation:none !important;transition:none !important}
}

/* ---- responsive ---- */
@media (max-width:560px){
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .day{flex-direction:column;gap:4px}
  .row{gap:12px}
}
@media (max-width:400px){
  .ghbtn{padding:8px 11px}
  .ghbtn-label{display:none}
}
`;

function htmlDoc({ title, body }) {
  return `<!doctype html>
<html lang="en" data-lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<script>${LANG_BOOTSTRAP}</script>
<style>${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------- report page

export function renderReportPage({ data, ai } = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const totals = d.totals && typeof d.totals === 'object' ? d.totals : {};

  const date = d.date || d.windowEnd || '';
  const username = d.username || '';
  const user = String(username == null ? '' : username).trim();
  const generatedAt = d.generatedAt || '';

  const commits = A(d.commits).filter(Boolean);
  const pullRequests = A(d.pullRequests).filter(Boolean);
  const reviews = A(d.reviews).filter(Boolean);
  const issues = A(d.issues).filter(Boolean);
  const stateChanges = A(d.stateChanges).filter(Boolean);
  const releases = A(d.releases).filter(Boolean);
  const stars = A(d.stars).filter(Boolean);
  const replies = A(d.replies).filter(Boolean);

  const empty = d.empty === true;
  const dateLabel = fmtDate(date);

  const parts = [];

  // top bar
  parts.push(
    `<div class="topbar">` +
      `<a class="back" href="../index.html">${i18n('← All reports', '← 全部日报')}</a>` +
      topbarRight(user) +
      `</div>`
  );

  // hero
  const subBits = [];
  if (username) subBits.push(`<span class="mono">@${esc(username)}</span>`);
  const win = windowLabel(date, generatedAt);
  if (win) subBits.push(i18n(win.en, win.zh));
  parts.push(
    `<header class="hero">` +
      `<p class="eyebrow">${
        user
          ? i18n(`${user} · Daily GitHub activity`, `${user} 的 GitHub 每日动态`)
          : i18n('Daily GitHub activity', 'GitHub 每日动态')
      }</p>` +
      `<h1>${i18n(dateLabel.en, dateLabel.zh)}</h1>` +
      (subBits.length ? `<p class="hero-sub">${subBits.join(SEP)}</p>` : '') +
      `</header>`
  );

  // AI summary（空白天由空状态卡承担，不再单独渲染 AI 卡）
  if (!empty) parts.push(aiSummaryBlock(ai));

  // body
  const anyItems =
    commits.length || pullRequests.length || reviews.length || issues.length ||
    stateChanges.length || releases.length || stars.length || replies.length;

  if (empty) {
    parts.push(emptyState());
  } else {
    parts.push(statsStrip(totals));
    if (commits.length) parts.push(commitsSection(commits, totals));
    if (pullRequests.length) parts.push(prSection(pullRequests, totals));
    if (reviews.length) parts.push(reviewsSection(reviews, totals));
    if (issues.length) parts.push(issuesSection(issues, totals));
    if (stateChanges.length) parts.push(stateChangesSection(stateChanges));
    if (releases.length) parts.push(releasesSection(releases, ai));
    if (stars.length) parts.push(starsSection(stars));
    if (replies.length) parts.push(repliesSection(replies));
    if (!anyItems) parts.push(emptyState());
  }

  parts.push(footerBlock(generatedAt));

  const body =
    `<div class="wrap">\n${parts.join('\n')}\n</div>\n` +
    `<script>${TOGGLE_SCRIPT}</script>`;

  const title = `GitHub activity · ${date || 'daily report'}`;
  return htmlDoc({ title, body });
}

// ---------------------------------------------------------------- index page

export function renderIndexPage({ days, generatedAt, username } = {}) {
  const list = A(days).slice(0, 60);
  const user = username == null ? '' : String(username).trim();

  const rows = list
    .map((day) => {
      const entry = day && typeof day === 'object' ? day : {};
      const dateLabel = fmtDateShort(entry.date);
      const href = safeHref(entry.url);
      const hasHead =
        String(entry.headline_en || '').trim() !== '' ||
        String(entry.headline_zh || '').trim() !== '';
      const head =
        entry.empty === true
          ? `<span class="day-head day-head-empty">${i18n('A quiet day', '安静的一天')}</span>`
          : hasHead
            ? `<span class="day-head">${i18n(entry.headline_en, entry.headline_zh)}</span>`
            : `<span class="day-head day-head-empty">${i18n('Report available', '日报已生成')}</span>`;
      const inner =
        `<span class="day-date">${i18n(dateLabel.en, dateLabel.zh)}</span>${head}`;
      if (href) return `<li><a class="day" href="${esc(href)}">${inner}</a></li>`;
      return `<li><span class="day day-plain">${inner}</span></li>`;
    })
    .join('');

  const body =
    `<div class="wrap">\n` +
    `<div class="topbar">${topbarRight(user)}</div>\n` +
    `<header class="hero">` +
    `<h1>${
      user
        ? i18n(`${user} · Daily GitHub activity`, `${user} 的 GitHub 每日动态`)
        : i18n('Daily GitHub activity', 'GitHub 每日动态')
    }</h1>` +
    `<p class="hero-sub">${i18n(
      'One report per day, newest first.',
      '每日一份报告，最新在前。'
    )}</p>` +
    `</header>\n` +
    (list.length
      ? `<ul class="daylist">\n${rows}\n</ul>\n`
      : `<section class="card empty-card"><p class="empty-sub">${i18n(
          'No reports yet.',
          '暂无日报。'
        )}</p></section>\n`) +
    `${footerBlock(generatedAt)}\n` +
    `</div>\n` +
    `<script>${TOGGLE_SCRIPT}</script>`;

  return htmlDoc({ title: 'Daily GitHub activity', body });
}

// ---------------------------------------------------------------- markdown

export function renderMarkdown({ data, ai } = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const totals = d.totals && typeof d.totals === 'object' ? d.totals : {};
  const date = d.date || d.windowEnd || '';
  const out = [];

  out.push(`# GitHub activity — ${mdInline(date) || 'daily report'}`);
  out.push('');

  const metaBits = [];
  if (d.username) metaBits.push(`@${mdInline(d.username)}`);
  const win = windowLabel(d.date, d.generatedAt);
  if (win) metaBits.push(mdInline(win.en));
  if (d.generatedAt) metaBits.push(`generated ${mdInline(d.generatedAt)}`);
  if (metaBits.length) {
    out.push(`_${metaBits.join(' · ')}_`);
    out.push('');
  }

  // AI summary
  out.push('## AI summary');
  out.push('');
  if (ai && typeof ai === 'object') {
    const en = ai.en && typeof ai.en === 'object' ? ai.en : {};
    const wrote = [];
    if (String(en.headline || '').trim()) wrote.push(`**${mdInline(en.headline)}**`);
    if (String(en.summary || '').trim()) wrote.push(mdInline(en.summary));
    if (wrote.length) {
      for (const w of wrote) {
        out.push(w);
        out.push('');
      }
    } else {
      out.push('_AI summary temporarily unavailable._');
      out.push('');
    }
  } else {
    out.push('_AI summary temporarily unavailable._');
    out.push('');
  }

  if (d.empty === true) {
    out.push('No public GitHub activity in this window.');
    out.push('');
    return `${out.join('\n').replace(/\n+$/, '')}\n`;
  }

  // totals
  out.push('## Totals');
  out.push('');
  out.push(`- Commits: ${num(totals.commits)}`);
  out.push(`- Pull requests: ${num(totals.prs)}`);
  out.push(`- Issues: ${num(totals.issues)}`);
  out.push(`- Reviews: ${num(totals.reviews)}`);
  out.push('');

  // commits
  const commits = A(d.commits).filter(Boolean);
  if (commits.length) {
    out.push('## Commits');
    out.push('');
    for (const c of commits) {
      const count = num(c.count);
      out.push(
        `- \`${mdInline(c.repo)}\` — ${count} commit${count === 1 ? '' : 's'}${c.own ? ' (owned)' : ''}`
      );
    }
    out.push('');
  }

  // pull requests
  const prs = A(d.pullRequests).filter(Boolean);
  if (prs.length) {
    out.push('## Pull requests');
    out.push('');
    for (const p of prs) {
      const action = String(p.action || '').toLowerCase();
      const label = action ? `**${mdInline(action[0].toUpperCase() + action.slice(1))}** ` : '';
      out.push(`- ${label}${mdLink(p.title || '(untitled)', p.url)} — \`${mdInline(p.repo)}#${mdInline(p.number)}\``);
    }
    out.push('');
  }

  // reviews
  const reviews = A(d.reviews).filter(Boolean);
  if (reviews.length) {
    out.push('## Reviews');
    out.push('');
    for (const r of reviews) {
      out.push(`- **Reviewed** ${mdLink(r.title || '(untitled)', r.url)} — \`${mdInline(r.repo)}#${mdInline(r.number)}\``);
    }
    out.push('');
  }

  // issues
  const issues = A(d.issues).filter(Boolean);
  if (issues.length) {
    out.push('## Issues');
    out.push('');
    for (const it of issues) {
      const action = String(it.action || '').toLowerCase();
      const label = action ? `**${mdInline(action[0].toUpperCase() + action.slice(1))}** ` : '';
      out.push(`- ${label}${mdLink(it.title || '(untitled)', it.url)} — \`${mdInline(it.repo)}#${mdInline(it.number)}\``);
    }
    out.push('');
  }

  // releases
  const releases = A(d.releases).filter(Boolean);
  if (releases.length) {
    const keyOf = (repo, tag) => `${String(repo || '')}\u0000${String(tag || '')}`;
    const aiNotes = new Map();
    for (const rn of A(ai && ai.en && ai.en.releaseNotes)) {
      if (rn) aiNotes.set(keyOf(rn.repo, rn.tag), rn.summary || '');
    }
    out.push('## Releases');
    out.push('');
    for (const r of releases) {
      out.push(`- \`${mdInline(r.tag)}\` ${mdLink(r.name || r.tag, r.url)} — \`${mdInline(r.repo)}\``);
      const note = String(r.notes || '').trim();
      if (note) {
        for (const line of note.split(/\r?\n/)) out.push(`  > ${mdInline(line)}`);
      }
      const aiNote = aiNotes.get(keyOf(r.repo, r.tag));
      if (aiNote && String(aiNote).trim()) {
        out.push(`  > **AI:** ${mdInline(aiNote)}`);
      }
    }
    out.push('');
  }

  // stars
  const stars = A(d.stars).filter(Boolean);
  if (stars.length) {
    out.push('## Stars');
    out.push('');
    for (const s of stars) {
      const delta =
        s.delta === null || s.delta === undefined ? '—' : `+${num(s.delta)}`;
      out.push(`- \`${mdInline(s.repo)}\` — ${delta} (${num(s.total)} total)`);
    }
    out.push('');
  }

  // replies
  const replies = A(d.replies).filter(Boolean);
  if (replies.length) {
    out.push('## Replies');
    out.push('');
    for (const r of replies) {
      const kind = String(r.kind || '').trim();
      const kindSuffix = kind ? ` _(${mdInline(kind)})_` : '';
      const excerpt = String(r.excerpt || '').trim()
        ? ` — “${mdInline(r.excerpt)}”`
        : '';
      out.push(
        `- **@${mdInline(r.author || 'unknown')}** on ${mdLink(r.title || '(untitled)', r.url)}` +
          ` — \`${mdInline(r.repo)}#${mdInline(r.number)}\`${kindSuffix}${excerpt}`
      );
    }
    out.push('');
  }

  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}
