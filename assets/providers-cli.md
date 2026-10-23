# `scripts/providers.mjs` 使用教程

> 面向：要改 AI 链路、换模型、调参数、加一条腿的人。
> 事实来源只有一个：`config/providers.json`。本教程讲的是**怎么用 CLI 安全地改它**，以及改完怎么验证。
>
> 位置说明：本文件是**人工维护的文档**（`assets/` 里其余文件都是生成物）。站点发布的是 `docs/`，
> 所以这里不会出现在 Pages 上，只是仓库内的说明；CLI 的权威行为以 `scripts/providers.mjs`/
> `scripts/daily/lib/providers.mjs` 的代码为准。

---

## 0. 一分钟版

```powershell
# 先看内置帮助（总览 / 某条命令的完整用法）
node scripts/providers.mjs --help
node scripts/providers.mjs help add

# 看现在链路长什么样（只读）
node scripts/providers.mjs list --lane=daily

# 改一条腿的参数 / 临时停用一条腿（先看 diff，再 --yes 落盘）
node scripts/providers.mjs set nvidia-minimax-flash params.reasoningEffort=none
node scripts/providers.mjs disable nvidia-minimax-flash --yes

# 加一条新腿（不带 --yes = 干跑；带 --yes = 探测 3/3 → 落盘）
node scripts/providers.mjs add my-leg --endpoint=nvidia --api-model=vendor/model-id --lane=daily --top --yes

# 提交前必须全绿
node scripts/daily/check.mjs
```

**三条规矩**：写操作默认只打印 diff、`--yes` 才落盘；`add` 探测不通过就不写配置；key 永远不打印。

---

## 1. 前置条件

| 事项 | 说明 |
| --- | --- |
| Node | 20+（仓库零依赖，不需要 `npm install`） |
| 工作目录 | 仓库根（命令里的 `scripts/...` 都是相对仓库根） |
| 配置文件 | `config/providers.json`，**提交进仓**，是链 / 模型 / 参数 / 预算的唯一出处 |
| key | CLI 只读环境变量。`config/providers.json` 里每个 endpoint 有 `keyEnv`，本地没有就跳过那条腿 |
| 需要网络 | 只有 `probe` 与 `add --yes` 联网；`list` / `show` / `status`（repo secret 那列要 `gh`）/ `check` / 所有 `--dry-run` 都不发 AI 请求 |

本机的 NVIDIA key 存在 OpenChamber 的项目变量里（名字是 `Nvidia`），不在 OS 环境变量里。
本地要先导成 `config/providers.json` 认的名字 `NVIDIA_API_KEY`，**不要**把值写进任何文件或命令回显：

```powershell
# 只赋值、不打印；key_length 用来确认非空
$cfg = Get-Content -Raw (Join-Path $env:USERPROFILE ".config\openchamber\environment.json") | ConvertFrom-Json
$env:NVIDIA_API_KEY = $cfg.projects.'path_RTovb3BlbmNvZGUtc2tpbGxzL3JlYWRtZS9zb2dlaXNldHN1'.variables.Nvidia
"key_length=$($env:NVIDIA_API_KEY.Length)"
```

`config/providers.json` 里的 `keyEnvAliases` 是给本地便利用的（`Nvidia` 就是 NVIDIA endpoint 的别名），
所以 `$env:Nvidia = "..."` 也能被识别；CI 里统一用 `NVIDIA_API_KEY`。

---

## 2. 只读命令（随便跑，不写文件、不联网）

> 每条命令都有内置帮助：`node scripts/providers.mjs <命令> --help`（等价 `help <命令>`）。
> 下面只讲「怎么用 + 怎么读输出」，参数全表以 `--help` 为准 —— 它和代码在同一个文件里，不会漂。

### 2.1 `list` —— 链的顺序 + 每条腿的 key 状态

```powershell
node scripts/providers.mjs list --lane=daily     # 只列这条链，按链顺序
node scripts/providers.mjs list                  # 配置里的全部 model（含没进任何链的）
node scripts/providers.mjs list --json           # 机器可读（已剔除 apiKey）
```

实际输出（2026-10-23 的现状）：

```
lane daily（按链顺序）：
slug                   endpoint     apiModel                           enabled  key                      lanes
nvidia-minimax-flash   nvidia       minimaxai/minimax-m3.1-flash       ✓        ✗ (缺 NVIDIA_API_KEY)     daily
nvidia-nemotron-ultra  nvidia       nvidia/nemotron-3-ultra-550b-a55b  ✓        ✗ (缺 NVIDIA_API_KEY)     daily
opencode-go-deepseek   opencode-go  deepseek-v4.1-flash                ✓        ✗ (缺 OPENCODE_API_KEY)   daily,summary
sensenova              sensenova    glm-5.2                            ✓        ✗ (缺 SENSENOVA_API_KEY)  daily,summary

预算：480000ms（8 分钟）
```

怎么读：

- **`slug`** 是稳定身份：`attempts[].provider`、页面 AI 徽章（`via <slug> / <apiModel>`）、历史数据都用它，**不要随便改**。
- **`apiModel`** 才是发给上游的真实模型 id。
- **`key`** 只表示「当前 shell 里有没有这个变量」：`✓ (VAR)` 有，`✗ (缺 VAR)` 没有。
- **`enabled`** 反映 model / endpoint 的 `enabled:false`（`disable` 的结果）。
- `--lane` 写成不存在的链 → 报错并退出码 1。

### 2.2 `show` —— 看一条腿 / 一条链 / 一个 endpoint 的完整 JSON

```powershell
node scripts/providers.mjs show nvidia-minimax-flash
node scripts/providers.mjs show daily
node scripts/providers.mjs show endpoint:nvidia
node scripts/providers.mjs show model:nvidia-minimax-flash      # 显式前缀，避免歧义
```

目标解析规则：显式前缀 `model:` / `lane:` / `endpoint:` 优先；否则按 **model → lane → endpoint** 找。
（`sensenova` 既是 model 也是 endpoint，默认命中 model —— 要改 endpoint 就写 `endpoint:sensenova`。）

`show` 一条 model 时会额外给出 `lanes`（它进了哪些链）、完整的 `endpointDef`，以及 `keyPresent` / `keyEnvUsed`
（**只给布尔与变量名，不给值**）。

### 2.3 `status` —— 本机 env / repo secret / 配置 三方对照

```powershell
node scripts/providers.mjs status
node scripts/providers.mjs status --json
```

```
本机 env / repo secret / 配置 三方对照：
- nvidia-minimax-flash（nvidia / minimaxai/minimax-m3.1-flash）enabled=✓ · lanes=daily · env=✗ 缺 NVIDIA_API_KEY / Nvidia · repo secret=✓ 已设置
- opencode-go-deepseek（opencode-go / deepseek-v4.1-flash）enabled=✓ · lanes=daily,summary · env=✗ 缺 OPENCODE_API_KEY · repo secret=✓ 已设置
...
（env 只看变量是否存在，secret 只看名字；任何 key 值都不会打印）
```

- repo secret 一列靠 `gh secret list`；没登录 / 没网时显示 `? 未知` 并提示原因，不会报错退出。
- `env` 一列显示**实际命中的变量名**（可能是别名）。
- 适合排查「配置里有这条腿，但 CI 里就是不生效」：先看 secret 有没有、再看 config 里的 `keyEnv` 对不对。

### 2.4 `check` —— 配置 schema + workflow 接线（硬断言）

```powershell
node scripts/providers.mjs check
```

```
OK   配置 schema（config\providers.json，4 个 model / 2 条 lane）
OK   workflow 接线（opencode.yml[C] update-daily-report.yml[AC] update-summary.yml[BC]）

providers check OK
```

失败时长这样（会指到文件 + 缺哪个 key + 该加在哪一步）：

```
FAIL workflow 接线
  - .github\workflows\update-daily-report.yml：缺 `secrets.NEW_API_KEY`（诊断链的 endpoint `newep` 需要它）——
    加在运行 `scripts/diagnose-providers.mjs` 那一步的 `env:` 里，形如 `NEW_API_KEY: ${{ secrets.NEW_API_KEY }}`
```

接线规则（纯文本扫描，先剔掉以 `#` 开头的注释行，所以「注释里的 secrets.X」不算数）：

| 规则 | 触发条件 | 必须出现 |
| --- | --- | --- |
| A | workflow 里跑 `scripts/daily/index.mjs` | daily 链里每个 endpoint 的 `secrets.<KEY_ENV>` |
| B | workflow 里跑 `scripts/summary/index.mjs` | summary 链里每个 endpoint 的 |
| C | workflow 里跑 `scripts/diagnose-providers.mjs` | **每个 enabled endpoint** 的（诊断会探所有 `/models`，缺 key 会误报「未配置」） |

这套检查已经挂在 `node scripts/daily/check.mjs` 与 CI 的 `check.yml` 里，所以**漏接线在提交前就会红**。

### 2.5 `probe` —— 用生产的 prompt 真跑一遍（联网，要 key）

```powershell
# 一条腿：默认 3 次、默认 --prompt=real
node scripts/providers.mjs probe nvidia-minimax-flash

# 整条链：默认每条腿 1 次
node scripts/providers.mjs probe --lane=daily --prompt=real

# 只探活（不读 fixture，只花几十 token）
node scripts/providers.mjs probe nvidia-minimax-flash --prompt=small --runs=1

# 和另一条腿比稿（同一份数据，并排打印中英 headline 与英文正文）
node scripts/providers.mjs probe my-leg --compare=opencode-go-deepseek
```

实际输出：

```
fixture：docs\data\2026-10-23.json（--prompt=real，与生产同一套 prompt/校验）

[daily-report] nvidia-minimax-flash: 成功
nvidia-minimax-flash（minimaxai/minimax-m3.1-flash）:
  run 1: ✓ 6161ms · 1454 字符
  run 2: ✓ 4261ms · 1280 字符
  判定：✓ 通过（2/2，单次 ≤90s）
```

- **门槛**：每次都必须过 `ai.mjs` 的同一条代码路径（`buildPrompts` + `validateNarrative`，或 small 模式的探活校验），
  单次 ≤ 90s，输出非空。任何一次失败 → 退出码 1。
- `--prompt=real` 需要 `docs/data/<date>.json` 做 fixture（自动取最新一份）；没有就改用 `--prompt=small`。
- `--compare` **只负责把两边输出并排打出来**：事实准确性 / 中英对称 / 反引号与加粗是否到位，要人来判。
- minimax 这类免费层连续快调会 429（会走「等 2s 重试一次再换腿」），`--runs` 别开太大。

---

## 3. 写操作的三条铁律

1. **默认干跑**：所有写命令都先打印 unified diff；不带 `--yes` 只打印不落盘。`--dry-run` 是显式只读。
2. **失败不写**：`add` 的探测门槛不通过 → 配置一字不改、secret 不推；`set` / `lane` / `enable|disable` 的
   改动如果会让 schema 不合法（比如引用不存在的 slug）→ 直接抛错，也不会落盘。
3. **不碰 key**：`gh secret set NAME` 的值只从 env / stdin 进来，命令里不加 `--body`；输出只给
   名字、长度、sha256 前 8 位。

`--config=<path>` 可以让任何命令改一份临时副本（测试 / 演练用，不碰真配置）。

---

## 4. 常用菜谱

### 4.1 改一条腿的参数

```powershell
node scripts/providers.mjs set nvidia-minimax-flash params.reasoningEffort=none
# 看 diff 满意后：
node scripts/providers.mjs set nvidia-minimax-flash params.reasoningEffort=none --yes
```

- 值的解析顺序：`true` / `false` / `null` / 数字 / JSON 字面量 / 其余按字符串。
- `=null` 是**删掉这个字段**（例：`set daily budgetMs=null` 取消预算）。
- 路径是相对目标对象的，可以建中间层：`set sensenova params.extraBody.thinking.type=disabled`。
- `params` 只允许三个字段：`reasoningEffort` / `extraBody` / `responseFormat`。
  写别的（比如 `temperature`）会被 schema 拒绝 —— 这是刻意的（per-model 数值参数不在设计里，
  慢腿统一由 lane 预算兜住）。

### 4.2 临时停用 / 恢复一条腿（回滚只改往后）

```powershell
node scripts/providers.mjs disable nvidia-minimax-flash --yes    # 写入 enabled:false
node scripts/providers.mjs list --lane=daily                     # 链里少一条
node scripts/providers.mjs enable  nvidia-minimax-flash --yes    # 删掉 enabled 字段
```

- `disable` 之后 `check.mjs` 仍然全绿（测试断言的是 lane 顺序，不依赖某条腿 enabled），可以直接提交。
- **不要为了换 provider 去 `--force` 已定稿的日期**：那会顺带重取评论数实时值，属口径变更。
  回滚只影响往后的运行。

### 4.3 换链顺序

```powershell
node scripts/providers.mjs lane move daily sensenova --top          # 提到链首
node scripts/providers.mjs lane move daily nvidia-nemotron-ultra --before=opencode-go-deepseek --yes
node scripts/providers.mjs lane add  summary nvidia-minimax-flash --before=sensenova --yes
node scripts/providers.mjs lane remove summary nvidia-minimax-flash --yes
```

位置参数四选一：`--top` / `--bottom`（默认）/ `--before=<slug>` / `--after=<slug>`。
`lane add` 遇到「已经在链里」会报错 —— 用 `lane move` 换位置。

### 4.4 改一条链的总预算

```powershell
node scripts/providers.mjs set daily budgetMs=600000 --yes     # 10 分钟
node scripts/providers.mjs set daily budgetMs=null --yes       # 取消上限（总结线现状）
```

预算语义：进入 `generateStructured` 时算 deadline；**每次发请求前**剩余 ≤1s 就放弃，
否则单次 `timeout = min(180s, 剩余)`。预算在腿之间耗尽 → 剩下的每条腿各记一条合成 attempt
（`未尝试（超出 lane 预算 N 分钟）`）并照常走失败可见性（`data/ai-failure.json` + 常驻 issue + 页面失败卡），
**绝不会静默少试一条腿**。

### 4.5 加一条腿（完整流程）

前提：你先拿到「真实 API id」、endpoint 已有（没有就手工加 `endpoints.<name>`）、key 已 export。

```powershell
# ① 先干跑，只看 diff（不联网、不落盘）
node scripts/providers.mjs add nvidia-nemotron-lightning `
  --endpoint=nvidia `
  --api-model=nvidia/nemotron-3.5-lightning-30b-a3b `
  --param reasoningEffort=none `
  --note="P0 淘汰：low 3/3 超时、none 事实错配 + 格式不合规" `
  --lane=daily --top

# ② 确认 diff 后，在同样的命令末尾加 --yes 真跑：探测 3/3 → 落盘 → secret 预览
node scripts/providers.mjs add nvidia-nemotron-lightning `
  --endpoint=nvidia `
  --api-model=nvidia/nemotron-3.5-lightning-30b-a3b `
  --param reasoningEffort=none `
  --note="P0 淘汰：low 3/3 超时、none 事实错配 + 格式不合规" `
  --lane=daily --top --yes

# ③ 真推 repo secret（只有这一步会调用 gh，值走 stdin）
#    在 ② 的命令末尾再加 --push-secret

# ④ 按打印的那行接线，然后全量预检
node scripts/daily/check.mjs
```

各阶段行为：

| 阶段 | 干什么 | 失败时 |
| --- | --- | --- |
| ① diff | 把候选配置与磁盘上的对比打出来 | 没变化就直说「配置没有变化」 |
| ② 探测 | 默认 `--prompt=real`、`--runs=3`，走生产同一套 prompt/校验，单次 ≤90s | **不写配置、不推密钥**，退出码 1 |
| ③ 落盘 | 原子写（tmp + rename），写完立刻做一次 schema 校验 | — |
| ④ secret | 默认只预览 `name / 长度 / sha256 前 8 位`；`--push-secret` 才 `gh secret set` | 打印 gh 的错误，不改配置 |

常用可选参数：

- `--param k=v`（可重复）：`reasoningEffort=low`、`responseFormat=false`、
  `extraBody.thinking.type=disabled`（点号表示嵌套）。
- `--note="..."`：**写清「为什么这条腿在链里 / 为什么不在」** —— 半年后只有这条注释能回答。
- `--lane=daily` + `--top|--bottom|--before/--after`：加进链的同时定位。
- `--prompt=small`：没有 `docs/data` fixture 时用；`--runs=N` 覆盖次数。
- `--push-secret`：需要当前 shell 里该 endpoint 的 key 有值。

> 判据要求：新腿「入链」前应当先跑过 `probe --compare=<现有稳定腿>`，人工确认
> **事实正确 / 中英对称 / 反引号与加粗到位**。脚本只能自动挡住「结构合法 + 耗时」，
> 挡不住「说得对不对」。`nvidia-nemotron-lightning` 就是被这三项判掉的：唯一能用的 `none`
> 下事实 2/3、格式 3/3 不合规，开 `low` 则 3/3 挂满 180s。

### 4.6 彻底删掉一条腿

```powershell
node scripts/providers.mjs lane remove daily my-leg --yes
node scripts/providers.mjs lane remove summary my-leg --yes   # 进了几条链就摘几次
```

然后把 `config/providers.json` 里 `models."my-leg"` 那一块手工删掉（**没有** `rm` 子命令是刻意的：
删配置比加配置更容易误伤，留给人工 + diff 审阅）。改完再跑：

```powershell
node scripts/providers.mjs check
node scripts/daily/check.mjs
```

只摘链、不删 model 也合法（`catalogue` 会把它列出来，但 `providersForLane` 不会用它）。

---

## 5. 配置 schema 速查

```jsonc
{
  "version": 1,
  "endpoints": {
    "nvidia": {
      "baseUrl": "https://integrate.api.nvidia.com/v1",
      "keyEnv": "NVIDIA_API_KEY",          // 必填：环境变量名（永不存明文 key）
      "keyEnvAliases": ["Nvidia"],         // 可选：本地别名
      "headers": { "x-opencode-session": "…${session}" },  // 可选；${session} 一次调用一个 UUID
      "modelsUrl": "https://…/v1/models",  // 可选：/models 端点（不写就按 baseUrl 派生）
      "shape": "chat"                      // 可选：chat | responses
    }
  },
  "models": {
    "nvidia-minimax-flash": {              // slug = 稳定身份
      "endpoint": "nvidia",
      "apiModel": "minimaxai/minimax-m3.1-flash",
      "enabled": true,                     // 可选；false = 跳过（enable/disable 会增删它）
      "params": { "reasoningEffort": "low" },   // 可选；只有三个字段
      "note": "为什么它在链里"
    }
  },
  "lanes": {
    "daily":   { "order": ["…", "opencode-go-deepseek", "sensenova"], "budgetMs": 480000 },
    "summary": { "order": ["opencode-go-deepseek", "sensenova"] }
  }
}
```

校验会拦住：缺 `version` / `endpoints` / `lanes`；model 指向不存在的 endpoint；lane 引用不存在的 slug
或同一条腿重复；同一 endpoint 下两个 slug 用同一个 `apiModel`；`params` 里的未知字段；`budgetMs` 不是正数。

配置坏了（读不到 / JSON 坏 / schema 不合法）时，运行时会 warn 并回落到内置 `FALLBACK_CHAIN`
（`opencode-go-deepseek` → `sensenova`），保证 CI 不会因为一个坏 JSON 全挂；
但 `providers check` 会让它在提交前就红。

---

## 6. 常见报错对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `缺 key：环境变量 X 未设置` | 当前 shell 没 export，或别名也没命中 | 按第 1 节赋值；`status` 看 env 列 |
| `lane daily 没有可用 provider（缺 key？看 status）` | 整条链的 key 都没配 | 同上 |
| `探测未通过（fail / 120000ms）——不写配置、不推密钥` | 上游 401/429/超时/输出不合校验 | 看上面打印的每次 run 与 provider 日志；先 `probe --runs=1` 单跑 |
| `HTTP 429` | 免费层 RPM 限制（连续快调） | 间隔几秒再跑；`--runs` 别调大；生产一次运行最多两次 AI 调用 |
| `改动会让配置不合法：…` | 引用了不存在的 slug / 参数名写错 | 按报错改；`show` 看真实字段名 |
| `FAIL workflow 接线` | 新 endpoint 没在相关 workflow 的 step 里注入 key | 按报错给的文件与 step 抄那一行；**不自动改 workflow** 是刻意的 |
| `配置不可用（…），回落到内置 FALLBACK_CHAIN` | 配置文件坏了 | `check` 看完整报错；修好再跑 |
| `providers check FAILED` | schema 或接线不达标 | 先修配置，再补 workflow env |

---

## 7. 提交前检查清单

```powershell
node scripts/providers.mjs check        # 配置 schema + workflow 接线
node scripts/daily/check.mjs            # 全量预检（语法 + 5 套测试 + providers check + docs 不变式）
```

- 改了 `config/**` → 合并后会**自动触发**一次真实日报（它在日报 workflow 的 push 白名单里）。
- 改了 `scripts/summary/**` → 总结 workflow **没有** push 触发，要手动 dispatch。
- 提交信息用 `git commit -F <msgfile>`（中文不要用 `-m`）。
- 生成物 `docs/` 绝不手改 / 手工合并；冲突时按 AGENTS.md「与 Action 产物冲突」重生成。

---

## 附录：命令速查

```
node scripts/providers.mjs add <slug> --endpoint=<ep> --api-model=<id> [--param k=v]...
      [--lane=daily] [--note=…] [--top|--bottom|--before=<slug>|--after=<slug>]
      [--prompt=real|small] [--runs=3] [--yes] [--push-secret]
node scripts/providers.mjs probe <slug> | --lane=<lane> [--prompt=real|small] [--runs=N] [--compare=<slug>]
node scripts/providers.mjs status [--json]
node scripts/providers.mjs check
node scripts/providers.mjs list [--lane=<lane>] [--json]
node scripts/providers.mjs show <slug|lane|endpoint:NAME|model:SLUG>
node scripts/providers.mjs lane add|remove|move <lane> <slug> [--top|--bottom|--before=<slug>|--after=<slug>]
node scripts/providers.mjs set <slug|lane|endpoint:NAME> <path>=<value>
node scripts/providers.mjs enable|disable <slug>
node scripts/providers.mjs help [命令]        # 等价 <命令> --help

全局：--config=<path>（改一份临时副本）· --dry-run（显式只读）· --yes（落盘）·
      -h/--help（总览；放在命令后面是该命令的完整用法）
退出码：check / probe / add 失败 → 1；未知命令（含 help 未知命令）→ 1；只读命令成功 → 0
```
