# ops/cloudflare-cron/

Cloudflare Worker 定时任务 watchdog：兜 GitHub Actions `schedule` 的 best-effort 投递（本仓实测单日 12 个时点只中 3~4 个，且丢触发不产生任何 run、无任何告警）。零构建步骤，单文件 `worker.mjs` + `wrangler.toml`。

## Responsibility

- 对三条 workflow 各自独立地回答「它最近那个该跑的时点有没有 run」，没有就补一次 `POST /actions/workflows/<file>/dispatches`；GitHub 健康时什么都不做，不产生重复 run。
- 兜底对象（`TARGETS`，三条线时间表不同、各算各的、不能互相顶替）：
  - `daily` → `update-daily-report.yml`，UTC 偶数小时 :17（`slotMinute: 17` + `hourStep: 2`）；
  - `activity` → `update-activity.yml`，UTC 偶数小时 :30（`slotMinute: 30` + `hourStep: 2`）；
  - `summary` → `update-summary.yml`，每天 UTC 22:17（`slotMinute: 17` + `slotHourUtc: 22`）。
- 不替代第一层：`../.github/workflows/` 的 cron 与 push 触发保持不变，Worker 只是兜底。
- 非目标：无对外 URL（`workers_dev = false`，`fetch` handler 只是占位）；不改 workflow、不动仓库设置。

## Design

- **声明式 `TARGETS` 配置 + slot 推算**：每个 target 一条配置（`label` / `workflow` / `slotMinute` / `hourStep` 或 `slotHourUtc` / `graceMinutes`），调度语义收敛进纯函数 `lastDueSlot(nowMs, target)`。加一个被兜的 workflow = 加一项配置，逻辑不动。
- **两种调度表达二选一**（`lastDueSlot` 内分支）：
  - `slotMinute` + `hourStep`：「每 N 小时的第 slotMinute 分」——先取本小时 slotMinute，未到则退 1 小时，再按 `getUTCHours() % hourStep === 0` 逐小时回退到对齐小时；
  - `slotHourUtc`（0–23 整数）：「每天固定 UTC 该小时第 slotMinute 分」——取当天该时刻，晚于 now 整体退 24h，**不走 hourStep 回退**。存在原因：老的逐小时回退算法会把「每天 22:17」错算成 00:17，`summary` 必须用这种写法。
- **`graceMinutes` 宽限期**：GitHub 自己的 schedule 实测迟到 +1~+47 分钟；slot 刚过就补会与迟到的 schedule 撞成两个 run。默认 30 分钟；调大 → 更少重复 run 但页面更慢，调小反之。重复 run 代价低：日报有 dataHash 跳过（不调 AI 不写文件）、活动卡片无 diff 不 commit、总结有窗口哈希跳过。
- **fail-loud 可观测性**：任何 API 失败（查 runs、dispatch、缺 token）都不吞错——`console.error` 后直接 `throw`，Cloudflare 把该次 invocation 记为失败，Dashboard 的 Invocations 成功率掉 = 自带告警。目标是避免「成功率 100% 但每次都在 401」这种只有翻日志才看得见的状态。各 target 用 `Promise.allSettled` 并发互不阻塞，但只要有一个 rejected，`scheduled` 整体再抛一次 → 任一失败即本次 invocation 失败。
- **判断成本极低**：每 target 每 tick 仅 1 次列表查询（`per_page=20` + `created=>=<slot-60s>` 过滤，60 秒时钟余量），有缺失才多 1 次 dispatch。
- 配套：`[observability] enabled = true` 开 Workers Logs（401 期间曾因关闭只能靠 `wrangler tail` 才看见）；`[triggers] crons = ["*/10 * * * *"]` 必须写在 `wrangler.toml` 里（Dashboard 不读它），且注释里不能出现 `*/` 字面量（会提前闭合块注释）。

## Flow

1. **进入**：Cloudflare 每 10 分钟 cron tick 触发 `scheduled(controller, env, ctx)`，时间取 `controller.scheduledTime`。
2. **token 准备**：`String(env.GITHUB_TOKEN).trim()` 后非空校验——`trim()` 兼作防御，去掉管道写入时可能混进的 BOM（U+FEFF）/首尾空白，否则拼进 `Authorization` 头变非 ASCII，GitHub 直接 401。缺失则抛。
3. **每 target 独立判断**（`checkAndFill`，三者 `Promise.allSettled` 并发）：
   a. `lastDueSlot` 算出该 target 最近该跑的时点 slot；
   b. `nowMs - slot < graceMinutes` → `skip-grace`（日志记录，GitHub 还可能迟到）；
   c. 查该 workflow 自 `slot - 60s` 以来的 runs → 有 run → `skip-exists`（附最新 run 的 event/status/conclusion 供排错）；
   d. 无 run → `POST .../dispatches`（`{ref: "main"}`）→ 204 即 `dispatched`。
4. **状态转移**：`skip-grace` → 下一 tick 再看；`skip-exists` / `dispatched` → 本次结束。三种结局都有带 `[label]` 前缀的日志，前缀用于分辨哪条线。
5. **离开**：全部 settled 后若存在 rejected → 汇总失败消息整体 `throw`（invocation 记失败，成功率掉）；全成功则静默结束。产物是 GitHub 上一个 `event=workflow_dispatch` 的 run（缺失时），Worker 自身无状态、不落盘。

## Integration

- Consumed by: Cloudflare Workers cron trigger（`*/10 * * * *` UTC）；运维观察口是 Dashboard → Worker → Settings → Trigger Events / Workers Logs / Invocations 成功率。补触发落到 GitHub Actions，走各 workflow 自己的生成链路（`scripts/daily/`、活动卡片脚本、`scripts/summary/`），与本地 `node scripts/...` 手动跑完全同路径。
- Depends on: `env.GITHUB_TOKEN`（运行时 secret，fine-grained PAT，仅 `sogeisetsu/sogeisetsu` 一仓、Actions: Read and write，2026-10-08 起 No expiration）；GitHub REST API（`api.github.com` 的 workflow runs 列表与 dispatch 端点）；三个 workflow 文件名与 `TARGETS` 里的 cron 保持对齐（改 workflow cron 必须两边一起改）。部署侧：Cloudflare Workers Builds 的 Git 集成（推 `ops/cloudflare-cron/**` 到 `main` 自动 `npx wrangler deploy`）或本地 `wrangler deploy`。

## Notes

- **Include paths 必须是白名单 `ops/cloudflare-cron/**`**：本仓每 2 小时有 `docs/` 日报自动提交，留默认 `*` 等于每 2 小时白构建一次（先排 exclude、再比 include；UI 不落盘时走 Cloudflare Builds API PATCH `path_includes`）。
- **两套凭证体系**：`GITHUB_TOKEN` 是 Worker 的**运行时 secret**（`wrangler secret put` 或 Dashboard 手填），与 Workers Builds 的构建变量不随 Git 走、不互相暴露。
- secret 用 PowerShell 管道写入时易混进 BOM → 401（代码里 `trim()` 已兜底；根治：管道前设 ASCIIEncoding 或 Dashboard 手填）。
- `wrangler tail` 在 header 含非 ASCII 时会把整个 header 值（含 token 明文）打进日志——排 secret 类问题时留意，泄露即吊销重发。
- `workers_dev = false` 的代价：不能用 `/cdn-cgi/handler/scheduled` 手动触发 `scheduled`，手动跑只能走 Dashboard（或临时打开 workers.dev）。
- `summary` 的 `slotHourUtc` 不可退回 `hourStep` 写法（会把 22:17 错算成 00:17）；PAT 选 No expiration 的理由是「watchdog 挂了没有外部提醒，token 静默失效、成功率高掉是唯一信号」。
