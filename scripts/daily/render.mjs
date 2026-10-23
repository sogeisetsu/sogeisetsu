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

import { sanitizeReason } from './lib/ai/prose.mjs';
import { hasVisibleActivity } from '../lib/domain.mjs';
import { pageStyle } from '../site/css.mjs';

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
 * Render the AI-summary inline subset, and ONLY that: inline code (`code`) and
 * bold (`**bold**`). Everything else — italic, links, block markers — is left
 * literal. The string is HTML-escaped first, so raw HTML can never survive;
 * backtick spans are stashed so bold never rewrites code contents. Regexes are
 * bounded so a stray `**` or backtick cannot swallow the rest of the paragraph.
 */
export function aiInlineToHtml(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`\n]+?)`/g, (_m, code) => {
    codes.push(code);
    return `\uE000${codes.length - 1}\uE001`;
  });
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\uE000(\d+)\uE001/g, (_m, i) => `<code>${codes[Number(i)] || ''}</code>`);
  return s;
}

/**
 * A GFM table delimiter row: `|---|---|`, `:-- | --:`, `| :-: |`. Dashes are
 * mandatory, so a plain `---` horizontal rule does not qualify on its own —
 * the caller also requires a header row with the same cell count.
 */
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Split one markdown table row into raw (still unescaped) cell strings. A `|`
 * escaped as `\|` and a `|` inside a backtick code span are content, not
 * separators; a leading / trailing `|` is a border and yields no cell.
 */
function splitTableRow(line) {
  const s = String(line == null ? '' : line).trim();
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (/^\|/.test(s) && cells.length && !cells[0].trim()) cells.shift();
  if (/\|$/.test(s) && cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((c) => c.trim());
}

/** Column alignments from a delimiter row, or null when it is not one. */
function tableAligns(line) {
  if (!TABLE_DELIM_RE.test(String(line == null ? '' : line))) return null;
  return splitTableRow(line).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return '';
  });
}

/**
 * Render a parsed table. Cells go through mdInlineToHtml (escaped first, so no
 * raw HTML survives); `\|` becomes a literal pipe. Alignment comes from the
 * delimiter row keywords only, never from cell text.
 */
function tableToHtml(aligns, header, rows) {
  const cols = header.length;
  const cell = (tag, text, align) => {
    const style = align ? ` style="text-align:${align}"` : '';
    return `<${tag}${style}>${mdInlineToHtml(String(text).replace(/\\\|/g, '|'))}</${tag}>`;
  };
  const rowHtml = (cells, tag) => {
    const padded = cells.slice(0, cols);
    while (padded.length < cols) padded.push('');
    return `<tr>${padded.map((c, k) => cell(tag, c, aligns[k])).join('')}</tr>`;
  };
  const head = `<thead>${rowHtml(header, 'th')}</thead>`;
  const body = rows.length ? `<tbody>${rows.map((r) => rowHtml(r, 'td')).join('')}</tbody>` : '';
  return `<table>${head}${body}</table>`;
}

/**
 * Render a bounded BLOCK-level markdown subset for UNTRUSTED release notes:
 * ATX headings (`#`..`######`), unordered lists (`-`/`*`/`+`), ordered lists,
 * fenced code blocks, GFM pipe tables, and paragraphs. Every line is escaped
 * first (via mdInlineToHtml), so raw HTML never survives; only a whitelist of
 * block markers is expanded. Output is clamped so a long release body stays
 * compact.
 */
export function mdBlockToHtml(text, maxChars = 1400) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!raw) return '';
  const src = raw.length > maxChars ? `${raw.slice(0, maxChars).trimEnd()} …` : raw;
  const lines = src.split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul'|'ol', items: string[] }
  let fence = null; // string[] | null
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = null;
      } else {
        fence.push(esc(line));
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      fence = [];
      continue;
    }
    // GFM pipe table: a header row with `|`, a delimiter row whose column
    // count matches, then body rows up to the first blank / pipe-less line.
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = tableAligns(lines[i + 1]);
      const header = aligns ? splitTableRow(line) : null;
      if (aligns && header.length === aligns.length) {
        flushPara();
        flushList();
        const body = [];
        let j = i + 2;
        for (; j < lines.length; j++) {
          const row = lines[j];
          if (!row.trim() || !row.includes('|')) break;
          body.push(splitTableRow(row));
        }
        out.push(tableToHtml(aligns, header, body));
        i = j - 1;
        continue;
      }
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(2 + heading[1].length, 6); // # → h3 … ##### 及以上 → h6
      out.push(`<h${level}>${mdInlineToHtml(heading[2].trim())}</h${level}>`);
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const tag = /^\s*\d+[.)]/.test(line) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(mdInlineToHtml(item[1].trim()));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(mdInlineToHtml(line.trim()));
  }
  if (fence !== null) out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  flushPara();
  flushList();
  return out.join('');
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
  const { hh, mm } = utc8(t);
  return `${hh}:${mm} · UTC+8`;
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
export function i18n(en, zh) {
  const a = en == null ? '' : String(en);
  const b = zh == null || zh === '' ? a : String(zh);
  if (a === b) return esc(a);
  return (
    `<span class="i18n" data-lang="en">${esc(a)}</span>` +
    `<span class="i18n" data-lang="zh">${esc(b)}</span>`
  );
}

/**
 * Like `i18n`, but renders each side through `aiInlineToHtml` so the AI-summary
 * inline subset (`code`, **bold**) survives. Used for the release AI note.
 */
export function i18nInline(en, zh) {
  const a = en == null ? '' : String(en);
  const b = zh == null || zh === '' ? a : String(zh);
  if (a === b) return aiInlineToHtml(a);
  return (
    `<span class="i18n" data-lang="en">${aiInlineToHtml(a)}</span>` +
    `<span class="i18n" data-lang="zh">${aiInlineToHtml(b)}</span>`
  );
}

const UNTITLED = () => i18n('(untitled)', '(无标题)');

/**
 * Split prose into display paragraphs. `zh` splits after each CJK terminator
 * (。！？), keeping it attached; other languages split on `[.!?]` only when an
 * uppercase letter / digit / quote / bracket follows, so `v1.3.0`, `file.mjs`
 * and `e.g.` stay intact. Newlines are hard breaks; blank input yields [].
 */
export function splitParagraphs(text, lang) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!src.trim()) return [];
  const out = [];
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts =
      lang === 'zh'
        ? line.match(/[^。！？]*[。！？]|[^。！？]+/g) || [line]
        : line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out.length ? out : [src.trim()];
}

// ---------------------------------------------------------------- fragments

export const SEP = '<span class="dot">·</span>';

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

/**
 * Badge for an issue/PR row: prefer the item's end-of-window `state`
 * (open|closed|merged), falling back to its original `action` (e.g. commented).
 */
function statusBadge(it) {
  const state = String(it && it.state != null ? it.state : '').toLowerCase();
  if (state === 'open') return actionBadge('opened');
  if (state === 'closed') return actionBadge('closed');
  if (state === 'merged') return actionBadge('merged');
  return actionBadge(it && it.action);
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
export function topbarRight(username) {
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

// ---------------------------------------------------------------- sections

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

/**
 * Notice for a section whose collection hit an artificial cap (so items may be
 * missing). `key` is the data-section name; `cascadeFromTargets` also flags a
 * section whose per-item scan only covered the first N authored targets.
 * Returns '' when nothing was truncated, so callers can append unconditionally.
 */
function truncationNotice(t, key, cascadeFromTargets) {
  const sec = t && typeof t === 'object' && t[key] && typeof t[key] === 'object' ? t[key] : null;
  const ownHit = Boolean(sec && sec.hits === true);
  const cascadeHit = Boolean(cascadeFromTargets && t && t.targets && t.targets.hits === true);
  if (!ownHit && !cascadeHit) return '';
  const cap = ownHit && Number.isFinite(Number(sec.cap)) ? Number(sec.cap) : null;
  const en =
    cap != null
      ? `Some items may be missing — a collection limit (${cap}) was reached.`
      : 'Some items may be missing — a collection limit was reached.';
  const zh =
    cap != null
      ? `可能有遗漏——采集触及上限（${cap}）。`
      : '可能有遗漏——采集触及上限。';
  return `<p class="trunc-notice">${i18n(en, zh)}</p>`;
}

function commitsSection(items, totals) {
  const rows = items
    .map((it) => {
      const own = it.own
        ? `<span class="chip chip-own">${i18n('Owned', '自有')}</span>`
        : `<span class="chip chip-ext">${i18n('External', '外部')}</span>`;
      const messages = A(it.messages)
        .map((m) => (m && typeof m === 'object' ? m.message : m))
        .map((m) => String(m == null ? '' : m).trim())
        .filter(Boolean);
      const msgList = messages.length
        ? `<ul class="commit-msgs">` +
          messages.map((msg) => `<li class="commit-msg">${esc(msg)}</li>`).join('') +
          `</ul>`
        : '';
      const autoCount = num(it.automated);
      const bots = A(it.automatedBots)
        .map((b) => String(b == null ? '' : b).trim())
        .filter(Boolean)
        .map((b) => `@${b}`);
      const enWord = autoCount === 1 ? 'commit' : 'commits';
      const en = bots.length
        ? `${autoCount} automated ${enWord} by ${bots.join(', ')} · not counted in the total`
        : `${autoCount} automated ${enWord} · not counted in the total`;
      const zh = bots.length
        ? `${autoCount} 次自动提交，由 ${bots.join('、')} 发起 · 不计入总提交数`
        : `${autoCount} 次自动提交 · 不计入总提交数`;
      const automated =
        autoCount > 0 ? `<p class="commit-auto">${i18n(en, zh)}</p>` : '';
      const count = num(it.count);
      const countBlock =
        count > 0
          ? `<span class="row-count"><span class="num">${esc(count)}</span>` +
            `<span class="unit">${i18n('commits', '次提交')}</span></span>`
          : '';
      return (
        `<li class="row-block">` +
        `<div class="row">` +
        `<div class="row-lead">` +
        `<span class="row-name">${esc(it.repo)}</span>${own}` +
        `</div>` +
        `${countBlock}` +
        `</div>` +
        `${msgList}${automated}` +
        `</li>`
      );
    })
    .join('');
  return section('commit', 'Commits', '提交', pill(totals.commits, items.length), `<ul class="list">${rows}</ul>`);
}

function prSection(items, totals, notice) {
  const rows = items
    .map((it) => {
      const title = String(it.title || '').trim() ? it.title : UNTITLED();
      return (
        `<li class="row row-block">` +
        `<div class="row-head">${statusBadge(it)}${extLink(it.url, title, 'row-title')}</div>` +
        `<div class="row-meta">${repoSpan(it.repo)}${SEP}<span class="num">#${esc(it.number)}</span>` +
        `${commentCountHtml(it)}${timeHtml(it.ts)}</div>` +
        `</li>`
      );
    })
    .join('');
  return section(
    'pr',
    'Pull requests',
    'PR',
    pill(totals.prs, items.length),
    `<ul class="list">${rows}</ul>${notice || ''}`
  );
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

function issuesSection(items, totals, notice) {
  const rows = items
    .map((it) => {
      const title = String(it.title || '').trim() ? it.title : UNTITLED();
      return (
        `<li class="row row-block">` +
        `<div class="row-head">${statusBadge(it)}${extLink(it.url, title, 'row-title')}</div>` +
        `<div class="row-meta">${repoSpan(it.repo)}${SEP}<span class="num">#${esc(it.number)}</span>` +
        `${commentCountHtml(it)}${timeHtml(it.ts)}</div>` +
        `</li>`
      );
    })
    .join('');
  return section(
    'issue',
    'Issues',
    'Issue',
    pill(totals.issues, items.length),
    `<ul class="list">${rows}</ul>${notice || ''}`
  );
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
  // Keep the action word uppercased (badge style) but let the login keep its
  // true case: the actor lives outside the uppercase context.
  const who = login ? `<span class="badge-who">@${esc(login)}</span>` : '';
  const actionEn = `<span class="badge-action">${esc(m.en)}</span>`;
  const actionZh = `<span class="badge-action">${esc(m.zh)}</span>`;
  const en = who ? `${actionEn} by ${who}` : actionEn;
  const zh = who ? `被 ${who} ${actionZh}` : actionZh;
  const inner =
    en === zh
      ? en
      : `<span class="i18n" data-lang="en">${en}</span>` +
        `<span class="i18n" data-lang="zh">${zh}</span>`;
  return `<span class="badge ${m.cls}">${inner}</span>`;
}

function stateChangesSection(items, notice) {
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
  return section(
    'issue',
    'Status changes',
    '状态变更',
    pill(items.length, items.length),
    `<ul class="list">${rows}</ul>${notice || ''}`
  );
}

function discussionActionBadge(action) {
  const a = String(action == null ? '' : action).toLowerCase();
  const m =
    a === 'commented'
      ? { en: 'Commented', zh: '评论', cls: 'badge-closed' }
      : { en: 'Started', zh: '发起', cls: 'badge-opened' };
  const inner =
    `<span class="i18n" data-lang="en"><span class="badge-action">${m.en}</span></span>` +
    `<span class="i18n" data-lang="zh"><span class="badge-action">${m.zh}</span></span>`;
  return `<span class="badge ${m.cls}">${inner}</span>`;
}

/**
 * Comment count (finite number) or null; missing / invalid always null,
 * never coerced to 0.
 */
function commentCountValue(it) {
  const n = it == null ? undefined : it.comments;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Comment-count word shared by the HTML/Markdown issue · PR · discussion rows
 * and by the Markdown discussions meta: `N comment(s)` — or '' when the count is
 * missing (historical JSON) or not a finite number, so no stray text, stray
 * `0 comments`, `undefined` or `NaN` can ever be rendered.
 */
function commentCountWord(it) {
  const n = commentCountValue(it);
  if (n === null) return '';
  return `${n} comment${n === 1 ? '' : 's'}`;
}

/**
 * Comment-count fragment shared by issue / PR / discussion rows — identical
 * wording and structure on all three paths (`#number · N comments · time`).
 * Returns '' when the count is missing (historical JSON) or not a finite
 * number, so no stray text, `undefined` or `NaN` can ever be rendered.
 */
function commentCountHtml(it) {
  const n = commentCountValue(it);
  if (n === null) return '';
  return `${SEP}<span>${i18n(`${n} comment${n === 1 ? '' : 's'}`, `${n} 条评论`)}</span>`;
}

/** Markdown twin of commentCountHtml: ` _(N comments)_` appended after the row's
 * `repo#number` ref, or '' when the count is missing / not a finite number. */
function commentCountMd(it) {
  const word = commentCountWord(it);
  if (!word) return '';
  return ` _(${word})_`;
}

function discussionsSection(items) {
  const rows = items
    .map((it) => {
      const title = String(it.title || '').trim() ? it.title : UNTITLED();
      const cat = String(it.category || '').trim();
      const catChip = cat ? `<span class="chip chip-kind">${esc(cat)}</span>` : '';
      return (
        `<li class="row row-block">` +
        `<div class="row-head">${discussionActionBadge(it.action)}${catChip}` +
        `${extLink(it.url, title, 'row-title')}</div>` +
        `<div class="row-meta">${repoSpan(it.repo)}${SEP}` +
        `<span class="num">#${esc(it.number)}</span>${commentCountHtml(it)}${timeHtml(it.ts)}</div>` +
        `</li>`
      );
    })
    .join('');
  return section('discussion', 'Discussions', '讨论', pill(items.length, items.length), `<ul class="list">${rows}</ul>`);
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
          ? `<p class="ai-note"><span class="ai-tag">AI</span> ${i18nInline(en, zh)}</p>`
          : '';
      const notes = String(it.notes || '').trim()
        ? `<div class="release-notes">${mdBlockToHtml(it.notes)}</div>`
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

function repliesSection(items, notice) {
  const kindLabel = (kind) => {
    const k = String(kind == null ? '' : kind).toLowerCase();
    if (k === 'review') return { en: 'Review', zh: '评审' };
    if (k === 'comment' || k === 'issue_comment') return { en: 'Comment', zh: '评论' };
    if (k === 'discussion_comment') return { en: 'Discussion', zh: '讨论' };
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
  return section(
    'reply',
    'Replies',
    '回复',
    pill(items.length, items.length),
    `<ul class="list">${rows}</ul>${notice || ''}`
  );
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

function aiSummaryBlock(ai, meta = {}) {
  const badge = `<span class="ai-badge">${icon('spark')}${i18n('AI summary', 'AI 摘要')}</span>`;
  const providerNote = aiProviderNote(meta.provider, meta.model);
  if (!ai || typeof ai !== 'object') {
    return (
      `<section class="card ai">` +
      `<div class="ai-top">${badge}${providerNote}</div>` +
      `<p class="ai-unavailable">${i18n(
        'AI summary temporarily unavailable.',
        'AI 摘要暂不可用。'
      )}</p>` +
      aiFailureBlock(meta.failure) +
      `</section>`
    );
  }
  const en = ai.en && typeof ai.en === 'object' ? ai.en : {};
  const zh = ai.zh && typeof ai.zh === 'object' ? ai.zh : {};
  const headline = i18n(en.headline, zh.headline);
  const enSummary = String(en.summary == null ? '' : en.summary);
  const zhSummary = String(zh.summary == null || zh.summary === '' ? enSummary : zh.summary);
  const enParas = splitParagraphs(enSummary, 'en');
  const zhParas = splitParagraphs(zhSummary, 'zh');
  const parasHtml = (paras) => paras.map((p) => `<p>${aiInlineToHtml(p)}</p>`).join('');
  const summaryHtml =
    enParas.join('\u0000') === zhParas.join('\u0000')
      ? `<div class="ai-summary">${parasHtml(enParas)}</div>`
      : `<div class="ai-summary i18n" data-lang="en">${parasHtml(enParas)}</div>` +
        `<div class="ai-summary i18n" data-lang="zh">${parasHtml(zhParas)}</div>`;
  const hasHeadline = String(en.headline || zh.headline || '').trim() !== '';
  const hasSummary = String(en.summary || zh.summary || '').trim() !== '';
  return (
    `<section class="card ai">` +
    `<div class="ai-top">${badge}${providerNote}</div>` +
    (hasHeadline ? `<h2 class="ai-headline">${headline}</h2>` : '') +
    (hasSummary ? summaryHtml : '') +
    (hasHeadline || hasSummary
      ? ''
      : `<p class="ai-unavailable">${i18n(
          'AI summary temporarily unavailable.',
          'AI 摘要暂不可用。'
        )}</p>`) +
    `</section>`
  );
}

/**
 * AI 块的 provider / model 旁注（.ai-top 内的右上角小字）。
 * provider 为空时整段不渲染；model 缺失时退化成只有 provider（历史数据没有 aiModel）。
 */
function aiProviderNote(provider, model) {
  const p = String(provider == null ? '' : provider).trim();
  if (!p) return '';
  const m = String(model == null ? '' : model).trim();
  return `<span class="ai-provider">${i18n(
    m ? `via ${p} / ${m}` : `via ${p}`,
    m ? `由 ${p} / ${m} 生成` : `由 ${p} 生成`
  )}</span>`;
}

/**
 * AI 全失败时的可见性块：逐条 `<provider> / <model>：<原因>` + 常驻 issue 链接。
 *
 * 只要这一天带了 aiFailure 记录就渲染本块（哪怕 attempts 为空、issue 未回填）——
 * notifier 自己挂掉时必须退化成「未取到 issue 链接」，否则页面会静默地只剩
 * 「AI 摘要暂不可用」，这正是本轮要消灭的不可见状态。
 *
 * provider / model 是代码里的字面量（可信），只过 esc；reason 来自网络/服务端，渲染前再过一次
 * sanitizeReason 兜底（采集时已脱敏，这里是第二道保险）。注意不要把 sanitizeReason 套在 model 上 ——
 * 它的「≥24 位长串一律替换」会把 `longcat-2.5-preview-free`（24 字符）误伤成 <redacted>。
 */
function aiFailureBlock(failure) {
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return '';
  const attempts = A(failure.attempts);
  const issue = failure.issue && typeof failure.issue === 'object' ? failure.issue : {};
  const num = Number(issue.number);
  const href = safeHref(issue.url);
  const lines = attempts
    .map((a) => {
      const provider = String((a && a.provider) || '').trim();
      const model = String((a && a.model) || '').trim();
      const head = model ? `${provider} / ${model}` : provider;
      if (!head) return '';
      const reason = sanitizeReason(a && a.reason);
      return `<span class="ai-failure-line">${esc(head)}：${esc(reason)}</span>`;
    })
    .filter(Boolean)
    .join('');
  const link =
    Number.isFinite(num) && num > 0 && href
      ? `<a class="link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${i18n(
          `View failure details #${num} →`,
          `查看失败详情 #${num} →`
        )}</a>`
      : // notifier 没跑成 / 回写失败：明说拿不到链接，而不是假装没有失败详情
        `<span class="ai-failure-note">${i18n(
          'Failure details: issue link unavailable',
          '失败详情：未取到 issue 链接'
        )}</span>`;
  return `<div class="ai-failure">${lines}${link}</div>`;
}

function emptyState() {
  return (
    `<section class="card empty-card">` +
    `<div class="empty-art">${icon('moon')}</div>` +
    `<h2 class="empty-title">${i18n('A quiet day', '安静的一天')}</h2>` +
    `<p class="empty-sub">${i18n(
      'No public commits, pull requests, issues, reviews, discussions, releases, stars or replies were recorded in this window.',
      '该时间窗口内没有记录到公开的提交、PR、Issue、评审、讨论、发布、标星或回复。'
    )}</p>` +
    `</section>`
  );
}

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

// ---------------------------------------------------------------- document shell

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

// ---------------------------------------------------------------- report page

/**
 * 这一天是否有任何「可见段」可渲染。
 *
 * 判定口径 = 报告会实际渲染的所有分区，而不只是 totals 的四项：
 *   commits / pullRequests / reviews / issues（totals 组成部分）
 *   + stateChanges / discussions / releases / stars / replies（不计入 totals 的附加段）
 *
 * 不要用 data.empty 代替它：empty 是 totals 口径（仅 commits/prs/issues/reviews），
 * 按设计不含 discussions 等附加段；若用 empty 决定「整页是否渲染」，
 * 就会出现「只发了 discussion 的一天被渲染成安静的一天」。渲染层与 index 归档
 * 都用本函数决定空状态，empty 仍原样保留给 totals 语义与校验。
 */
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
  const discussions = A(d.discussions).filter(Boolean);
  const releases = A(d.releases).filter(Boolean);
  const stars = A(d.stars).filter(Boolean);
  const replies = A(d.replies).filter(Boolean);
  const t = d.truncated && typeof d.truncated === 'object' ? d.truncated : {};

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

  // body：空状态由「有没有可见段」决定，而不是 totals 口径的 empty
  // （用 empty 会把「只发了 discussion / release / star / 回复」的一天误判成安静的一天）
  if (!hasVisibleActivity(d)) {
    parts.push(emptyState());
  } else {
    parts.push(aiSummaryBlock(ai, {
      provider: d.aiProvider,
      model: d.aiModel,
      failure: d.aiFailure,
    }));
    parts.push(statsStrip(totals));
    if (commits.length) parts.push(commitsSection(commits, totals));
    if (pullRequests.length) parts.push(prSection(pullRequests, totals, truncationNotice(t, 'events', false)));
    if (reviews.length) parts.push(reviewsSection(reviews, totals));
    if (issues.length) parts.push(issuesSection(issues, totals, truncationNotice(t, 'events', false)));
    if (stateChanges.length) parts.push(stateChangesSection(stateChanges, truncationNotice(t, 'stateChanges', true)));
    if (discussions.length) parts.push(discussionsSection(discussions));
    if (releases.length) parts.push(releasesSection(releases, ai));
    if (stars.length) parts.push(starsSection(stars));
    if (replies.length) parts.push(repliesSection(replies, truncationNotice(t, 'replies', true)));
  }

  parts.push(footerBlock(generatedAt));

  const body =
    `<div class="wrap">\n${parts.join('\n')}\n</div>\n` +
    `<script>${TOGGLE_SCRIPT}</script>`;

  const title = `GitHub activity · ${date || 'daily report'}`;
  return htmlDoc({ title, body, assetPrefix: '../' });
}

// ---------------------------------------------------------------- index page

export function renderIndexPage({ days, generatedAt, username, summaryCardHtml } = {}) {
  const list = A(days).slice(0, 60);
  const user = username == null ? '' : String(username).trim();
  // 近 30 天 AI 总结卡片（片段已由 scripts/summary/render.mjs 渲染好）；没有总结文件时为空串
  const summaryCard = typeof summaryCardHtml === 'string' ? summaryCardHtml.trim() : '';

  const rows = list
    .map((day) => {
      const entry = day && typeof day === 'object' ? day : {};
      const dateLabel = fmtDateShort(entry.date);
      const href = safeHref(entry.url);
      const hasHead =
        String(entry.headline_en || '').trim() !== '' ||
        String(entry.headline_zh || '').trim() !== '';
      const head =
        entry.hasActivity === false
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
    (summaryCard ? `${summaryCard}\n` : '') +
    (list.length
      ? `<ul class="daylist">\n${rows}\n</ul>\n`
      : `<section class="card empty-card"><p class="empty-sub">${i18n(
          'No reports yet.',
          '暂无日报。'
        )}</p></section>\n`) +
    `${footerBlock(generatedAt)}\n` +
    `</div>\n` +
    `<script>${TOGGLE_SCRIPT}</script>`;

  return htmlDoc({ title: 'Daily GitHub activity', body, assetPrefix: '' });
}

// ---------------------------------------------------------------- markdown

export function renderMarkdown({ data, ai } = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const totals = d.totals && typeof d.totals === 'object' ? d.totals : {};
  const date = d.date || d.windowEnd || '';
  const t = d.truncated && typeof d.truncated === 'object' ? d.truncated : {};
  const out = [];

  // 截断提示行：该段命中上限（或级联自 targets）才返回非 null
  const truncLine = (key, cascade) => {
    const sec = t[key];
    const own = Boolean(sec && sec.hits === true);
    const casc = Boolean(cascade && t.targets && t.targets.hits === true);
    if (!own && !casc) return null;
    const cap = own && Number.isFinite(Number(sec.cap)) ? Number(sec.cap) : null;
    return cap != null
      ? `_Partial view — a collection limit (${cap}) was reached; some items may be missing._`
      : '_Partial view — a collection limit was reached; some items may be missing._';
  };

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

  // 空白天：与 HTML 一致，直接给一句「无公开活动」，不再渲染 AI 段
  if (!hasVisibleActivity(d)) {
    out.push('No public GitHub activity in this window.');
    out.push('');
    return `${out.join('\n').replace(/\n+$/, '')}\n`;
  }

  // AI summary
  out.push('## AI summary');
  out.push('');
  if (ai && typeof ai === 'object') {
    const en = ai.en && typeof ai.en === 'object' ? ai.en : {};
    const wrote = [];
    if (String(en.headline || '').trim()) wrote.push(`**${mdInline(en.headline)}**`);
    if (String(en.summary || '').trim()) {
      for (const p of splitParagraphs(en.summary, 'en')) wrote.push(mdInline(p));
    }
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
      out.push(`- ${label}${mdLink(p.title || '(untitled)', p.url)} — \`${mdInline(p.repo)}#${mdInline(p.number)}\`${commentCountMd(p)}`);
    }
    const trunc = truncLine('events', false);
    if (trunc) out.push(trunc);
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
      out.push(`- ${label}${mdLink(it.title || '(untitled)', it.url)} — \`${mdInline(it.repo)}#${mdInline(it.number)}\`${commentCountMd(it)}`);
    }
    const trunc = truncLine('events', false);
    if (trunc) out.push(trunc);
    out.push('');
  }

  // discussions
  const discussions = A(d.discussions).filter(Boolean);
  if (discussions.length) {
    out.push('## Discussions');
    out.push('');
    for (const it of discussions) {
      const action = String(it.action || '').toLowerCase();
      const label = action ? `**${mdInline(action[0].toUpperCase() + action.slice(1))}** ` : '';
      const cat = String(it.category || '').trim();
      const meta = [cat, commentCountWord(it)].filter(Boolean);
      out.push(
        `- ${label}${mdLink(it.title || '(untitled)', it.url)}` +
          ` — \`${mdInline(it.repo)}#${mdInline(it.number)}\`` +
          (meta.length ? ` _(${meta.map((m) => mdInline(m)).join(' · ')})_` : '')
      );
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
    const trunc = truncLine('replies', true);
    if (trunc) out.push(trunc);
    out.push('');
  }

  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}
