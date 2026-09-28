/**
 * render-svg.mjs — zero-dependency ESM renderer for the "last 30 days on GitHub"
 * dashboard card used in a GitHub profile README.
 *
 *   import { renderActivityCard } from './render-svg.mjs';
 *   const svg = renderActivityCard(data);   // -> standalone SVG 1.1 document string
 *
 * Design: Material Design 3, light + dark via prefers-color-scheme.
 * No external fonts / images / scripts / network requests.
 * Every string that reaches the SVG goes through esc().
 *
 * Two shapes the data can take, and how they are handled:
 *   · Even spread   → linear scale; the note line reports peak + daily average.
 *   · One outlier   → the axis is clamped just above the runner-up (axisScale): ordinary
 *                     days keep honest relative heights, bars above the cap are cut at the
 *                     top and marked with two slashes, their true value sits above the bar.
 *                     The note never explains the cut — it only states peak and average.
 *   · Lopsided cols → card height follows the taller column; the longer list folds early
 *                     into "n more repos", both columns close on one shared total line.
 */

const FONT_STACK =
  '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

/** Supporting line under the empty-state headline (schema carries no field for it). */
const EMPTY_SUB = "No public commits yet.";
/** Used only when data.empty === true but data.quip is missing. */
const EMPTY_QUIP_FALLBACK = 'The commit log has been as quiet as a library at 4 a.m.';

/** Escape a value for XML text / attribute context. */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const n = (v) => Math.round(v * 100) / 100;

/** Rough advance-width estimate: CJK is full-width, latin is ~0.56em. */
function tw(str, size) {
  let w = 0;
  for (const ch of String(str)) {
    w += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? size : size * 0.56;
  }
  return w;
}

/**
 * Cut a string to a tight pixel budget (estimated, not measured) and append an
 * ellipsis. Used so long repo names can never reach the bar that follows them.
 */
function ellipsize(str, maxW, size) {
  const s = String(str);
  if (tw(s, size) <= maxW) return s;
  const ellW = tw('…', size);
  let head = '';
  let w = 0;
  for (const ch of s) {
    const cw = tw(ch, size);
    if (w + cw + ellW > maxW) break;
    head += ch;
    w += cw;
  }
  return `${head}…`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-21" -> "Sep 21" for the note line. Falls back to MM-DD if unparsable. */
function shortDate(iso) {
  const s = String(iso || '');
  const parts = s.split('-');
  const mon = MONTHS[Number(parts[1]) - 1];
  if (parts.length < 3 || !mon) return s.slice(5);
  return `${mon} ${Number(parts[2])}`;
}

/** Round a chart value up to a comfortable tick step (1/1.5/2/2.5/3/… × 10^k). */
function niceCeil(v) {
  if (!(v > 0)) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= step * mag + 1e-9) return step * mag;
  }
  return 10 * mag;
}

/** Vertical bar, optionally with rounded top corners (r = 0 -> plain rect). */
function vBar(x, w, yTop, yBottom, r, cls) {
  const attr = cls ? ` class="${cls}"` : '';
  const h = yBottom - yTop;
  if (w <= 0.01 || h <= 0.01) return '';
  const rr = Math.min(r, w / 2, h / 2);
  if (rr <= 0.01) {
    return `<rect${attr} x="${n(x)}" y="${n(yTop)}" width="${n(w)}" height="${n(h)}"/>`;
  }
  return (
    `<path${attr} d="M ${n(x)} ${n(yBottom)} L ${n(x)} ${n(yTop + rr)} ` +
    `Q ${n(x)} ${n(yTop)} ${n(x + rr)} ${n(yTop)} L ${n(x + w - rr)} ${n(yTop)} ` +
    `Q ${n(x + w)} ${n(yTop)} ${n(x + w)} ${n(yTop + rr)} L ${n(x + w)} ${n(yBottom)} Z"/>`
  );
}

/** Horizontal bar with a rounded right end (r = 0 -> plain rect). */
function hBar(x, w, y, h, r, cls) {
  const attr = cls ? ` class="${cls}"` : '';
  if (w <= 0.01) return '';
  const rr = Math.min(r, h / 2, w / 2);
  if (rr <= 0.01) {
    return `<rect${attr} x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/>`;
  }
  return (
    `<path${attr} d="M ${n(x)} ${n(y)} L ${n(x + w - rr)} ${n(y)} ` +
    `Q ${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + rr)} L ${n(x + w)} ${n(y + h - rr)} ` +
    `Q ${n(x + w)} ${n(y + h)} ${n(x + w - rr)} ${n(y + h)} L ${n(x)} ${n(y + h)} Z"/>`
  );
}

/**
 * The conventional "this bar keeps going" cue: two short slashes cut across
 * the bar in the card colour, so the bar reads as broken rather than as a
 * genuine value that happens to sit at the top of the axis.
 */
function breakMark(x, w, y) {
  return (
    `<path class="break" d="M ${n(x)} ${n(y + 4)} L ${n(x + w)} ${n(y - 4)} ` +
    `M ${n(x)} ${n(y + 9)} L ${n(x + w)} ${n(y + 1)}"/>`
  );
}

/** Text node. All typography lives in the <style> block. */
function t(x, y, str, cls, anchor) {
  const a = anchor && anchor !== 'start' ? ` text-anchor="${anchor}"` : '';
  return `<text x="${n(x)}" y="${n(y)}" class="${cls}"${a}>${esc(str)}</text>`;
}

const STYLE = `<style><![CDATA[
:root{
  --card:#FFFBFE;
  --on-surface:#1D1B20;
  --on-surface-variant:#49454F;
  --outline-variant:#CAC4D0;
  --primary:#6750A4;
  --primary-container:#EADDFF;
  --on-primary-container:#21005D;
  --secondary-container:#E8DEF8;
  --on-secondary-container:#1D1B20;
  --tertiary:#7D5260;
  --tertiary-container:#633B48;
  --on-tertiary-container:#FFD8E4;
  --surface-container:#F3EDF7;
  --font:${FONT_STACK};
}
@media (prefers-color-scheme: dark){
  :root{
    --card:#211F26;
    --on-surface:#E6E0E9;
    --on-surface-variant:#CAC4D0;
    --outline-variant:#49454F;
    --primary:#D0BCFF;
    --primary-container:#4F378B;
    --on-primary-container:#EADDFF;
    --secondary-container:#4A4458;
    --on-secondary-container:#E8DEF8;
    --tertiary:#EFB8C8;
    --tertiary-container:#633B48;
    --on-tertiary-container:#FFD8E4;
    --surface-container:#2B2930;
  }
}
text{font-family:var(--font);}
.card{fill:var(--card);stroke:var(--outline-variant);stroke-width:1;}
.title{font-size:24px;font-weight:600;fill:var(--on-surface);}
.range{font-size:12px;font-weight:400;fill:var(--on-surface-variant);}
.sect{font-size:14px;font-weight:500;fill:var(--on-surface-variant);}
.stat{fill:var(--secondary-container);}
.stat-num{font-size:28px;font-weight:600;fill:var(--on-secondary-container);}
.stat-label{font-size:14px;font-weight:500;fill:var(--on-secondary-container);}
.stat-sub{font-size:12px;font-weight:400;fill:var(--on-surface-variant);}
.note{font-size:12px;font-weight:400;fill:var(--on-surface-variant);}
.peak-tag{font-size:12px;font-weight:600;fill:var(--on-surface);}
.axis{font-size:12px;font-weight:400;fill:var(--on-surface-variant);}
.legend{font-size:12px;font-weight:400;fill:var(--on-surface-variant);}
.bar-own{fill:var(--primary);}
.bar-other{fill:var(--tertiary);}
.break{fill:none;stroke:var(--card);stroke-width:2;stroke-linecap:butt;}
.base{stroke:var(--outline-variant);stroke-width:1;}
.col-title{font-size:14px;font-weight:500;fill:var(--on-surface);}
.repo{font-size:14px;font-weight:400;fill:var(--on-surface);}
.repo-more{font-size:13px;font-weight:400;fill:var(--on-surface-variant);}
.repo-count{font-size:13px;font-weight:500;fill:var(--on-surface-variant);}
.none{font-size:13px;font-weight:400;fill:var(--on-surface-variant);}
.repobar-own{fill:var(--primary);}
.repobar-other{fill:var(--tertiary);}
.repobar-more{fill:var(--outline-variant);}
.foot{font-size:12px;font-weight:400;fill:var(--on-surface-variant);}
.empty-box{fill:var(--surface-container);stroke:var(--outline-variant);stroke-width:1;stroke-dasharray:7 7;}
.dot-own{fill:var(--primary);}
.dot-mid{fill:var(--outline-variant);}
.dot-other{fill:var(--tertiary);}
.quip{font-size:22px;font-weight:500;fill:var(--on-surface);}
.quip-sub{font-size:14px;font-weight:400;fill:var(--on-surface-variant);}
]]></style>`;

const STAT_DEFS = [
  { key: 'commits', label: 'Commits' },
  { key: 'prs', label: 'Pull requests' },
  { key: 'issues', label: 'Issues' },
  { key: 'reviews', label: 'Reviews' },
];

const W = 880;
const PAD = 48;
const LEFT = PAD;
const RIGHT = W - PAD;
const CONTENT = RIGHT - LEFT;

// ---- chart geometry --------------------------------------------------------
/** Plot height. Kept deliberately short: 30 slots of mostly-zero days. */
const PLOT_H = 104;
/** Share of the plot the runner-up day is allowed to reach when clamping. */
const CLAMP_FILL = 0.82;
/** Clamp the axis once the top day is this many times the runner-up. */
const CLAMP_RATIO = 1.8;

// ---- repo column geometry --------------------------------------------------
const COL_LIMIT_MAX = 5; // never show more than this many rows before folding
const COL_LIMIT_MIN = 3; // …but always keep at least this many
const ROW_H = 28;
const NAME_W = 206; // px budget for the repo name
const COUNT_W = 36; // px reserved for the right-aligned count
const BAR_X = NAME_W + 14; // where the count bar starts, relative to the column

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Normalise a repo list to {name, count}, sorted desc. */
function normalizeRepos(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.name === 'string')
    .map((it) => ({ name: it.name, count: num(it.count) }))
    .sort((a, b) => b.count - a.count);
}

/** Sort desc, cap at `limit`, fold the tail into an "n more repos" row. */
function prepareRows(items, limit) {
  const list = normalizeRepos(items);
  const head = list.slice(0, limit);
  const rest = list.slice(limit);
  const rows = head.map((r) => ({ name: r.name, count: r.count, more: false }));
  if (rest.length) {
    rows.push({
      name: `${rest.length} more repos`,
      count: rest.reduce((a, r) => a + r.count, 0),
      more: true,
    });
  }
  return { rows, total: list.length };
}

/**
 * Pick the y-axis maximum for the daily chart.
 *
 * Linear-to-the-peak is only honest while the days are comparable. When one
 * day towers over the rest (real data: 50 vs a runner-up of 23) every other
 * bar collapses to a stub, so instead we clamp the axis just above the
 * runner-up: ordinary days keep honest relative heights, and the handful of
 * bars above the cap get cut + labelled with their true value.
 */
function axisScale(totals, plotH) {
  const desc = [...totals].sort((a, b) => b - a);
  const max = desc[0] || 0;
  const second = desc[1] || 0;
  const clamped = second > 0 && max >= second * CLAMP_RATIO;
  const axisMax = clamped
    ? Math.max(niceCeil(second / CLAMP_FILL), second + 1)
    : Math.max(max, 1);
  return { max, axisMax, unit: plotH / axisMax };
}

export function renderActivityCard(data) {
  const d = data && typeof data === 'object' ? data : {};
  const empty = d.empty === true;
  let out = '';
  let contentBottom = 0;

  // ---- 1. title row -------------------------------------------------------
  const TITLE_BASE = 68;
  out += t(LEFT, TITLE_BASE, 'Last 30 days on GitHub', 'title');
  out += t(RIGHT, TITLE_BASE - 2, `${d.windowStart || ''} → ${d.windowEnd || ''}`, 'range', 'end');

  if (empty) {
    // ---- 6. empty state (replaces sections 2-4) ---------------------------
    const BOX_TOP = 108;
    const BOX_H = 216;
    const boxBottom = BOX_TOP + BOX_H;

    out += `<rect class="empty-box" x="${LEFT}" y="${BOX_TOP}" width="${CONTENT}" height="${BOX_H}" rx="20" ry="20"/>`;

    const dotY = BOX_TOP + 62;
    out += `<circle class="dot-own" cx="${440 - 24}" cy="${dotY}" r="5"/>`;
    out += `<circle class="dot-mid" cx="440" cy="${dotY}" r="3"/>`;
    out += `<circle class="dot-other" cx="${440 + 24}" cy="${dotY}" r="5"/>`;

    const quip = typeof d.quip === 'string' && d.quip.trim() ? d.quip : EMPTY_QUIP_FALLBACK;
    out += t(440, BOX_TOP + 140, quip, 'quip', 'middle');
    out += t(440, BOX_TOP + 176, EMPTY_SUB, 'quip-sub', 'middle');

    contentBottom = boxBottom;
  } else {
    // ---- 2. four stat blocks ---------------------------------------------
    const CHIP_TOP = 100;
    const CHIP_H = 108;
    const CHIP_GAP = 16;
    const chipW = (CONTENT - CHIP_GAP * 3) / 4;

    STAT_DEFS.forEach((def, i) => {
      const cx = LEFT + i * (chipW + CHIP_GAP);
      const total = num(d.totals && d.totals[def.key]);
      const sp = (d.splits && d.splits[def.key]) || {};
      out += `<rect class="stat" x="${n(cx)}" y="${CHIP_TOP}" width="${n(chipW)}" height="${CHIP_H}" rx="12" ry="12"/>`;
      out += t(cx + 20, CHIP_TOP + 48, String(total), 'stat-num');
      out += t(cx + 20, CHIP_TOP + 74, def.label, 'stat-label');
      out += t(cx + 20, CHIP_TOP + 96, `Owned ${num(sp.own)} · Others ${num(sp.others)}`, 'stat-sub');
    });

    const chipsBottom = CHIP_TOP + CHIP_H;

    // ---- 3. 30-day stacked bar chart -------------------------------------
    const daily = (Array.isArray(d.daily) ? d.daily.slice(0, 30) : []).map((day) => ({
      date: day && day.date ? day.date : '',
      own: num(day && day.own),
      other: num(day && day.other),
    }));
    while (daily.length < 30) daily.push({ date: '', own: 0, other: 0 });

    const totals = daily.map((day) => day.own + day.other);
    const { max, axisMax, unit } = axisScale(totals, PLOT_H);
    const cut = totals.some((v) => v > axisMax);

    const SECTION_BASE = chipsBottom + 38;
    // When a bar is cut, the note line and the bar's own value tag each get
    // their own row above the plot, so the two can never land on top of each
    // other whatever day the peak falls on.
    const NOTE_Y = SECTION_BASE + (cut ? 20 : 25);
    const TAG_Y = cut ? SECTION_BASE + 34 : SECTION_BASE + 25;
    const PLOT_TOP = SECTION_BASE + (cut ? 44 : 34);
    const PLOT_BOTTOM = PLOT_TOP + PLOT_H;
    const slot = CONTENT / 30;
    const barW = slot * 0.6;

    out += t(LEFT, SECTION_BASE, 'Daily activity', 'sect');

    if (max > 0) {
      const legend = [
        { label: 'Owned repos', cls: 'dot-own' },
        { label: 'Other repos', cls: 'dot-other' },
      ];
      const lDotR = 4;
      const lGap = 6;
      const lItemGap = 20;
      const lWidths = legend.map((it) => lDotR * 2 + lGap + tw(it.label, 12));
      const lTotal = lWidths.reduce((a, b) => a + b, 0) + lItemGap * (legend.length - 1);
      let lx = RIGHT - lTotal;
      legend.forEach((it, i) => {
        out += `<circle class="${it.cls}" cx="${n(lx + lDotR)}" cy="${SECTION_BASE - 4}" r="${lDotR}"/>`;
        out += t(lx + lDotR * 2 + lGap, SECTION_BASE, it.label, 'legend');
        lx += lWidths[i] + lItemGap;
      });

      // One plain summary: peak value + its day, then the 30-day daily average.
      const peakDate = shortDate(daily[totals.indexOf(max)].date);
      const dayTotal = totals.reduce((a, v) => a + v, 0);
      const avg = (dayTotal / 30).toFixed(1);
      out += t(
        LEFT,
        NOTE_Y,
        `Peak ${max}${peakDate ? ` on ${peakDate}` : ''} · Average ${avg}/day`,
        'note'
      );
    }

    out += `<line class="base" x1="${LEFT}" y1="${PLOT_BOTTOM}" x2="${RIGHT}" y2="${PLOT_BOTTOM}"/>`;

    if (max === 0) {
      out += t(440, (PLOT_TOP + PLOT_BOTTOM) / 2, 'No activity in the last 30 days', 'axis', 'middle');
    } else {
      daily.forEach((day, i) => {
        const total = day.own + day.other;
        if (total <= 0) return;
        const x = LEFT + slot * i + (slot - barW) / 2;
        let remaining = PLOT_H;
        let baseY = PLOT_BOTTOM;

        const segment = (v, cls, roundTop) => {
          if (v <= 0) return;
          const h = Math.min(remaining, Math.max(v * unit, 2));
          if (h <= 0) return;
          remaining -= h;
          out += vBar(x, barW, baseY - h, baseY, roundTop ? 3 : 0, cls);
          baseY -= h;
        };
        segment(day.own, 'bar-own', day.other <= 0);
        segment(day.other, 'bar-other', true);

        if (total > axisMax) {
          // Cut bar: mark the break and state the real number above it.
          out += breakMark(x, barW, PLOT_TOP + 12);
          const tag = `↑${total}`;
          const tagW = tw(tag, 12);
          const tx = Math.min(Math.max(x + barW / 2, LEFT + tagW / 2), RIGHT - tagW / 2);
          out += t(tx, TAG_Y, tag, 'peak-tag', 'middle');
        }
      });

      const labelW = tw('00-00', 12);
      const xBase = PLOT_BOTTOM + 20;
      for (let i = 0; i < 30; i += 5) {
        const label = String(daily[i].date).slice(5);
        if (!label) continue;
        const cx = Math.min(Math.max(LEFT + slot * (i + 0.5), LEFT + labelW / 2), RIGHT - labelW / 2);
        out += t(cx, xBase, label, 'axis', 'middle');
      }
    }

    const chartBottom = PLOT_BOTTOM + 28;

    // ---- 4. two repo columns ---------------------------------------------
    const COLS_TOP = chartBottom + 34;
    const COL_GAP = 32;
    const colW = (CONTENT - COL_GAP) / 2;
    const barMaxW = colW - COUNT_W - 8 - BAR_X;

    const columns = [
      { title: 'Owned repos', items: d.reposOwn, color: 'repobar-own', x: LEFT, stripOwner: true },
      { title: 'Contributed to', items: d.reposOther, color: 'repobar-other', x: LEFT + colW + COL_GAP },
    ];

    // Both columns share one band (and one closing total line), so the longer
    // list folds a little earlier when the other list is short — otherwise the
    // short column ends up with a visible pocket of empty space under it.
    const counts = columns.map((col) => normalizeRepos(col.items).length);
    const colLimit = Math.max(COL_LIMIT_MIN, Math.min(COL_LIMIT_MAX, Math.min(...counts) + 1));

    const prepared = columns.map((col) => {
      const { rows, total } = prepareRows(col.items, colLimit);
      return { ...col, rows: rows.length ? rows : [{ none: true }], total };
    });

    const maxRows = Math.max(1, ...prepared.map((c) => c.rows.length));
    const rowTop0 = COLS_TOP + 12;
    // Both columns share one band, so both close on the same baseline even when
    // one of them has far fewer rows than the other.
    const bandBottom = rowTop0 + maxRows * ROW_H;
    const summaryY = bandBottom + 24;
    const hasSummary = prepared.some((c) => c.total > 0);

    prepared.forEach((col) => {
      out += t(col.x, COLS_TOP, col.title, 'col-title');
      const maxCount = Math.max(1, ...col.rows.map((r) => num(r.count)));

      col.rows.forEach((row, i) => {
        const cy = rowTop0 + i * ROW_H + ROW_H / 2;
        const baseY = cy + 5;

        if (row.none) {
          out += t(col.x, baseY, '(none)', 'none');
          return;
        }

        const label = col.stripOwner && !row.more ? row.name.replace(/^[^/]+\//, '') : row.name;
        out += t(col.x, baseY, ellipsize(label, NAME_W, 14), row.more ? 'repo-more' : 'repo');
        out += t(col.x + colW, baseY, String(row.count), 'repo-count', 'end');

        if (row.count > 0) {
          const w = Math.max(4, (row.count / maxCount) * barMaxW);
          const bh = 10;
          out += hBar(col.x + BAR_X, w, cy - bh / 2, bh, 5, row.more ? 'repobar-more' : col.color);
        }
      });

      if (col.total > 0) {
        out += t(col.x, summaryY, `${col.total} repos total`, 'note');
      }
    });

    contentBottom = hasSummary ? summaryY : bandBottom;
  }

  // ---- 5. footer ----------------------------------------------------------
  let footerText = 'Data from GitHub contribution stats · Updated daily';
  if (d.truncated === true && d.truncatedFrom) {
    footerText += ` · Daily breakdown covers ${d.truncatedFrom} onward`;
  }
  const footerBase = contentBottom + 32;
  out += t(LEFT, footerBase, footerText, 'foot');

  const H = Math.round(footerBase + 36);

  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
    `role="img" aria-label="Activity over the last 30 days on GitHub">\n` +
    `<title>Last 30 days on GitHub</title>\n` +
    STYLE;

  const card = `<rect class="card" x="1" y="1" width="${W - 2}" height="${H - 2}" rx="28" ry="28"/>`;

  return `${head}\n${card}\n${out}\n</svg>\n`;
}

export default renderActivityCard;
