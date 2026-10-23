#!/usr/bin/env node
/**
 * scripts/site/css.mjs
 * ------------------------------------------------------------------
 * 全站基础样式（零依赖 ESM，Node 20+；零 import）：`pageStyle()` 与它用的入场动画延时表。
 *
 * 这里是站点外壳的**最底层**：daily / summary 两条产品线、首页与总结页都从这一份样式里取类名。
 * 页面专属样式只能经 `htmlDoc({ extraCss })` 追加在基础样式**之后**（后者覆盖前者）；
 * 首页与卡片片段**没有** extraCss 钩子，所以它们只能使用本文件里已有的类。
 *
 * 契约：`pageStyle(assetPrefix, extraCss)` 的签名与 `base + extraCss` 的拼接顺序不可变
 * （顺序反了 CSS 优先级会静默反转，线上样式就错了）。
 */

// 字体栈全部收在这里：它们只被 pageStyle 的 CSS 变量消费（页面正文不直接引用）。
const FONT_STACK =
  '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

// Headline only, and the SAME stack for both languages: one editorial serif
// voice. Latin picks up Iowan Old Style (macOS) / Palatino Linotype (Windows) /
// Georgia / Times; CJK falls through to the system 宋体/Ming faces (Songti SC,
// SimSun, Source Han Serif/Noto Serif CJK), then a generic serif tail. No
// webfont, no CJK download — and no display blackletter either.
const HEADLINE_STACK =
  '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Songti SC", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", STSong, serif';

// Chinese page headline: the same family as the Latin one — --headline-zh only
// exists so the zh h1 rule can still carry per-language weight / size / tracking
// (CJK needs a little more size and no negative tracking to match Latin).
const HEADLINE_ZH_STACK = 'var(--headline)';

const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const STAGGER = Array.from({ length: 14 }, (_, i) =>
  `.wrap > *:nth-child(${i + 1}){animation-delay:${(i * 0.045).toFixed(3)}s}`
).join('\n');
export function pageStyle(assetPrefix = '', extraCss = '') {
  return `
@font-face{font-family:'Chomsky';src:url('${assetPrefix}assets/fonts/chomsky.woff2') format('woff2');font-weight:400;font-style:normal;font-display:swap}
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
  --headline:${HEADLINE_STACK};
  --headline-zh:${HEADLINE_ZH_STACK};
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

/* ---- card window-range chip ----
   The home card prints its window range on its own line, read as a chip from the
   same family as the report page .chip / .badge: pill radius, hairline outline,
   light surface, same small size / weight / tracking. Colours are variables, so
   both themes work. Class emitted by summaryCard in scripts/summary/render.mjs
   (the index page has no extraCss hook, so the styles must live here).
   The range text stays a contiguous run inside one span. */
.ai-range{
  display:inline-flex;align-items:center;margin:0 0 10px;
  padding:.2em .6em;border-radius:999px;border:1px solid var(--outline-variant);
  background:var(--surface-dim);color:var(--on-surface-variant);
  font-size:.7rem;font-weight:750;letter-spacing:.02em;
  font-variant-numeric:tabular-nums;white-space:nowrap;
}
/* the chip speaks in the body/UI voice (like .chip / .badge), not in the mono
   voice — .mono stays on the span for its machine-data meaning, but the pill
   keeps one typeface. */
.ai-range > .mono{font-family:inherit;font-size:inherit}

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
h1{
  margin:0;font-family:var(--headline);font-size:clamp(1.95rem,6.4vw,2.95rem);
  line-height:1.07;letter-spacing:-.015em;font-weight:700;text-wrap:balance;
}
html[data-lang="zh"] h1{
  font-family:var(--headline-zh);font-weight:700;line-height:1.14;letter-spacing:0;
}
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
.row-head{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0}
.row-title,.reply-title,.release-title{font-weight:650;color:var(--on-surface)}
.row-meta{margin-top:7px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:.8rem;color:var(--on-surface-variant)}
.row-count{display:inline-flex;align-items:baseline;gap:7px;white-space:nowrap;font-variant-numeric:tabular-nums}
.row-count .num{font-size:1.05rem;font-weight:800;color:var(--on-surface)}
.unit{font-size:.75rem;font-weight:700;color:var(--on-surface-variant)}
.repo{font-family:var(--mono);font-size:.8rem}
.time{font-variant-numeric:tabular-nums;font-size:.78rem;white-space:nowrap}
.dot{color:var(--outline);padding:0 1px}
.commit-msgs{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:3px}
.commit-msg{
  position:relative;padding-left:14px;font-size:.8rem;color:var(--on-surface-variant);
  overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.commit-msg::before{content:'·';position:absolute;left:3px;color:var(--outline);font-weight:800}
.commit-auto{margin:7px 0 0;font-size:.77rem;color:var(--on-surface-variant)}

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
.badge .badge-action{text-transform:uppercase}
.badge .badge-who{text-transform:none;letter-spacing:normal}
/* 中文版徽章/标签：.badge 的字号（.68rem）与字距（.06em）是按全大写拉丁字母调的，
   汉字在同样 px 下偏小偏细，字距还会把「发布」「讨论」这类词拆散。只放大中文，
   并收紧字距；text-transform:uppercase 对汉字无影响，无需单独覆盖。英文版一点不动。 */
html[data-lang="zh"] .badge{font-size:.74rem;letter-spacing:.02em}
html[data-lang="zh"] .chip{font-size:.76rem;letter-spacing:0}

/* ---- truncation notice ---- */
.trunc-notice{
  margin:12px 0 0;padding:9px 12px;border-radius:11px;font-size:.78rem;
  background:var(--surface-dim);color:var(--on-surface-variant);
  border:1px dashed var(--outline-variant);
}

/* ---- releases ---- */
.release-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.release-tag{
  font-family:var(--mono);font-size:.75rem;font-weight:750;
  background:var(--tertiary-container);color:var(--on-tertiary-container);
  padding:.22em .6em;border-radius:9px;
}
.release-notes{
  margin:12px 0 0;font-size:.9rem;color:var(--on-surface-variant);
  overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:12;-webkit-box-orient:vertical;overflow:hidden;
}
.release-notes>*{margin:.5em 0}
.release-notes h3,.release-notes h4,.release-notes h5,.release-notes h6{
  margin:.75em 0 .3em;font-size:.95rem;font-weight:750;color:var(--on-surface);line-height:1.35;
}
.release-notes h3:first-child,.release-notes h4:first-child,.release-notes h5:first-child,.release-notes h6:first-child{margin-top:0}
.release-notes ul,.release-notes ol{margin:.4em 0;padding-left:1.35em}
.release-notes li{margin:.22em 0}
.release-notes pre{
  margin:.5em 0;padding:10px 12px;border-radius:10px;overflow-x:auto;
  background:var(--surface-variant, rgba(0,0,0,.05));font-family:var(--mono);font-size:.8rem;
}
.release-notes pre code{background:none;padding:0}
.release-notes code{
  font-family:var(--mono);font-size:.84em;background:rgba(0,0,0,.05);
  padding:.12em .38em;border-radius:6px;
}
/* GFM table from a release body: .release-notes clamps its lines, so this
   must fit the card width and wrap cells instead of scrolling sideways. */
.release-notes table{
  margin:.5em 0;width:100%;border-collapse:collapse;
  font-size:.84rem;line-height:1.45;
}
.release-notes th,.release-notes td{
  padding:6px 9px;text-align:left;vertical-align:top;
  border-top:1px solid var(--outline-variant);
  /* anywhere (inherited from .release-notes) shrinks a column's min-content to
     one character and breaks a word like inspect mid-word; break-word still
     wraps over-long tokens but keeps them at full width for column sizing. */
  overflow-wrap:break-word;
}
.release-notes td code,.release-notes th code{overflow-wrap:break-word}
.release-notes thead th{
  border-top:0;border-bottom:1px solid var(--outline-variant);
  background:var(--surface-dim);color:var(--on-surface);font-weight:750;
}
.ai-note{
  margin:12px 0 0;padding:10px 13px;border-radius:12px;font-size:.88rem;
  background:var(--primary-container);color:var(--on-primary-container);
}
.ai-tag{font-size:.66rem;font-weight:800;letter-spacing:.1em;margin-right:8px;opacity:.85}
/* Inline code inside the release AI note: the note sits on the purple
   --primary-container, so the global rgba(0,0,0,.05) chip vanishes. Give it a
   light chip that stands out on that purple in both themes. */
.ai-note code{
  font-family:var(--mono);font-size:.86em;background:rgba(255,255,255,.6);
  color:var(--on-primary-container);padding:.12em .38em;border-radius:6px;
  overflow-wrap:anywhere;
}
@media (prefers-color-scheme:dark){
  .ai-note code{background:rgba(255,255,255,.16)}
}

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
/* 徽章是固定标签：flex:none 让它不参与收缩，nowrap 保证「AI SUMMARY」/「AI 摘要」
   在任何宽度（含 320px）下都不折行、不被逐字断开。窄屏让位的是右侧旁注。 */
.ai-badge{
  display:inline-flex;align-items:center;gap:8px;flex:none;white-space:nowrap;
  font-size:.73rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--primary);
}
.ai-badge svg{width:16px;height:16px}
/* provider / model 旁注：靠右，与左侧 badge 同一行。min-width:0 允许它收缩到
   文字内容以下并自行换行（窄屏由它吸收压力），text-align:right 让换行后的两行
   仍贴着右边成为一列小字；text-wrap:pretty 避免末行只剩「生成」这种孤字；
   overflow-wrap:anywhere 是兜底 —— 万一 model 名比剩余宽度还长，就地断词而不是
   把徽章挤出卡片。 */
.ai-provider{
  margin-left:auto;min-width:0;text-align:right;text-wrap:pretty;
  font-size:.75rem;color:var(--on-surface-variant);overflow-wrap:anywhere;
}
/* AI 全失败时的可见性块（原因 + 常驻 issue 链接），夹在「暂不可用」段之后 */
.ai-failure{margin:10px 0 0;display:flex;flex-direction:column;gap:4px}
.ai-failure-line{
  font-family:var(--mono);font-size:.78rem;line-height:1.5;
  color:var(--on-surface-variant);overflow-wrap:anywhere;
}
.ai-failure .link{font-size:.8rem;font-weight:650}
.ai-failure-note{font-size:.78rem;color:var(--on-surface-variant)}
.ai-headline{margin:0 0 8px;font-size:clamp(1.15rem,3.6vw,1.5rem);line-height:1.25;font-weight:800;letter-spacing:-.015em}
.ai-summary{margin:0;font-size:.98rem;color:var(--on-surface-variant)}
.ai-summary.i18n[data-lang]{display:block}
.ai-summary p{margin:0 0 .55em}
.ai-summary p:last-child{margin-bottom:0}
.ai-summary strong{color:var(--on-surface);font-weight:750}
.ai-summary code{
  font-family:var(--mono);font-size:.86em;background:rgb(254,247,255);
  color:var(--on-surface);
  padding:.12em .38em;border-radius:6px;overflow-wrap:anywhere;
}
@media (prefers-color-scheme:dark){
  .ai-summary code{background:rgba(255,255,255,.12);color:var(--on-surface)}
}
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
/* 手机宽度：AI 块顶行改成「徽章一行 + provider 旁注整行」。并排时旁注只分到
   100 多 px，会碎成三四行（还在 model 名中间断词）；整行后它回到一两行、
   贴着徽章读作一行小字 byline，总高度与并排时几乎相同。徽章仍是一行。
   （对齐见上方 .ai-badge / .ai-provider 注释。） */
@media (max-width:430px){
  .ai-top{flex-wrap:wrap;align-items:baseline;gap:2px 10px}
  .ai-provider{flex:1 1 100%;margin-left:0;text-align:left;font-size:.72rem}
}
@media (max-width:400px){
  .ghbtn{padding:8px 11px}
  .ghbtn-label{display:none}
}${extraCss ? `\n${extraCss}` : ''}
`;
}
