# 定时任务 watchdog（Cloudflare Worker）

GitHub Actions 的 `schedule` 是 best-effort：本仓两个 workflow 单日各 12 个时点，实测只跑 3~4 个，
且丢掉的时点**不产生任何 run**，所以既没有失败告警也没有页面提示。

`worker.mjs` 每 10 分钟，对下面两个 target **分别**检查一遍「它最近那个该跑的时点有没有 run」，
没有就补一次 `POST /actions/workflows/<file>/dispatches`。GitHub 正常投递时它什么都不做，
因此不产生重复 run。

| target | workflow | 自己的时刻 | 内容 | 时间敏感度 |
| --- | --- | --- | --- | --- |
| `daily` | `update-daily-report.yml` | UTC 偶数小时 **:17** | 日报（AI 生成） | 高：晚一小时页面就停在上一次 |
| `activity` | `update-activity.yml` | UTC 偶数小时 **:30** | 近 30 天活动卡片（无 AI） | 低：滚动窗口，晚几小时看不出来 |

> 这两条时间线**不是一回事**，各自算各自的 slot（`TARGETS` 里一份配置一个），不能互相顶替：
> 日报补过了不代表卡片跑过，反过来也一样。

`../.github/workflows/` 里两个 workflow 的 cron 与 push 触发保持不变，作为第一层；这个 Worker 是兜底。

## 需要你自己做的（我碰不到你的 Cloudflare / GitHub 账号）

### 1. 建 fine-grained PAT

浏览器：GitHub → 头像 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token

- Resource owner: `sogeisetsu`
- Repository access: **Only select repositories** → `sogeisetsu/sogeisetsu`
- Permissions → Repository permissions → **Actions: Read and write**（其余全留 No access）
- Expiration: 本项目当前用的是 **No expiration**（2026-10-08 决定）。理由是：watchdog 挂了不会有任何
  外部提醒，而 90 天到期后 token 静默失效、成功率高掉才是唯一的信号。想更保守就选 90 天并自己记日历轮换
  ——但"到期忘了换"这个失败模式和"cron 丢触发"一样安静。
- 生成后立刻复制（只显示一次）

它只多给「触发这一个仓库的 workflow」的权限，不动任何仓库设置、成员或代码内容。

### 2. 建 Worker（全程在浏览器，不用装任何东西）

1. 注册/登录 https://dash.cloudflare.com（Workers Free 按文档不收费；免费套餐要不要绑卡我没验证到）。首次用 Workers 会让你设一个 `*.workers.dev` 子域。
2. Workers & Pages → Create → Workers → Start with Hello World → 名字填 `sogeisetsu-daily-watchdog` → Deploy。
3. 编辑代码：把 `worker.mjs` 全文粘进去（在线编辑器是 `src/index.js`，粘进去即可）→ Deploy。
4. Settings → Variables and Secrets → Add → 类型选 **Secret**，名字 `GITHUB_TOKEN`，值粘第 1 步的 token → Deploy。
5. Settings → Triggers → **Cron Triggers** → Add → 表达式 `*/10 * * * *`（UTC）。
6. 验证运行时：Settings → Trigger Events → **View events**（最近 100 次 `console.log`），或 Workers Logs。
   （`wrangler.toml` 里 `workers_dev = false`，所以没有对外的 `/cdn-cgi/handler/scheduled` 可以手动触发。）

> Dashboard 的菜单名可能随版本微调，路径不变：Worker → 代码、Settings → 变量/密钥、Settings → Triggers → cron。

### 3. 验收

挑一个被 GitHub 丢掉的时点看：`slot + graceMinutes` 之后 worker 日志出现
`[daily] … 没有 run，已补一次 workflow_dispatch` 或 `[activity] … 已补一次 workflow_dispatch`，
同时对应 workflow 的 Actions 里出现一个 `event=workflow_dispatch` 的 run。
日志前缀 `[daily]` / `[activity]` 就是用来分辨是哪条线的。

日常盯一个数就够：Settings → Triggers 的 **Invocations 成功率**。worker 不吞错——API 调用
失败会抛异常，这次 invocation 记为失败，成功率直接掉；相反"成功率 100%"才算正常。日志细节
在 Settings → Trigger Events（Workers Logs 已开）。

## 踩过的坑

### secret 里混进 BOM → GitHub 401 Bad credentials

在 Windows PowerShell 5.1 里用管道塞 secret（`... | wrangler secret put GITHUB_TOKEN`），
`$OutputEncoding` 若被设成 UTF-8，会把 `\uFEFF` 写在值开头。Cloudflare 原样存下，
Worker 拼进 `Authorization` 头就成了非 ASCII，GitHub 回 `401 Bad credentials`。

- `worker.mjs` 已用 `String(env.GITHUB_TOKEN).trim()` 兜底（JS 的 `trim` 会去掉 U+FEFF）。
- 想彻底避免：先 `$OutputEncoding = New-Object System.Text.ASCIIEncoding` 再管道，或者在 Dashboard 里手填。
- 排错时可以看 Worker → Settings → Triggers 的 **Invocations**（成功率），或 `wrangler tail`。

### `wrangler tail` 会在日志里打出 token

当发出去的 header 含非 ASCII 时，Cloudflare 会警告并把**整个 header 值**写进日志——
也就是把你的 token 明文打进 tail 输出，连带落进终端记录。用 tail 排查 secret 类问题时要留意，
真出了事就吊销重发那个 token。

## 可调参数（`worker.mjs` 顶部的 `TARGETS`）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `slotMinute` / `hourStep` | `17`/`2`（daily）、`30`/`2`（activity） | 必须与各自 workflow 里的 cron 对齐；改 cron 时两边一起改 |
| `graceMinutes` | `30`（两个都是） | 宽限期。调大 → 更少重复 run、页面更慢；调小 → 更快追上、GitHub 迟到时会重复 |
| `label` | `daily` / `activity` | 只影响日志前缀，排错时用来区分是哪条线 |

想再加一个被兜的 workflow：往 `TARGETS` 里加一项、把它的 `slotMinute` 对齐到那个 cron 的分钟即可，
其余逻辑不用动。

重复 run 的代价很小：日报 `scripts/daily/index.mjs` 有 dataHash 跳过，数据没变时不调 AI、不写文件；
活动卡片重跑后没有 diff，`git diff --cached --quiet ||` 会跳过 commit。

## 想用 wrangler 版本化部署（可选）

需要本机 `npm i -g wrangler`（多一个本地工具），然后在该目录加 `wrangler.toml`：

```toml
name = "sogeisetsu-daily-watchdog"
main = "worker.mjs"
compatibility_date = "2026-10-01"

[triggers]
crons = ["*/10 * * * *"]
```

```sh
wrangler secret put GITHUB_TOKEN
wrangler deploy
```
