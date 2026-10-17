# Repository Atlas: sogeisetsu

> **映射基线**：`5c9eeab`（2026-10-17）· **覆盖范围**：`scripts/**` + `ops/**` 的代码与配置。
> **判断是否过期**：`git log --oneline 5c9eeab..HEAD -- scripts ops` —— 有输出即说明映射覆盖的代码已变，动手前先复核受影响目录的 `codemap.md`。
> **为什么不是「和 HEAD 比提交号」**：本仓每 2 小时就有 bot 自动提交生成物（`docs/` / `README.md` / `assets/`），那些提交与架构无关。裸比提交号会在两小时内必然报"过期"，等于没有信号——所以过期判断必须限定到 `scripts` 与 `ops` 这两条路径。

## Project Responsibility

一个**零依赖的 ESM 内容生成流水线**（Node 20，无 `package.json`、无构建步骤、无测试框架、无第三方依赖），产物是 GitHub Pages 个人主页站点。核心工作是把公开的 GitHub 活动数据，渲染成三类可发布产物：

1. **每日活动日报**（有 AI 双语叙述）→ `docs/`
2. **近 30 天活动卡片**（无 AI，SVG）→ `assets/` + `README.md`
3. **近 30 天 AI 总结**（严格校验的结构化叙述）→ `docs/summary.{json,html}` + 首页卡片

三条线各有一个可独立运行的 `node` 入口，由 `.github/workflows/` 的 cron 定时驱动；生成物提交回 `main`，GitHub Pages 从 `main` / `docs` 发布。`ops/` 下另有一个 Cloudflare Worker 为 GitHub 丢失的 schedule 触发兜底。

全仓最重要的两条不变式：
- **数字由代码算，AI 只叙述**：`totals` 等确定数字全部由代码求和；AI 输出经严格校验，URL 由校验器从真实数据注入，模型写不出链接。
- **口径统一在 `scripts/daily/lib/days.mjs`**：所有日期都是 Asia/Shanghai（+08）自然日，所有内容哈希都走同一函数，保证日报与总结两处逐字一致。

## System Entry Points

每个入口都是自包含的 `node` 脚本，可本地直接跑。

| 入口 | 作用 | 常用参数 |
| --- | --- | --- |
| `scripts/daily/index.mjs` | 日报编排：采集 → AI → 渲染 → 写 `docs/` | `--date=YYYY-MM-DD` / `--rerender` / `--force` / `--dry-run` / `--no-ai` |
| `scripts/generate-activity.mjs` | 活动卡片：抓数 → 出 SVG → 回写 README marker 区块 | `--dry-run` / `--dump-data=FILE` |
| `scripts/summary/index.mjs` | 30 天总结编排：聚合 → 去重 → AI → 写站点 | `--rerender` / `--force` / `--dry-run` / `--no-ai` |
| `scripts/summary/backfill.mjs` | 一次性 Search API 历史回填（不挂 workflow） | `--from=` / `--to=` / `--force` / `--dry-run` |
| `scripts/daily/check.mjs` | **本地预检总入口**（唯一的"测试命令"）：语法检查 + 三个确定性测试 + `docs/` 不变式自检 | `--quiet` |
| `scripts/preview.mjs` | 用 `scripts/fixtures/*.json` 出本地 SVG 预览目测 | — |

根级资产：`README.md`（活动卡片回写目标 + 站点入口）、`AGENTS.md`（**权威规格书，改代码前先读**：跑法、口径、发布流程、冲突处理）、`.gitignore`、`.gitattributes`。根目录**没有可执行代码**——全部逻辑在 `scripts/` 与 `ops/`。

CI：`.github/workflows/` 下四个 workflow —— `update-daily-report.yml`（cron `17 */2 * * *`）、`update-activity.yml`（`30 */2 * * *`）、`update-summary.yml`（`17 22 * * *`，**无 push 触发，改 `scripts/summary/**` 后必须手动 dispatch**）、`check.yml`（push/PR 只跑 `check.mjs`）。三者共用 concurrency 组 `update-activity` 串行回推 `main`。

## Directory Map (Aggregated)

| Directory | Responsibility Summary | Detailed Map |
| --- | --- | --- |
| `scripts/` | 内容流水线根：活动卡片线（generate-activity / render-svg / preview）在此直管，日报、总结、预检三条线在此接线但不展开内部实现。 | [View Map](scripts/codemap.md) |
| `scripts/daily/` | 日报引擎 + **全站共享渲染层**（`render.mjs` 被 summary 复用）+ `docs/` 不变式自检（`verify.mjs`）与本地预检总入口（`check.mjs`）。 | [View Map](scripts/daily/codemap.md) |
| `scripts/daily/lib/` | **全仓共享内核**：+08 日期/哈希口径（`days.mjs`）、GitHub 采集（`github.mjs`）、AI provider 责任链与结构化生成（`ai.mjs`）；日报与总结两侧复用。 | [View Map](scripts/daily/lib/codemap.md) |
| `scripts/summary/` | 近 30 天 AI 总结线：聚合-校验-渲染三段式，白名单校验 + URL 注入 + 确定数字条；含一次性回填 CLI。 | [View Map](scripts/summary/codemap.md) |
| `ops/` | 运维自动化容器：**无代码**，只是索引（`README.md`）与两张链路图，把运维面与内容生成面隔开。 | [View Map](ops/codemap.md) |
| `ops/cloudflare-cron/` | Cloudflare Worker 定时任务 watchdog：按 `TARGETS` 逐线判断"最近该跑的时点有没有 run"，缺则补 `workflow_dispatch`；fail-loud 可观测性。 | [View Map](ops/cloudflare-cron/codemap.md) |

未被映射的目录（均为**生成物或外部目录**，已按 codemap 规则排除）：

| Directory | 性质 |
| --- | --- |
| `docs/` | **生成物**（Pages Source）：`index.html` / `data/<date>.json` / `report/<date>.{html,md}` / `summary.json` / `summary.html` / `favicon.svg` / `assets/fonts/chomsky.woff2`。可丢弃、**绝不手改或手工合并**，本地重新生成覆盖。 |
| `data/backfill/` | 生成物：一次性 Search API 回填的日数据（带 `source` / `backfillLimits`）。**故意放在 `docs/` 外**，故站点不可见、不进归档列表，仅作总结的次级数据源。 |
| `assets/` | 生成物：`30-day-activity.svg`。 |
| `.github/` | CI 定义。**`codemap.mjs` 无法扫描它**（见 Notes）。 |

## Flow (whole-system)

```
GitHub API ──┬─ collectDailyData() ──> 日报 JSON ──> generateNarrative() ──> render ──> docs/
             │        (lib/github.mjs)                    (lib/ai.mjs)        (daily/render.mjs)
             ├─ GraphQL+events ────> renderActivityCard() ──> assets/*.svg + README 区块
             └─ docs/data ∪ data/backfill ──> collectSummaryData() ──> validate ──> docs/summary.*
                                                  (summary/collect.mjs)   (summary/validate-summary.mjs)
```

三条线共享两处：`lib/days.mjs`（日期与哈希口径）与 `lib/ai.mjs`（provider 链 + `generateStructured` 重试循环）；渲染层由 `daily/render.mjs` 供 summary 侧复用。各段内部流程见对应子 map。

## Notes

- **`.github/` 无法被 codemap 覆盖**：`codemap.mjs` 的 `walkFiles()` 跳过所有以 `.` 开头的目录（`if (!entry.name.startsWith('.'))`），所以 `--include ".github/workflows/*.yml"` 匹配不到任何文件。这是脚本的硬限制，不是配置错误；workflow 的时点与职责只能靠本文件与 `ops/cloudflare-cron/codemap.md` 记录。改 workflow 时两边（workflow 的 cron 与 watchdog 的 `TARGETS`）必须一起改。
- **`.slim/` 是本地工具状态，已被 `.gitignore` 忽略**：它只是 `codemap.mjs` 的变更检测缓存，不入库；各目录的 `codemap.md` 才入库。
- **刷新本映射**（改了代码后）：`node <skill>/scripts/codemap.mjs changes --root ./` 看变更 → 只更新受影响目录的 `codemap.md` → `node <skill>/scripts/codemap.mjs update --root ./` 存新状态。`init` 只在首次（无 `.slim/codemap.json`）时用。**刷完记得把顶部的「映射基线」换成新的提交号**，否则过期判断会一直停在旧基线。
- **过期判断只认 `scripts` 与 `ops`**：`codemap.mjs` 还索引了根级 `README.md` / `AGENTS.md`（`*.md` include），但 `README.md` 的活动卡片区块每 2 小时被 bot 改写、与架构无关；把它们纳入过期判断会天天误报。真正有架构意义的是 `scripts/**` 与 `ops/**`。
- **本仓没有 `npm test` / `npm run`**：验证一律是 `node scripts/daily/check.mjs`。别去找 `package.json`。
- **本映射是文档，不是生成物**：`codemap.md` 由人/agent 维护，与 `docs/` 那类可丢弃生成物性质不同，改动走分支合并。
