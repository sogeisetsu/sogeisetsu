# scripts/summary/

## Responsibility
「近 30 天 GitHub 活动 AI 总结」这条线：站在 `scripts/daily/` 引擎之上，把最近 30 个已定稿 +08 自然日的日报/回填数据聚合成一个窗口，产出三件产物 —— `docs/summary.json`（结构化真相源）、`docs/summary.html`（完整总结页）、`docs/index.html` 顶部的总结卡片片段。核心不变式：**确定数字（totals / automatedCommits / 每仓库数字）全部由代码求和，AI 只叙述、不计算**；模型输出经严格校验后才落盘，URL 一律由校验器从真实数据注入，模型永远写不出链接。

文件分工：
- `index.mjs` —— 编排器：聚合 → 去重判断 → AI（含校验重试）→ 写站点产物；含 `--force / --dry-run / --no-ai / --rerender` 四个开关
- `collect.mjs` —— 窗口聚合 `collectSummaryData()` + 校验白名单构建 `buildItemIndex()`
- `prompt.mjs` —— 英文 system prompt（含 JSON schema 与硬规则）、user prompt 压缩、按失败原因的纠正反馈 `summaryFeedback()`
- `validate-summary.mjs` —— AI 输出同步校验器 `validateSummary()`：白名单命中 / 禁令 / 截断 / URL 注入
- `render.mjs` —— `renderSummaryPage()`（总结页全文）与 `summaryCard()`（首页卡片片段）
- `backfill.mjs` —— 一次性 Search API 历史回填 CLI（不挂 workflow）
- `test-summary.mjs` —— 确定性回归：假数据目录 + 假 http 服务器，零依赖不触网

## Design
**聚合-校验-渲染三段式**，每段单向依赖、纯函数可测：

- **窗口抽象**：`summaryWindow()` = `cstDayMinus(30)..cstDayMinus(1)` 闭区间（复用日报的 +08 口径），恰好 30 个已定稿日，不含今天。数据源 = `docs/data` ∪ `data/backfill`，**同日两份都有时 `docs/data` 完全优先**（回填那份根本不读，定稿是真相源）。
- **确定数字条与 AI 载荷分离**：`collectSummaryData()` 一次遍历同时累加 `totals`/`automatedCommits`（`Number(...)||0`，绝不经 AI）并构建 `aiPayload` —— commits 按 repo 跨日合并、其余段全量合并按 `ts` 降序。`aiPayload` 刻意不带 `comments`（`pickItem()` 只挑契约字段），从源头掐掉 AI 提评论数的可能；另附代码统计的每仓库确定数字 `repos[]`（byRepo 段落必须逐字引用，不许模型自己数）。
- **窗口哈希去重**：`dataHash = sha256(windowStart|windowEnd|各存在日 "date:dataHash:source" 升序"|")` —— 只掺数据本身、不掺 `generatedAt`，同一批数据稳定复现；与日报 dataHash 同思路。
- **校验器白名单命中 + URL 注入**：`buildItemIndex(daily)` 从真实单日数据建 `{ repos: Set, items: Map<"repo#number",…>, releases: Map<"repo@@tag",…> }`，是校验器的**唯一事实口径**（绝不来自 AI 输出）。`validateSummary()` 要求 AI 的 repo / 编号 / tag 必须命中集合，命中不了 → `{ ok:false, reason }` → `summaryFeedback(reason, n)` 生成可执行英文纠正 → 上层重试；**URL 一律由校验器从 `items`/`releases` 注入**，模型给什么都不采纳。
- **拒收 vs 截断的分界**：硬长度问题（headline 超 80、teaser/overview 超长）走 `fitHeadline`/`fitText` 按句界截断、**不整段拒收**（与日报 `validateNarrative` 同手法）；「改一次就能对」的问题（纯文本违规、句数、段数、白名单未命中、评论数禁令、自动提交包含式、teaser 缺失）才拒收。`byRepo` 条数上限随 `repos.size` 放大（8 保底 ~ 24 硬顶），防止固定上限悄悄砍掉真实仓库；缺仓库不拒收（只在提示词里约束）。headline 只拦反引号/星号，放行 `#`/`[` 以免 "issue #42" 正当措辞误拒。
- **自动提交必须写成相加**：`count`（本人）与 `automated`（机器人）互不相交。overview / byRepo 里出现「其中/包含…自动提交」「includes … automated commits」这类包含式说法 → 拒收，`summaryFeedback` 提示改成「本人 N 次，另有 M 次」。正则 `AUTOMATED_OVERLAP_RE` 放在 `scripts/daily/lib/ai.mjs`，`verify.mjs` 共用同一份，避免两处漂移；「自动提交不计入总数」是正确说法（`计入` 前有「不」不命中）。
- **评论数双保险**：源头（`pickItem` 不带 comments）+ 校验（`COMMENT_COUNT_RE` 中英大小写不敏感逮 `\d+ 条评论` / `\d+ comments`，看原文不看截断后）。
- **缺日强制披露**：`missing.days > 0` 时校验器要求 en/zh 的 overview 至少一处出现该数字（粗判 `includes`）；渲染层另有独立的缺日提示卡。
- **渲染复用日报皮**：`render.mjs` 全部 import 自 `scripts/daily/render.mjs`（`esc/safeHref/i18n/icon/section/pill/statsStrip/htmlDoc/TOGGLE_SCRIPT/aiInlineToHtml/splitParagraphs`），双语机制沿用 `data-lang` + localStorage；总结页专属 CSS 只写 `EXTRA_CSS` 经 `htmlDoc({extraCss})` 注入，首页卡片因 index 无 extraCss 钩子**只准用 pageStyle 已有类**。en/zh 按下标配对渲染（契约声明同构）。

## Flow
1. **进入**：`index.mjs main()` → `collectSummaryData({ username })` 逐日读 `docs/data/<date>.json`（缺失则试 `data/backfill/<date>.json`，再缺失记入 `missing`），`normalizeDay()` 补齐缺段，累加 totals、合并 commits/items、统计每仓库数字，产出 `{ windowStart/End, missing, totals, automatedCommits, sources, backfilled, backfillLimits, daily, aiPayload, dataHash }`。
2. **去重判断**：读已存 `docs/summary.json`；`dataHash` 相同且非 `--force` 且已有叙述 → 跳过 AI 与写入（无变化跳过）。`missingAi`（hash 同但上一次没拿到叙述）例外：仍重试 AI，与日报 missingAi 逻辑对齐。
3. **AI 前置门**：`--no-ai` 或 `hasAnyActivity()` 判定窗口无可叙述活动（空跑日）→ 跳过 AI；若窗口未变且已有叙述则沿用。
4. **AI 段**：`buildItemIndex(collected.daily)` 建白名单 → `buildSummaryPrompts({ collected })` 把 `aiPayload` 压成 user prompt → `generateStructured({ system, user, validate, providers: defaultProviders(), feedback: summaryFeedback })`（总结线重排后：deepseek → opencode-go-minimax → opencode-go-longcat → sensenova）。校验失败经 `summaryFeedback` 转成纠正提示重试。
5. **状态转移（AI 结果）**：
   - 成功 → `ai = res.value`
   - 全失败且已有带叙述的 `summary.json` → 沿用旧 `ai`，**`!DRY_RUN` 时直接 return，不写任何文件**（页面不降级）
   - 全失败且无旧叙述（首次运行）→ `ai = null`，仍写「只有确定数字」的页面（AI 块渲染「暂不可用」）
6. **离开**：组装 `summary` 对象 → `writeSite()` 原子写 `docs/summary.json` + `renderSummaryPage()` → `docs/summary.html` + `listDays()`/`summaryCard()` 重写 `docs/index.html`（归档列表与日报共用 `listDays()`，口径必须一致）。`--dry-run` 只打印不写；`--rerender` 只按已存 JSON 重渲染。
7. **回填支线**：`backfill.mjs` 独立 CLI，逐日调 `collectHistoricalData()`（Search API + 逐条 REST 校时）写 `data/backfill/<date>.json`（带 `source`/`backfillLimits`，`previousData` 恒 null 所以 stars 不回填）；可重入（已存在跳过），逐日失败继续、最后退出码 1。

## Integration
- Consumed by: `.github/workflows/update-summary.yml`（cron `17 22 * * *` UTC，CI 里跑 `node scripts/summary/index.mjs` 并回推生成物）；`scripts/daily/check.mjs`（语法检查 + 本目录 `test-summary.mjs` + `verify.mjs`，含总结窗口数字一致性自检）；`scripts/daily/render.mjs` 的 `renderIndexPage()`（接收本线产出的 `summaryCardHtml` 片段）。用户侧入口：Pages 的 `index.html` 卡片与 `summary.html`。
- Depends on: `scripts/daily/lib/days.mjs`（`cstDayMinus`/`dateRange`/`readJsonIfExists`/`writeAtomic`/`contentHash`/`DATA_DIR`/`BACKFILL_DIR`/各路径常量）；`scripts/daily/lib/ai.mjs`（`generateStructured`/`defaultProviders`/`fitHeadline`/`fitText`/`countSentences`）；`scripts/daily/render.mjs`（页面皮与双语组件全套）；`scripts/daily/lib/github.mjs`（`collectHistoricalData`，仅 backfill 用）。

## Notes
- `data/backfill/` **不在 `docs/` 下**，因此不站点可见、不出现在归档列表 —— 它只是 collect 的次级数据源；`--rerender` 会重写整个 `docs/index.html`，依赖 `listDays()` 与日报一致。
- AI 全失败时「不写任何文件」意味着 `generatedAt`/`dataHash` 也不更新，页面与缓存哈希保持上一次状态 —— 这是刻意的（页面不降级），不是遗漏。
- `summaryFeedback` 靠正则匹配校验器的中文 reason（如 `/出现输入之外/`、`/评论数/`），改 `validate-summary.mjs` 的 reason 措辞时必须同步改 `prompt.mjs` 的分支，否则纠正提示会退化成通用「只输出 JSON」轮换。
- `validateSummary` 对缺日只做 `overview.includes(String(missing.days))` 粗判（"3" 会命中 "2026-03" 之类的假阳性），这是有意的宽容 —— 精确核对交给提示词与渲染层的缺日提示卡。
- `hasAnyActivity()` 只认 `aiPayload` 里的 commits（count+automated>0）与七个数组段；窗口只有机器人产出且计数全 0 时按「无可叙述」跳过 AI。
- 改 `scripts/summary/**` 后没有 push 触发，必须手动 `gh workflow run update-summary.yml --ref main`（日报 workflow 的白名单不含本目录）。
