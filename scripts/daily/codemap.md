# scripts/daily/

## Responsibility

每日 GitHub 活动日报的**引擎与共享渲染层**：采集 → AI 叙述 → 渲染 → 写入 `docs/`，同时充当全站预检入口。零依赖 ESM（Node 20，无 `package.json`、无构建）。

- `index.mjs` —— 编排器：`collectDailyData()` → `generateNarrative()` → `renderReportPage()` / `renderMarkdown()` → `writeAtomic()`，产出 `docs/report/YYYY-MM-DD.{html,md}`、`docs/data/YYYY-MM-DD.json`（结构化真相源，含 `dataHash`）、`docs/index.html`（最新一天 + 归档 ≤60 天 + 30 天总结卡片）。
- `render.mjs` —— 共享 UI/渲染层：页面外壳、全站 CSS、双语机制、各活动分区与安全 markdown 子集；**被 `scripts/summary/` 复用**（跨目录共享点，见 Integration）。
- `verify.mjs` —— `docs/` 生成物不变式自检（A–J 检查项，逐条 `OK`/`FAIL`，失败 exit 1）。
- `check.mjs` —— 本地预检总入口：`node --check` 语法 + 五套确定性测试 + `providers check`（配置 schema + workflow 接线）+ `verify.mjs`，任一失败 exit 1。
- `test-ai.mjs` / `test-render.mjs` —— 确定性回归：本地假 HTTP 服务器冒充 SenseNova / 纯函数断言，**不触网、不需要 key**。
- `lib/` —— 采集、AI 适配与 provider 配置的内部实现，有自己的 codemap（`scripts/daily/lib/codemap.md`），此处只按路径引用。`lib/providers.mjs` 是 `config/providers.json` 的唯一读取者；`scripts/providers.mjs`（CLI）与 `scripts/test-providers.mjs`（回归）在上一层。

## Design

- **`dataHash` 去重（无变化跳过）**：每次先抓数据，`contentHash(data)`（`lib/days.mjs`，忽略 `generatedAt`/`ai`/`aiProvider`/`dataHash`）与已存 JSON 的 `existing.dataHash` 相同 → 不调 AI、不写文件、不重写 index。唯一例外 `missingAi`：数据没变但有可见活动且缺 `ai` 叙述 → 仍重试生成。
- **两套「空」口径**：`data.empty` 是 totals 口径（仅 commits/prs/issues/reviews）；**空状态与是否调 AI 一律用 `hasVisibleActivity(data)`**（九个可见段，且 commits 按 `count > 0` 判——纯机器人日不算有活动）。用 `empty` 会把「只发了 discussion 的一天」误渲染成「安静的一天」。
- **单文档双语**：`i18n(en, zh)` 把两种语言烘焙进同一 HTML，CSS 按 `<html data-lang>` 显隐，`LANG_BOOTSTRAP` + `TOGGLE_SCRIPT`（localStorage 键 `gh-report-lang`）切换；两侧文本相同则只出一份。`i18nInline` 是走 `aiInlineToHtml` 的变体。
- **页面即纯函数**：`renderReportPage({ data, ai })` / `renderIndexPage({ days, generatedAt, username, summaryCardHtml })` / `renderMarkdown({ data, ai })`，全部字符串拼接；`htmlDoc({ title, body, assetPrefix, extraCss })` 是文档外壳，`pageStyle(assetPrefix, extraCss)` 是全站 CSS（含 Chomsky `@font-face` —— 资产保留，但标题栈已改版为系统衬线、不再引用它），`extraCss` 是 summary 页注入专属样式的唯一钩子。
- **渲染单元抽象**：`section(icon, titleEn, titleZh, pillHtml, body)` 卡片骨架、`pill(total, fallback)`（**0 是合法总数**，不回退成行数）、`statsStrip(totals)` 数字条、`truncationNotice()` 采集上限提示。
- **安全边界**：所有动态串过 `esc()`，链接过 `safeHref()`；不可信文本（他人评论、release notes）只走白名单子集——`aiInlineToHtml`（仅 `code`+`**bold**`）、`mdInlineToHtml`、`mdBlockToHtml`（先转义再展开、fence 未闭合也收尾、GFM 管道表格成真表、`maxChars` 截断），内部链接一律相对路径（站点挂在 subpath）。
- **`check.mjs` 编排**：`spawnSync(process.execPath, ...)` 依次跑 ① `node --check` 全部脚本（daily 侧 `lib/ai` `lib/providers` `lib/days` `render` `lib/github` `index` + 根级 `providers`/`test-providers`/`cst`/活动卡片线/诊断两件套 + summary 侧 `collect` `prompt` `validate-summary` `render` `backfill` `index`）→ ② `test-ai.mjs` → ③ `test-render.mjs` → ④ `summary/test-summary.mjs` → ⑤ `test-activity-window.mjs` → ⑥ `test-providers.mjs` → ⑦ `providers check` → ⑧ `verify.mjs --quiet`，汇总数失败项后统一 exit。

## Flow

**默认（无参数）一次处理一对日期**：`[cstDayMinus(1), cstDayMinus(0)]`（昨天=定稿，今天=滚动），逐日 `processDate(date)`：

1. 校验 `DATE_RE`；读上一日 JSON（`previousData`，原样传给采集层）与本日已存 JSON（`existing`，同时充当快照源与 `dataHash` 比较基准）。
2. `collectDailyData({ token, username, date, previousData, existingData: FORCE ? null : existing })` —— 定稿日的评论数快照默认冻结自 `existing`；`--force` 传 `null` 连快照一起重取（口径/提示词变更的逃生口）。
3. `contentHash` 比较：无变化且不缺 AI → 返回 `{ changed: false }`（不进 AI、不写盘）。
4. AI 分支：无可见活动 → 跳过（页面走空状态卡）；`--no-ai` → 跳过；否则 `generateNarrative({ data, providers: defaultProviders(), budgetMs: laneBudgetMs("daily") })`（链 = `config/providers.json` 的 `lanes.daily`，整条链有 8 分钟总预算）。**失败降级**：数据未变且 `existing.ai` 在 → 沿用上一次叙述；否则 `ai = null`（页面显示「AI 摘要暂不可用」）。
5. 回填 `data.ai` / `data.aiProvider` / `data.dataHash` → `renderReportPage` + `renderMarkdown`。
6. `--dry-run` 到此返回（只打印字节数）；否则 `writeAtomic` 三件套：`docs/data/<date>.json`、`docs/report/<date>.html`、`docs/report/<date>.md`。
7. 回到 `main()`：任一日期 `changed` → `listDays()` 重写 `docs/index.html`（`summaryCardHtml()` 读 `docs/summary.json`，缺失时安静地返回 null 不报错）；**全部无变化 → index 不动**。

**`--rerender` 分支**（改渲染代码后用）：对 `listDateStrings()`（或 `--date` 指定日）只读已有 JSON 重渲染 report 的 html/md，最后**无条件**重写 index —— 不抓数据、不调 AI、不改 JSON。

**`verify.mjs` 检查链**（A–J）：A `docs/data/<date>.json` schema / `totals = Σ` / `empty` 互斥 / `automated` / `comments` / `truncated` → B data ↔ report 一一对应、index 报告链接均可落盘 → C head + 字体（favicon 路径、Chomsky `@font-face`（资产保留但标题栈不得引用）、`--headline` 与 `--headline-zh` 同字族、zh h1 用 `var(--headline-zh)`、`<head>` 内禁用字体名 `Newsreader`/`lxgw`/`霞鹜文楷`、`chomsky.woff2` 的 `wOF2` 魔数）→ D 报告正文（无 `merge:` 标题、页脚「不含合并提交」、自动提交说明按 Σ 有无、**AI 正文也不许写成包含式（共用 `AUTOMATED_OVERLAP_RE`）**、**卡片角标 = totals（0 也显示 0）**、讨论已渲染、评论数逐行渲染、空状态与可见段互斥、有 `ai` 时双语 `ai-summary` 各 ≥1 段、截断提示）→ F `data/backfill/` schema（`source=search-backfill` + `backfillLimits`）→ G/H `docs/summary.json` schema + 窗口 = 最近一次该写出的窗口（`cstDayMinus(30)..cstDayMinus(1)`；今天那次总结的写入时点之前也接受前一天那次，见 `SUMMARY_CRON_UTC`）+ totals/`automatedCommits` 逐日 Σ（`docs/data` ∪ `data/backfill`，daily 优先）+ `missing` 集合相等 → I `summary.html` 结构/head/数字条一致/自动提交「相加」表述（机器 stats-note 与 AI 正文都查，包含式检测共用 `lib/ai.mjs` 的 `AUTOMATED_OVERLAP_RE`）/缺日标注/双语块 → J index 卡片 `href="./summary.html"` 与双语 headline 逐字 → E 打印覆盖面；`failed > 0` → exit 1。

**数据离开本目录**：`docs/data/<date>.json` 是 30 天总结的逐日输入（`scripts/summary/collect.mjs` 聚合）；`docs/index.html` 的顶部卡片由 `scripts/summary/render.mjs` 的 `summaryCard()` 片段注入。

## Integration

- **Consumed by:**
  - `.github/workflows/update-daily-report.yml` —— `node scripts/daily/index.mjs [--date=…] [--force]`（cron 定稿昨天 + 滚动今天，产物提交回 `main`）。
  - `.github/workflows/check.yml` —— `node scripts/daily/check.mjs`（push/PR 零 secret 预检）。
  - `scripts/summary/render.mjs` —— `import { esc, safeHref, i18n, icon, section, pill, statsStrip, topbarRight, footerBlock, htmlDoc, TOGGLE_SCRIPT, SEP, aiInlineToHtml, splitParagraphs } from '../daily/render.mjs'`；总结页专属 CSS 经 `htmlDoc({ extraCss })` 注入 `pageStyle`。
  - `scripts/summary/index.mjs` —— `import { renderIndexPage } from "../daily/render.mjs"` 重写 `docs/index.html`（带总结卡片）。
  - 手动发布流程：`node scripts/daily/index.mjs` → `node scripts/daily/check.mjs` → push → 手动 dispatch workflow。
- **Depends on:**
  - `scripts/daily/lib/github.mjs`（采集）、`lib/ai.mjs`（`generateNarrative` + `generateStructured` + `defaultProviders`）、`lib/providers.mjs`（`config/providers.json` → chain，`laneBudgetMs`）、`lib/days.mjs`（+08 日期推算、`contentHash`、`writeAtomic`、`listDays`、路径常量）—— 内部实现见 `scripts/daily/lib/codemap.md`。
  - `scripts/summary/render.mjs` 的 `summaryCard`（`index.mjs` 反向 import，读 `docs/summary.json`）—— 与 summary 形成双向但不对称的依赖（daily 只要卡片片段，summary 复用整层渲染）。
  - 环境变量 `GITHUB_TOKEN`、`GITHUB_REPOSITORY_OWNER`（及 AI 侧 `config/providers.json` 各 endpoint 的 `keyEnv`，密钥细节归 `lib/codemap`）。
  - 实体资产 `docs/favicon.svg`、`docs/assets/fonts/chomsky.woff2`（verify C 检查的前提）。

## Notes

- **AI 全失败不写假叙述**：数据未变 → 沿用上一次 `ai`（不把已发布页面降级）；数据变了 → 产「无叙述确定版」，页面出「AI 摘要暂不可用」。空白天根本不调 AI、不造叙述。
- **`--rerender` 只重渲染**：不抓数据、不调 AI、不改 JSON，但会无条件重写 `docs/index.html`；`--dry-run` 则一个字节都不写（含 index）。
- **`--force` 是口径变更的逃生口**：绕过 `dataHash` 跳过，且重取定稿日评论数快照——否则旧口径的 `comments` 会被永久冻结在 JSON 里。
- **verify 的 summary 窗口项比的是「最近一次该写出的窗口」**：`docs/summary.json` 的窗口要么是今天的 `cstDayMinus(30)..cstDayMinus(1)`，要么（在今天那次总结的写入时点之前，见 `SUMMARY_CRON_UTC` = cron `22:17` UTC + 1h 余量）是前一天那次的窗口。所以本地检出落后一天、或当天总结还没到点都不算回归；只在窗口停在两天前（总结连续没写出）时 FAIL。
- **字体/head 硬约束只看 `<head>`**：正文叙述里提到 `Newsreader` 等禁用字体名不算违规；`--headline` 与 `--headline-zh` 必须同字族、且都不得引用 Chomsky（改版后标题统一系统衬线），改渲染层后必跑 `check.mjs`。
- **评论数是采集快照不是实时值**：定稿日从已存 JSON 冻结，`--force` 才重取；渲染层对缺失/非有限数字一律不显示（不出 `0 comments`/`NaN`）。
