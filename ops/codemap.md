# ops/

## Responsibility

运维自动化的容器目录：**跑在 GitHub 与 Cloudflare 上、与内容生成逻辑无关**的兜底基础设施。目前只有一个子项目 `cloudflare-cron/`（定时任务 watchdog），外加一份人类可读的索引与两张链路图。

- `README.md` —— 目录索引：用一张表说明 `cloudflare-cron/` 与两张 `.excalidraw` 图各自的作用。
- `cloudflare-cron/` —— Cloudflare Worker 定时任务 watchdog，有自己的 codemap（`ops/cloudflare-cron/codemap.md`），此处只按路径引用。
- `cloudflare-cron/flow.excalidraw` / `flow-push.excalidraw` —— 运行链路图与推送流程图（用 OpenChamber 的 Excalidraw 扩展打开，是可编辑画布，不是构建产物）。

目录本身**没有代码**：没有任何 `.mjs` / `.toml` 落在 `ops/` 这一层，逻辑全在子目录。因此本层不承担设计或流程，只承担「分区 + 索引」职责——把「运维兜底」与 `scripts/` 下的内容生成彻底隔开，避免改生成逻辑时误碰部署面。

## Design

- **物理隔离的运维边界**：`ops/` 与 `scripts/` 是两条互不 import 的线。`ops/README.md` 明确写了 watchdog「与日报的生成逻辑无关」；反向也成立——`scripts/` 下没有任何文件引用 `ops/`。
- **索引式 README**：目录用一张「路径 → 作用」表作为唯一入口，细节下沉到子目录自己的 `README.md`，不在此重复。
- **图即文档**：两张 `.excalidraw` 以源文件形式入库（JSON 画布），由外部扩展渲染，仓库侧不引入任何图形依赖或构建步骤——与全仓「零依赖」一致。

## Flow

本层没有运行时数据流。控制流只有一条：**读者/agent 从 `ops/README.md` 的表格进入 → 按需跳转到 `cloudflare-cron/README.md`（运维手册）或两张链路图**。真正的执行流（每 10 分钟的 cron tick、slot 判断、补 `workflow_dispatch`）全在 `ops/cloudflare-cron/`，见该目录的 codemap。

## Integration

- Consumed by: 人类与 agent 的入口导航（`ops/README.md`）；Cloudflare Workers Builds 的 Git 集成直接指向子目录 `ops/cloudflare-cron`（Root directory），**Include paths 白名单是 `ops/cloudflare-cron/**`**，所以在本层 `ops/` 下增删文件不会触发部署，只有子目录内的改动才会。
- Depends on: 无代码依赖。仅依赖 GitHub（第一层 cron / 手动 dispatch）与 Cloudflare（Worker + Cron Trigger）两个外部平台。

## Notes

- `ops/README.md` 的表里写 watchdog「兜日报和近 30 天活动卡片**两条线**」，但 `ops/cloudflare-cron/worker.mjs` 的 `TARGETS` 实际有**三条**（`daily` / `activity` / `summary`）。以代码为准，本层 README 这句落后于实现。
- `flow.excalidraw` / `flow-push.excalidraw` 是手绘源文件，不进构建、不被任何脚本读取；改动链路后需手动同步这两张图，没有自动校验兜底。
