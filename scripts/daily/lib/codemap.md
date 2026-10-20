# scripts/daily/lib/

## Responsibility

全仓共享内核：日报与 30 天总结两侧共用的「日期/哈希口径 + GitHub 采集 + AI 适配」三件套，零依赖 ESM（Node 20 内置 `fetch`）。三个文件各管一层、互不 import（唯一的上层依赖 `days.mjs` → `render.mjs` 见 Notes）：

- `days.mjs` —— **口径单点**：路径常量（`ROOT`/`DATA_DIR`/`REPORT_DIR`/`BACKFILL_DIR`/`ARCHIVE_LIMIT=60`）、+08 自然日推算（`cstDayMinus`/`prevDateOf`/`nextDateOf`/`dateRange`）、原子写入 `writeAtomic`、内容哈希 `contentHash`、`docs/data` 扫描（`listDateStrings`/`listDays`）。两线的日期与哈希口径必须从这里走，保证逐字一致。
- `github.mjs` —— **采集层**：`collectDailyData()`（事件流主通道，按 1–10 段编号组装）与 `collectHistoricalData()`（Search API 历史回填通道，同 shape + `source`/`backfillLimits`），以及被确定性测试直接断言的纯函数（`normalizeNotes`/`buildTargetQueries`/`filterTargetCandidates`/`orderTargetCandidates`/`isPullRow`/`commentTotalOf`/`groupCommentCountTargets`/`attachCommentCounts`）；提交归属别名表 `COMMIT_AUTHOR_ALIASES = ["suyue"]`。
- `ai.mjs` —— **AI 适配层**：`defaultProviders()` provider 链、通用结构化生成 `generateStructured()`（日报与总结共用的唯一入口）、日报包装 `generateNarrative()`、跨线复用的文本标尺（`countSentences`/`splitSentences`/`fitHeadline`/`fitText`）与 `resolveSenseNovaModel()`；另有 `AUTOMATED_OVERLAP_RE`（「自动提交写成包含关系」检测，日报叙述 / 总结 overview+byRepo / `verify.mjs` 共用）。

## Design

- **半开窗口 + 固定 +08 偏移**：`computeWindow(date)` → `[date 00:00+08, 次日 00:00+08)`，统一由 `inWindow(ms, win)`（`startMs ≤ ts < endMs`）精滤；`TZ_OFFSET_MS = 8h` 硬编码（Asia/Shanghai 无夏令时）。GitHub Search/GraphQL 的 `created:/updated:` 是 **UTC 日历日**，查询下界一律 `dayBefore()` 放宽一天，再由 `inWindow` 本地收口——这是 Search 段反复出现的模式。
- **分段软失败**：`restGet()` 永不抛错（401/403/404/限流/非 JSON → `warn` + `null`），每段拿不到数据就返回空数组；`httpFetch` 只对 5xx/网络异常指数退避重试 2 次，4xx 立即交调用方。唯一会抛的入口是 `computeWindow` 的 date 非法。所有分页/枚举有硬上限（`EVENT_MAX=300`、`TARGET_MAX=25`、`COMMENT_COUNT_MAX=40`…），撞上限记入 `truncated.<段> = {cap, hits}`（恒存在）如实标注。
- **totals 恒等式（公开口径）**：`totals = {commits: Σcommits[].count, prs/issues/reviews: 对应数组长度}`，只由实际展示的数据求和；`automatedCommits`（机器人）单列，与本人提交互不相交、不进 `totals`/`empty`；**合并提交（`parents.length > 1`）在归属判定与 sha 去重之前整体跳过**。提交归属弃用 `contributionsCollection` 与 PushEvent 归属，一律走仓库提交历史（REST `/commits?since&until` 真实 UTC ISO）+ 身份集合 `username ∪ COMMIT_AUTHOR_ALIASES`（大小写不敏感）+ 全局 sha 去重（fork 场景）。
- **快照冻结（定稿日评论数）**：`win.endMs <= Date.now()` 时用 `storedCommentCounts(existingData)` 生成 `repo#number → 计数` 快照，`attachCommentCounts` 命中 frozen **直接写值、全程不发任何网络请求**（含公开性查询）；未命中才实时 REST（Issue=`comments`，PR=`comments + review_comments`），取不到有限数字则**不设字段**（`commentTotalOf` 不用 0 兜底，避免「取不到」伪装成「0 条」）。`--force` 由调用方传 `existingData: null` 解冻。
- **共享公开性闸门**：`repoVisibility: Map` 每仓只查一次，`isPublicRepo` 被回复/状态变更/评论数三段共用；404 或读不懂一律按不公开（宁可少报，不泄露私有仓库）。
- **stars 基准模式**：`starInventory` 全量持久化作次日 delta 基准，展示的 `stars` 只列 delta 非 0 的变化项（基准优先 `previousData.starInventory`，回退旧格式 `previousData.stars`）。
- **AI：provider 责任链 + 同步校验器 + 反馈重试**：`generateStructured({ system, user, validate, providers, feedback })` 按 `defaultProviders()` 顺序逐家尝试（`sensenova` → `opencode-go-longcat` → `opencode-go-deepseek`，缺 key 跳过；SenseNova 模型运行时 `resolveSenseNovaModel` 惰性解析、进程内缓存、失败回退默认模型绝不弃用 provider）。每家内部是 `attemptProvider` 状态机（≤ `MAX_ROUNDS=12`）：429/5xx 等 2s 重试一次 → 400 先退 `reasoning_effort` 再退 `response_format`（`jsonModeUnsupported` 进程内记忆，绝不因此弃用该家）→ SenseNova chat 404/405 换 `responses` 形态 → `finish_reason=length`/空输出翻倍 `max_tokens`（≤65536，防 reasoning 吃光预算）→ 校验失败追加 `feedback(reason, n)` 可执行纠正提示（≤3 次）→ 仍败换下一家 → 全败返回 `null`。`validate` 是同步纯函数，返回 `{ok:true, value}` 或 `{ok:false, reason}`。
- **拒收 vs 截断的分界**：硬长度（headline ≤80、summary ≤1400 字符）由 `fitHeadline`/`fitText` 按句界/词界**代码截断、不整段拒收**（模型无法稳定遵守字符上限）；结构性问题（缺 en/zh 段、`releaseNotes` 出现输入之外的 `repo@@tag`、句数低于下限）才拒收触发纠正重试。`countSentences`/`splitSentences` 中英句末标点兼顾，是 summary 侧校验器复用的同一把标尺。

## Flow

1. **进入（日报线）**：`daily/index.mjs processDate()` 读上一日 JSON（`previousData`，stars delta 基准）与本日已存 JSON（`existingData`，同时是评论快照源与 `dataHash` 比较基准；`FORCE ? null : existing`）→ `collectDailyData({ token, username, date, previousData, existingData })`。
2. **采集（`collectDailyData` 10 段顺序组装）**：① `fetchPublicEvents` + `mapEvents`（窗口内 PR/Issue/评审/我自己的评论）→ ② `fetchOwnRepos` → ③ `buildCommits`（扫描集 = 窗口 PushEvent 仓 ∪ `pushed_at ≥ 窗口起点` 的自有仓，≤30 仓；逐条判 合并提交/bot/本人）→ ④ `fetchReleases` → ⑤ GraphQL `fetchStarCounts` → `buildStarInventory`/`buildStars` → ⑥ `searchAuthoredTargets`（3 条 Search query，`filterTargetCandidates` 只剔出窗 + `orderTargetCandidates` 窗口内优先切片）→ `fetchReplies`（共享 `repoVisibility`）→ ⑦ `fetchStateChanges`（他人 closed/merged/reopened，不进 totals）→ ⑧ `fetchDiscussions`（他人对我讨论的回复并入 `replies`，`kind=discussion_comment`）→ ⑨ `applyEndStates`（按窗口末时刻原地写条目 `state`）→ ⑩ `attachCommentCounts`（`win.endMs <= Date.now()` 判 frozen）。
3. **汇总离开**：求和 `totals`/`empty`/`automatedCommits` → 返回固定 shape（每个 key 恒存在、数组可空）→ `index.mjs` 算 `contentHash(data)`（**忽略 `generatedAt`/`ai`/`aiProvider`/`dataHash`**）与已存 `dataHash` 比对：相同且不缺 AI → 跳过一切；相同但 `missingAi` → 只重试 AI。
4. **AI 段**：`generateNarrative({ data, providers: defaultProviders() })` → `buildPrompts` 压缩输入（每段 cap 30 条、commit message 10×200 字符、release notes ≤800 字符，只喂聚合条目不喂原始事件）→ `generateStructured` 责任链 → `validateNarrative` 校验/截断 → 成功 `{en, zh, provider}`，全败 `null`（降级策略在 `index.mjs`：数据未变沿用旧 `ai`，否则产无叙述确定版）。
5. **写入**：`index.mjs` 回填 `data.ai`/`aiProvider`/`dataHash` 后 `writeAtomic` 写 `docs/data/<date>.json` + report html/md；`listDays()` 供 index 归档（`url` 带 `?v=<dataHash 前 10 位>` 击穿缓存，`hasActivity` 用可见段口径）。
6. **回填支线**：`summary/backfill.mjs` → `collectHistoricalData()`（同 shape：动作段（原 ① 的事件流）改 `rebuildActionsBySearch` Search 重建、`buildCommits` 不传事件流（扫描集只剩自有仓）、`stars`/`starInventory` 恒空、提交历史扫描故 commits 仍准确、`truncated.events.hits` 恒 false；`BACKFILL_LIMITS` 枚举各段如实口径）→ `contentHash` → `writeAtomic` 到 `data/backfill/<date>.json`（带 `source="search-backfill"`）。

## Integration

- Consumed by: `scripts/daily/index.mjs`（`collectDailyData` + `generateNarrative`/`defaultProviders` + days 全套）；`scripts/daily/verify.mjs`（`cstDayMinus`/`dateRange`/`BACKFILL_DIR`/`readJsonIfExists`）；`scripts/daily/check.mjs`（对 `lib/ai.mjs`/`lib/days.mjs`/`lib/github.mjs` 跑 `node --check`，并串起 `test-ai.mjs`/`test-render.mjs`/`summary/test-summary.mjs`/`verify.mjs`）；`scripts/daily/test-ai.mjs`（本地假 HTTP 服务器驱动 `generateNarrative` 全重试路径）、`scripts/daily/test-render.mjs`（直接断言 github.mjs 8 个纯函数，含冻结短路「禁网也写出快照值」）。**`scripts/summary/**` 跨目录复用**：`index.mjs`（`defaultProviders`+`generateStructured`、`INDEX_PATH`/`SUMMARY_JSON_PATH`/`SUMMARY_HTML_PATH`/`listDays`/`writeAtomic`）、`collect.mjs`（`BACKFILL_DIR`/`DATA_DIR`/`cstDayMinus`/`dateRange`/`readJsonIfExists`）、`validate-summary.mjs`（`countSentences`/`fitHeadline`/`fitText`——总结校验标尺与日报同源）、`test-summary.mjs`（假 provider → `generateStructured` 端到端）、`backfill.mjs`（`collectHistoricalData` + `contentHash`/`writeAtomic`/`BACKFILL_DIR`/`DATE_RE`）。CI 经 `check.yml`（check.mjs）与 `update-daily-report.yml`/`update-summary.yml`（经 index 侧）间接消费。
- Depends on: 仅 Node 内置 `node:fs`/`node:crypto`/`node:path`/`node:url` + 内置 `fetch`，零第三方依赖；`github.mjs`/`ai.mjs` 不 import 任何仓内模块，`days.mjs` 反向 import `scripts/daily/render.mjs` 的 `hasVisibleActivity`（见 Notes）。外部服务：GitHub REST/GraphQL/Search API、SenseNova `token.sensenova.cn`、OpenCode Go `opencode.ai/inference/go`。环境变量：`GITHUB_TOKEN`（可选——缺失时 GraphQL 星标/Discussion 段降级为空、Search 易限流）、`SENSENOVA_API_KEY`/`SENSENOVA_MODEL`、`OPENCODE_API_KEY`、`GITHUB_REPOSITORY_OWNER`。

## Notes

- **`days.mjs` 依赖上层 `render.mjs`**：`listDays` 的「安静的一天」判定必须用 `hasVisibleActivity`（九个可见段口径），不能用 `data.empty`（totals 口径）——否则只发了 discussion 的一天会被标成安静日。`render.mjs` 自身零 import，故无循环依赖，但 lib 目录不是严格底层。
- **`github.mjs` 刻意不 import `days.mjs`**：自带 `loadDataFile`/`loadPreviousData`（自算 repo 根读 `docs/data`）与 CLI 冒烟（`--date/--dump/--force`），保证采集器可独立运行；代价是路径/日期逻辑在两处各写一份，改口径需同步。
- **`contentHash` 排除的 4 个字段就是「无变化跳过」的全部依据**：AI 叙述重写、`generatedAt` 变化都不该触发重采集；`dataHash` 自身参与哈希会被自己排除，故新旧可直接相等比对。
- **`filterTargetCandidates` 不按 `inWindow` 过滤**（回归修复，`test-render.mjs` 有断言）：`updated_at` 是最后一次活动时间，落在窗口**之后**的条目仍可能携带窗口内的回复/状态变更，按 `inWindow` 滤会把它们整体静默删掉——只剔「最后活动早于窗口起点」的条目。
- **`generateNarrative` 不按 `data.empty` 自行拦截**：是否值得叙述由调用方（`index.mjs` 的 `hasVisibleActivity`）判断；历史上在 AI 内二次拦截曾导致「只发 discussion 的一天」永远拿不到叙述。
- **进程级记忆只活在单次运行内**：`jsonModeUnsupported`（provider 不支持 `response_format`）与 `senseNovaModelCache` 每次 CI 进程重新探测。
- **`collectHistoricalData` 的 `previousData` 恒传 `null`**，参数仅为签名对齐保留——star 历史无法按天重建，stars 段恒空（`BACKFILL_LIMITS.stars = "unavailable"`）。
