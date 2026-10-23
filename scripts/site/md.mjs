#!/usr/bin/env node
/**
 * scripts/site/md.mjs
 * ------------------------------------------------------------------
 * Markdown 子集渲染（零依赖 ESM，Node 20+）：**站点的唯一 Markdown 入口**。
 *
 * 三档严格程度，别混用：
 *   mdInline / mdLink     生成 .md 文件时的转义（不给 HTML 用）
 *   mdInlineToHtml        不可信文本（他人评论 / release notes）的行内子集：
 *                         先整体 HTML 转义，再展开白名单标记，链接只认 http(s)
 *   mdBlockToHtml         不可信文本的块级子集：标题 / 列表 / 围栏代码 / GFM 表格 / 段落，长度封顶
 *   aiInlineToHtml        AI 摘要专用：只认行内代码与加粗（斜体、链接一律留字面）
 *   i18nInline            双语版 aiInlineToHtml（两侧各渲染一遍）
 *   splitParagraphs       正文分段（中英断句规则不同）
 *
 * 硬约束：所有输入先转义再展开标记，正则必须有界（一个野生 `**` 不能吞掉整段）。
 * 依赖方向只有一条：md → shell（esc / safeHref）。
 */

import { esc, safeHref } from "./shell.mjs";

/** Markdown inline escaping: keep link text and list items from breaking. */
export function mdInline(text) {
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

export function mdLink(text, url) {
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
export function mdInlineToHtml(text) {
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
