# ops/

运维相关的自动化，跑在 GitHub 与 Cloudflare 上，与日报的生成逻辑无关。

| 路径 | 作用 |
| --- | --- |
| `cloudflare-cron/` | 定时任务 watchdog（Cloudflare Worker + Cron Trigger）：GitHub 的 `schedule` 丢触发时补一次 `workflow_dispatch`，兜日报和近 30 天活动卡片两条线。已接 Workers Builds，改这个目录推 `main` 会自动构建部署，见 [README](./cloudflare-cron/README.md) |
| `cloudflare-cron/flow.excalidraw` | 运行链路图：watchdog 每 10 分钟怎么判断、以及它不参与内容生成 |
| `cloudflare-cron/flow-push.excalidraw` | 推送流程图：往 `main` 推一次提交之后会发生什么（含自动提交为什么会自己停） |

两张图用 OpenChamber 的 Excalidraw 扩展打开（Files 视图里点开就是可编辑画布）。
