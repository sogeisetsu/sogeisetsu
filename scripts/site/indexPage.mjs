#!/usr/bin/env node
/**
 * scripts/site/indexPage.mjs
 * ------------------------------------------------------------------
 * 站点首页 / 归档页（零依赖 ESM，Node 20+）：`docs/index.html`。
 *
 * 为什么单独成文件：它原来住在 scripts/daily/render.mjs，却被三条产品线共用 ——
 * 日报编排（daily/index 两处）、30 天总结（summary/index）、AI 失败通知器
 * （notify-ai-failure）都要重建首页。放在这里之后，summary 侧不必再 import
 * 日报的渲染模块，两个 render 模块也就不再互引。
 *
 * 内容只有：顶栏 + hero + （可选）30 天总结卡片 + 归档列表 + 页脚。
 * 总结卡片是调用方渲染好的 HTML 片段（scripts/summary/render.mjs 的 summaryCard），
 * 本文件只负责把它插进 .wrap —— 刻意不认识 summary 的数据结构。
 *
 * 依赖方向：indexPage → shell（esc / i18n / safeHref / fmtDateShort / topbarRight /
 * footerBlock / htmlDoc / TOGGLE_SCRIPT）。
 */

import {
  TOGGLE_SCRIPT,
  esc,
  fmtDateShort,
  footerBlock,
  htmlDoc,
  i18n,
  safeHref,
  topbarRight,
} from "./shell.mjs";

const A = (x) => (Array.isArray(x) ? x : []);

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
