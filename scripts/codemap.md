# scripts/

## Responsibility

顶层 `scripts/` 是整条内容流水线的根，四条线在此汇合（零依赖 ESM，Node 20+，无 `package.json` / 构建步骤）：

1. **近 30 天活动卡片线**（本目录直管）：`generate-activity.mjs` 抓数 + 回写，`render-svg.mjs` 纯渲染，`preview.mjs` + `fixtures/*.json` 本地目测 → 产物 `assets/30-day-activity.svg` 与 `README.md` 的 marker 区块。
2. **日报线**：编排入口 `daily/index.mjs`（详见 `scripts/daily/codemap.md`）。
3. **30 天 AI 总结线**：编排入口 `summary/index.mjs`（详见 `scripts/summary/codemap.md`）。
4. **本地预检**：`daily/check.mjs` = 语法检查 + 确定性测试 + `verify.mjs`（其覆盖范围见 Notes）。

本 codemap 只展开 1；2/3 各有子目录 codemap，此处仅记接口接线。

## Design

- **消费契约 `data` schema**：`generate-activity.mjs` 头注释里定义的 `data`（`totals` / `splits` / `daily[30]` / `reposOwn` / `reposOther` / `empty` / `quip` / `truncated` / `truncatedFrom`）是采集层与渲染层的唯一接口；`renderActivityCard(data) -> SVG 字符串` 是唯一渲染入口（`render-svg.mjs` 导出具名 + default）。`details`（`commits/issues/PRs/reviews/comments/releases/stars`）是并行的 README 专用明细，不进 `data`。
- **渲染器 = 无 IO 的字符串拼接**：自绘 SVG 1.1 + CDATA `<style>`，Material Design 3 变量经 `prefers-color-scheme` 切换明暗，无外链字体/图片/脚本；一切入参过 `esc()`（XML 转义），文本宽度用 `tw()` 估算（CJK 全宽、latin ~0.56em）→ `ellipsize()` 裁剪，因此无需浏览器排版即可定版式。
- **图表自适应抽象**：`axisScale(totals, PLOT_H)` —— 离群日（`max >= second * CLAMP_RATIO=1.8`）时把 y 轴钳到次高日的 `CLAMP_FILL=0.82`，越轴柱 `breakMark()` 双斜杠截断 + `↑n` 真值标签；`prepareRows(items, limit)` 把仓库列表尾部折叠成 `n more repos` 行，`COL_LIMIT_MIN=3 / COL_LIMIT_MAX=5`，两栏共享一条 band 与合计行（`colLimit = min(两栏条数)+1`）；`empty === true` 走整块虚线框空态，替换正常 2–4 段。
- **采集容错**：`httpFetch()` 对 5xx/网络异常指数退避重试 2 次，4xx 立即 `fail()`（退出码 1）；事件分页 `EVENT_MAX_PAGES=5 × per_page=100` 截到 `EVENT_MAX=300`，取满且最早事件晚于窗口起点 +24h 才置 `truncated` + `truncatedFrom`；`empty = totalsZero && dailyZero`，`quip` 从 `QUIPS` 随机取。
- **写入策略**：SVG 用 `writeAtomic()`（`<file>.tmp-<pid>` + `renameSync`），README 用普通 `writeFileSync`；两者都**先比对旧内容、变了才写**（`svgChanged` / `readmeChanged`）。README 走**标记位替换** `replaceReadmeBlock()`：`<!--START:activity-->` / `<!--END:activity-->` 必须各出现且仅一次、END 在 START 之后（否则 `fail`），marker 外字节原样保留，EOL 按现有内容取 CRLF/LF。
- **README 明细三层优先级**（`buildOwnLines`）：① 全窗口聚合的 push 计数（无时间戳，按 count 降序置顶）→ ② PR/Issue/评审按 `ts` 倒序 → ③ 评论/Release/Star 仅在余量内补位，各层合计截到 `DETAIL_MAX=10`；own/others 归属由 `isOwnLogin` / `isOwnRepoName`（repo owner login 大小写不敏感）判定。
- **调试开关**：`--dry-run` 打印 README 区块预览不写盘；`--dump-data=FILE` 把组装好的 `data` 原样导出（`fixtures/real.json` 即由此而来）。

## Flow

**活动卡片线**（`node scripts/generate-activity.mjs [--dry-run]`，`main()` 顺序）：

1. `computeWindow()` → 以 UTC 今天为终点的 30 个自然日（`dates[]`、`startISO`/`endISO`）。
2. 串行两路取数：`fetchContributions(window)`（GraphQL `contributionsCollection`，官方四项总数 + 逐仓库/逐条明细）+ `fetchPublicEvents()`（REST `/users/:owner/events/public`，跟随 `Link` header，回退"满页即有下一页"推断）。
3. `buildData(collection, rawEvents, window)` → `{data, details}`：`totals`/`splits` 全来自 GraphQL；`daily` 按事件日期入桶（`PushEvent` 权重 = `payload.size ?? commits.length ?? 1`，其余 1），`reposOwn/reposOther` 由 GraphQL 明细 + 事件共同 `bump()`；窗口外事件丢弃；算 `empty` / `truncated`。
4. `renderActivityCard(data)` → 校验返回值是 `<` 开头的字符串，否则 `fail`。
5. `buildReadmeBlock(data, details, todayISO)` → `replaceReadmeBlock()` 替换 marker 之间内容（`empty` 时仅输出 head + quip 一行，无 `<details>` 块）。
6. 打印摘要 + `splits` 与 `totals` 对账警告（不等 = 明细被截断）→ `--dry-run` 则止步；否则 `writeAtomic(SVG)` / `writeFileSync(README)`，无变化则跳过写入。

**预览线**（`node scripts/preview.mjs`）：`fixtures/{real,sample,empty}.json` → `renderActivityCard()` → `scripts/preview-{real,normal,empty}.svg`；fixture 缺失只 `skip` 不中断，`done: n written, m skipped` 收尾。

**日报/总结线**只记交接：`daily/index.mjs` = `collectDailyData() → generateNarrative() → renderReportPage()/renderMarkdown()/renderIndexPage()`，`summary/index.mjs` = `collectSummaryData() → generateStructured() → renderSummaryPage()/summaryCard()`，两者共享 `daily/lib/`（`ai.mjs`、`days.mjs`）与 `dataHash`「无变化跳过」机制——内部实现见各自 codemap。

## Integration

- Consumed by:
  - `.github/workflows/update-activity.yml`（cron `30 */2 * * *`）→ `node scripts/generate-activity.mjs` → `git add README.md assets/30-day-activity.svg` 提交回 main；`GITHUB_TOKEN` 由 `secrets.GITHUB_TOKEN` 注入。
  - `README.md` 第 3 行 `![GitHub activity over the last 30 days](./assets/30-day-activity.svg)` 引用产出的 SVG；marker 区块（`README.md` L5/L37）是回写目标。
  - `generate-activity.mjs` 与 `preview.mjs` 均 `import { renderActivityCard } from "./render-svg.mjs"`；`fixtures/real.json` 由 `--dump-data` 产出、被 `preview.mjs` 消费。
  - `.github/workflows/check.yml`（push/PR）只跑 `node scripts/daily/check.mjs`。
- Depends on:
  - 仅 `node:fs` / `node:path` / `node:url` 内置模块 + Node 20 内置 `fetch`（全目录无第三方依赖）。
  - GitHub GraphQL `contributionsCollection` 与 REST `/users/:owner/events/public`；环境变量 `GITHUB_TOKEN`（`apiHeaders()` 有则带 `Authorization`）、`GITHUB_REPOSITORY_OWNER`（默认 `sogeisetsu`）、`GITHUB_REPOSITORY`（仅日志展示）。
  - 网络时钟：窗口按 UTC 日界计算，与日报线的 Asia/Shanghai（`+08`）口径不同。
  - 反向：`daily/render.mjs` 注释标明复用本目录 `render-svg.mjs` 的设计语言与 `esc()`（**复制而非 import**，无代码级依赖）。

## Notes

- `README.md` 的 `<!--START:activity-->` / `<!--END:activity-->` **必须各出现且仅一次且顺序正确**，否则 `replaceReadmeBlock()` 直接 `fail` 退出码 1；改 README 时不要碰这对 marker。
- `scripts/preview-*.svg` 与 `assets/_preview.html` 已被 `.gitignore` 忽略，预览产物不入库；`fixtures/*.json` 入库。
- `daily/check.mjs` 的 `syntaxTargets` **不含** `generate-activity.mjs` / `render-svg.mjs` / `preview.mjs` —— 活动卡片线不在本地预检与 `check.yml` 的覆盖范围内，改动后需手动跑一次。
- SVG 是原子写入、README 不是；README 写入虽有"变了才写"比对，但中途失败会留下半写风险（`writeFileSync` 非 tmp+rename）。
