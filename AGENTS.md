# AGENTS.md — sogeisetsu/sogeisetsu

个人主页仓库：把公开的 GitHub 活动渲染成三类产物 —— **每日活动日报**（Pages: https://sogeisetsu.github.io/sogeisetsu/ ，英文默认 / 中文可切换）、**近 30 天 AI 总结**（首页卡片 + `docs/summary.html`）、**近 30 天活动卡片**（回写 `README.md`）。

零依赖：**没有 `package.json`、npm 脚本、构建步骤、测试框架** —— 全部是 `node` 直跑的 ESM，CI 固定 Node 20（用内置 `fetch`）。别找 `npm test` / `npm ci`；唯一的全量"测试命令"是 `node scripts/daily/check.mjs`。

## 三条产物线（各一个自包含 `node` 入口）

| 产物 | 入口 | 触发 |
| --- | --- | --- |
| 日报 → `docs/data/`、`docs/report/`、`docs/index.html` | `scripts/daily/index.mjs` | `update-daily-report.yml`：cron `17 */2 * * *`，另有 push 触发（白名单 `scripts/daily/**`、`scripts/notify-ai-failure.mjs`、`config/**`、它自己） |
| 近 30 天总结 → `docs/summary.{json,html}` + 首页卡片 | `scripts/summary/index.mjs` | `update-summary.yml`：cron `17 22 * * *`（UTC）—— **没有 push 触发，改完必须手动 dispatch** |
| 近 30 天活动卡片 → `assets/30-day-activity.svg` + `README.md` | `scripts/generate-activity.mjs` | `update-activity.yml`：cron `30 */2 * * *`（无 AI） |

`check.yml`（push + PR）只跑 `node scripts/daily/check.mjs`：零 secret、只读、不碰 `docs/`。

## 命令

环境变量：`GITHUB_TOKEN`（`gh auth token`；**可省** —— 无 token 只跑公开段，stars / discussions 等 GraphQL 段静默降级为空）、provider key（**不得提交明文、不得轮换用户的 key**；需要哪些只看 `config/providers.json` 的 `keyEnv`）、`GITHUB_REPOSITORY_OWNER`（默认 `sogeisetsu`，异地复跑用）。

```powershell
# 生成
node scripts/daily/index.mjs                      # 昨天（定稿）+ 今天（滚动）；--date=YYYY-MM-DD 只跑一天
node scripts/daily/index.mjs --rerender            # 只按已存 JSON 重渲染，不抓数据、不调 AI（改渲染 / CSS 后用）
node scripts/daily/index.mjs --no-ai [--dry-run]   # 跳过 AI / 只打印不写文件
node scripts/summary/index.mjs                     # 30 天总结（--rerender / --no-ai / --dry-run / --force 同理）
node scripts/summary/backfill.mjs --from=… --to=… [--force] [--dry-run]   # 一次性 Search 回填，不挂 workflow
node scripts/preview.mjs                           # fixtures → scripts/preview-*.svg（活动卡片目测）

# 预检（提交前必跑）：递归 node --check + 9 套测试 + providers check + verify
node scripts/daily/check.mjs
node scripts/daily/verify.mjs [--quiet]            # 只跑 docs/ 不变式自检

# provider 配置（写操作先打印 diff，--yes 才落盘）
node scripts/providers.mjs list --lane=daily       # 链顺序 + 每条的 key 状态
node scripts/providers.mjs status                  # 本机 env / repo secret / 配置 三方对照
node scripts/providers.mjs check                   # schema + workflow 接线硬断言
node scripts/providers.mjs probe --lane=daily --prompt=real   # 按生产同一套 prompt 探一遍（要 key）

# 单套测试（改哪块跑哪块；零依赖、不触网、不需要 key）
node scripts/test-boundaries.mjs        # 分层边界 / 名称级归属
node scripts/test-schedule.mjs          # 调度对账：workflow cron ↔ Worker TARGETS
node scripts/daily/test-ai.mjs          # AI 适配层（假 HTTP 服务器）
node scripts/daily/test-render.mjs      # 渲染 / 规范化
node scripts/summary/test-summary.mjs   # 30 天总结链路
node scripts/test-activity-window.mjs   # 活动卡片口径 / 可见性
node scripts/test-providers.mjs         # provider 配置 / lane 解析 / 写操作 / 接线断言 / lane 预算
node scripts/daily/test-attribution.mjs # data/attribution.json 归属修正名单
node scripts/daily/test-dataset.mjs     # 数据契约 DAY_FIELDS / HASH_EXCLUDED + 已发布数据哈希复算
```

- 本地看页面：没有 dev server。`python -m http.server <port> --directory docs`。**`.wrap > *` 有入场动画（最多约 1.1s），刚打开就截图会拍到空白** —— 中间插一次 snapshot / scroll 再 capture。
- 无变化时脚本**自行跳过 AI 与写入** —— 这是设计，不是 bug。
- `--force`：绕过 dataHash 跳过，强制重取 + 重调 AI（改了提示词 / 数据口径后用）。日报侧会顺带重取定稿日的评论数**实时值**，属口径变更，慎用。
- 一个 provider key 都没配时，日报 / 总结只能出「确定数字 + AI 暂不可用」版（`--no-ai` 的行为）；真实叙述由 CI 生成。
- `check.mjs` 变红先看 `verify.mjs` 的 summary 窗口那项：它比的是「**最近一次该写出的**总结窗口」（`cstDayMinus(30)..cstDayMinus(1)`，在今天那次总结的写入时点之前 —— cron `22:17` UTC = `06:17` +08，另留 1h 余量 —— 也接受前一天那次的窗口）。**本地 `docs/` 落后一天、或当天总结还没到点都不算回归**；只有窗口停在两天前才 FAIL。仍先 `git pull --rebase --autostash` 排除本地落后。

## 动手前要先知道的几条

- `scripts/cst.mjs` 是三条线共用的 **+08 自然日**口径（零 import）。`cstDateOf` 是唯一正确的「时间戳 → 日期」；**别用 `toISOString().slice(0,10)`**（那是 UTC 日，会把 +08 的 00:00–08:00 归错天）。
- **全站 CSS 在 `scripts/site/css.mjs`**（`pageStyle`），它也定义了首页卡片能用的全部类名；总结页专属样式只能经 `htmlDoc({ extraCss })` 注入，而 **index 页没有这个钩子** —— 卡片上只能用 `pageStyle` 里已有的类。页面外壳 / Markdown / 首页分别在 `scripts/site/{shell,md,indexPage}.mjs`，`scripts/daily/render.mjs` 只剩日报正文。
- `docs/` 是**生成物但必须提交**（Pages Source = `main` / `docs`）：绝不手改、绝不手工合并 HTML/JSON；改了渲染层 / CSS 后要重跑两条 `--rerender` 并提交，否则 CI 的 `verify.mjs` 会红（它拿仓库里的 `docs/` 跟不变式比对）。
- `check.mjs` 的语法检查是**递归扫描** `scripts/` 下每个 `.mjs`（没有清单要维护）；但**新增跨目录 import 要过 `scripts/test-boundaries.mjs`**：七条禁边（lib 不回指表现层、表现层不碰采集/AI、两个 render 不互引、`fileURLToPath` 只许在 `lib/paths.mjs` 等）+ 名称级归属。写错了 `check.mjs` 直接红。
- `data/backfill/<date>.json` 在 `docs/` 之外 → **不站点可见**、不出现在归档列表。
- `ops/**` 推 `main` 会被 Cloudflare Workers Builds 自动构建 + 部署（watchdog，补 GitHub 丢掉的 schedule 触发）；与内容生成无关，细节见 `ops/README.md`。

## AI 生成

**唯一事实来源是 `config/providers.json`**；`scripts/daily/lib/providers.mjs` 解析它，执行细节在 `scripts/daily/lib/ai/`（`structured.mjs` 的 `generateStructured` + `transport.mjs` 的 `attemptProvider`；`ai.mjs` 只是 re-export 的桶）。页面 / 诊断 / 测试都不再各抄一份链。

> **改 `config/providers.json` 必须同步改根目录 `MODELS.md`**：那份文件回答「什么情况下生效 / 在哪些功能上生效 / 每个功能的链是什么」（含不在 lane 里的诊断模型与灾备链）。链顺序 / 模型 / 参数 / 预算 / key 名任何一项变了都算，两边一起提交。**链现状以 `MODELS.md` 为准，本文件不抄第二份。**

- 配置 schema（endpoints / models / lanes 字段与允许的 `params`）见 `assets/providers-cli.md` §5。**`params` 只有 `reasoningEffort` / `extraBody` / `responseFormat` 三个字段**，刻意没有 per-model `maxTokens` / `temperature` / `timeoutMs` —— 少开口子 = 少一处能配错的地方。
- 选型结论（P0 实测，完整表格在 `MODELS.md` §7）：minimax 必须 `reasoningEffort: low`（`none` 会漏编号）；nemotron-ultra 必须默认 `none`（`low` 会到 37–106s，逼近超时）；`nemotron-3.5-lightning` 已淘汰（事实 2/3、格式不合规）；`dots3-note-prev` 只做链尾（生产 prompt 实测 180s 超时）。**要复议就带上这些判据重测**。
- 商汤腿必须带 `extraBody:{thinking:{type:"disabled"}}` 关思考 —— 不关则 reasoning 吃光预算、content 恒为空。
- 配置缺失 / JSON 损坏 / schema 不合法 → warn 并回落内置 `FALLBACK_CHAIN`（deepseek → sensenova），CI 不因一个坏 JSON 全挂；`providers.mjs check` 让它在提交前就红。
- `MAX_TOKENS = 49152`（截断翻倍到 65536）；`CHAT_TIMEOUT_MS = 180000`。lane 预算每次发请求前收敛（剩余 ≤1s 放弃，否则 `timeout = min(180s, 剩余)`）；预算耗尽 → 对**剩余每条腿各补一条合成 attempt** 并照常走失败可见性，**绝不静默截断**。abort / 网络异常不重试，直接换下一条。
- **全失败的可见性**：编排器写 `data/ai-failure.json`（gitignore 的 run 状态）+ 把 `aiFailure` 写进 `docs/data/<date>.json` / `docs/summary.json`；`notify-ai-failure.mjs` 开 / 追加**常驻** issue（label `ai-failure`）、回写 issue 号并重渲染。两个 workflow 保持 0 退出，可见性靠 issue + `::warning::` + `$GITHUB_STEP_SUMMARY` —— 为此需要 `issues: write`。
- **动 notifier 之前先读它的头注释**，两条都是实测坑：① 记录里的 `state:"ok"|"failed"` 才是恢复信号 —— **「没有记录」不等于已恢复**（CI 每次全新 checkout，一次跳过 AI 的运行会误关仍有效的 issue）；② issue 列表在新建后有几秒可见延迟 —— 所以走 REST `/issues`、创建前多确认几次，并在看到多条 open 时保留编号最小的一条、其余追加说明后关闭（自愈）。
- **自动诊断只在「本次新建了常驻 issue」（ok→failed 首次转换）时跑**：notifier 往 `$GITHUB_OUTPUT` 写 `should_diagnose` / `issue_number`，workflow 在**「提交并推送」之后**依次跑 安装 opencode CLI → `diagnose-providers.mjs`（纯脚本证据：失败记录 + 各 `/models` 现状 + 机械对账，不依赖 LLM）→ `diagnose-narrate.mjs`（`opencode run`，LLM 起不来就只留证据）→ `gh issue comment`。agent 那步不注入 GitHub token 并先摘掉 checkout 的 git 凭据；回帖是 workflow 的动作。追加评论的路径不诊断 → 天然去重；同一失败事件另按产物首行 `<!-- ai-diagnosis … -->` 再查重。
- **`DIAGNOSE=1`（workflow_dispatch 勾 `diagnose`）是逃生口**：强制写 `should_diagnose`，让「追加评论」路径也再诊断一次。诊断模型走仓库变量 `DIAG_MODEL`（默认 `opencode-go/deepseek-v4.1-flash`，Go 整体挂掉时换 `sensenova/glm-5.2`）。**凭据不依赖 auth.json**：`OPENCODE_CONFIG_CONTENT` 用 `{env:…}` 注入仓库 secret（实测 auth.json 为空也能调通）。
- **`/oc` 手动入口（`opencode.yml`）**：门是 `comment.user.login == 'sogeisetsu'` 且评论含 `/oc` —— **别人评论的表现是 job `skipped`，不是失败、不计费**。
- 诊断产物 `data/ai-diagnosis.md` 与 `data/ai-failure.json` 同类：gitignore 的 run 状态，不发布、不提交；回帖正文不出现 key / token（证据层异常文本一律过 `sanitizeReason`）。
- NIM 的思考正文在 `message.reasoning_content`（不是 `reasoning`）。

### 加一条腿 / 改链路

`node scripts/providers.mjs add <slug> --endpoint=<ep> --api-model=<id> [--param k=v]... [--lane=daily] [--yes]`

1. 不带 `--yes` 只干跑：打印 unified diff，**不联网、不落盘**。
2. `--yes`：真实探测 3/3（默认 `--prompt=real`，与生产同一代码路径；门槛 = 每次 ≤90s + 非空 + 过校验）—— **不通过就不写配置、不推密钥**。
3. 落盘；secret 默认只做干跑预览（name / 长度 / sha256 前 8 位），`--push-secret` 才真的 `gh secret set`（值走 stdin，绝不 `--body`）。
4. 打印该抄的那行 `KEY: ${{ secrets.KEY }}`；`providers.mjs check` 会指出还缺哪个 workflow / 哪一步。最后跑 `check.mjs`。

- 接线是**硬断言**（纯文本扫描、先剔 `#` 注释行）：跑日报的 workflow 必须有 daily lane 每个 endpoint 的 `secrets.<KEY_ENV>`；跑总结的必须有 summary lane 的；跑诊断的必须有**每个 enabled endpoint** 的。
- **回滚只改往后**：`disable <slug>` 即可（测试断言 lane 顺序、不依赖某条腿 enabled，`check.mjs` 仍绿）；不重写历史日期、不碰 `--force`。
- `config/**` 在日报 workflow 的 push 白名单里：**合并即触发一次真实运行**，这既是验收也是第一次真实证据。

## 发布流程

1. 生成 / 重渲染（见上）。
2. `node scripts/daily/check.mjs` 全绿。
3. `git add scripts config docs assets README.md MODELS.md data/backfill data/attribution.json .github AGENTS.md` → 提交（**中文提交信息用 `git commit -F <msgfile>`，不要用 `-m` 传中文**）→ `git pull --rebase --autostash origin main` → `git push`。代码修改走分支：新建分支 → 合并回 `main` → push。
4. push 后**手动触发 Action，不要等 cron**：`gh workflow run update-daily-report.yml --ref main` / `gh workflow run update-summary.yml --ref main [ -f force=true ]`，再 `gh run watch <run-id> --exit-status`。CI 会把生成物推回 main，本地记得 `git pull --rebase --autostash`。
5. `gh api repos/sogeisetsu/sogeisetsu/pages/builds/latest` 确认 `status: built`。
6. 用 `openchamber_web` 打开线上页（带 `?v=<短哈希>` 击穿缓存）截图确认。

## 与 Action 产物冲突（重要）

两个 workflow 每 2 小时、总结 workflow 每天一次自动提交 `docs/`（活动卡片另提交 `README.md`），手动 `git pull --rebase` 常在生成物上报 CONFLICT。**生成物可丢弃，一律以本地最新代码重新生成为准，绝不手工合并 HTML/JSON：**

```
git rebase --abort
git fetch origin
git reset --soft origin/main   # HEAD 移到远端，脚本改动仍留在 index / 工作区
git checkout HEAD -- docs      # 丢掉本地生成物，改用远端那份当基线
node scripts/daily/index.mjs --rerender
node scripts/summary/index.mjs --rerender
git add scripts docs
git commit -F <msgfile>
git push
```

## 口径与约束

- 公开口径：只用公开活动；**不泄露私有仓库名 / 数量**。
- 提交按 **commit date** 统计；本人与机器人（`[bot]`）**分开且相加**（`count` 与 `automated` 互不相交）；**不含合并提交**（parents>1）。AI 正文（日报叙述 / 总结 overview 与 byRepo）里自动提交也必须写成相加（「另有 M 次」/「plus」），出现「其中/包含…自动提交」会被校验器拒收重试；`AUTOMATED_OVERLAP_RE`（`scripts/lib/rules.mjs`）是唯一口径。
- 提交归属＝`login` 或 `commit.author.name` 命中 `sogeisetsu` 或别名（`COMMIT_AUTHOR_ALIASES`，见 `scripts/daily/lib/github.mjs`，如 `suyue`），大小写不敏感；GitHub 按提交邮箱关联账号，未关联的署名（如本地邮箱 `suyue@localhost`）须列别名才计入本人。
- **`data/attribution.json` 是归属修正数据（两段独立，代码只读它、不内置规则）**：`commits` 只按**完整 40 位 sha** 认（作者字符串可伪造，sha 全局唯一）；`identities` 按 **name + email 精确配对**认，`ownReposOnly` 与 `requireUnlinkedAuthor` **默认都是 true**，要放宽必须显式写 false。两段都只把「其他人类提交（原本静默丢弃）」改判为本人，`messages` 项带 `by: "attribution-sha"` / `"attribution-identity"`；**合并提交 / 机器人 / 窗口过滤 / sha 去重不受影响**。别用它做"占位身份"的长期归一 —— 正解是把仓库 / 全局 `user.name`、`user.email` 配好。
- **事件动作时间一律取 payload 里的业务时间**（`issue/PR.created_at` / `closed_at` / `merged_at`、`comment.created_at`、`review.submitted_at`），不是事件的 `created_at`：GitHub 会重放旧 `IssuesEvent`（实证 #5489 创建 / 关闭后事件流又投一条 `opened`），用事件时间会把昨天已关闭的 issue 算进今天。同一 (仓库, 编号, 动作) 只留最早一条；评论与评审按各自 id 去重。
- **提交扫描只认公开仓库**：`fetchOwnRepos` 用响应里的 `private` / `visibility` 过滤，`selectScanRepos` 再挡一次，`buildCommits` 另对每个待扫仓库走 `isPublicRepo`（fail-closed）。原因：`/users/:u/repos` 对带 `repo` 权限的 token 会连私有仓一起返回，本地跑会把私有仓名 + 提交标题写进 `docs/`；CI 的 `secrets.GITHUB_TOKEN` 只看得到本仓，所以线上一直没暴露。
- `totals` 只由展示数据求和；页面数字与 AI 摘要数字都以此为准。
- Discussions：我发起 / 我评论 + 他人回复并入 replies（`kind=discussion_comment`）；仅公开仓库；不进 `totals` / `empty`（与 releases / stars 一致）。
- Issue/PR 行的评论数（REST 取，含机器人与本人，仅展示，不进 `totals`；仓库非公开或读取失败则不显示）：**Issue＝会话评论**，**PR＝会话评论＋行内评审评论**（与 Replies 段口径对齐）；**窗口已关闭的定稿日冻结已存 JSON 里的快照**，重采集不取实时值（「今天」滚动报仍取实时值；`--force` 会一并重取，是口径变更后的逃生口）。重跑已关闭日期时 `replies` / `stateChanges` 可能比原产物多（历史漏采被补录，属修复而非漂移），被冻结的只有评论数。
- **30 天总结的窗口** = 最近 30 个「已定稿」的 +08 自然日（`cstDayMinus(30)..cstDayMinus(1)`，不含今天）；数据源 = `docs/data` ∪ `data/backfill`，同日两份都有时以 `docs/data` 为准。
- **总结页的数字条完全由代码求和**，AI 只叙述、不计算；`verify.mjs` 逐项核对。
- **总结正文是章节式**：`overview` 3–6 段、约 4200 字符上限，允许行首 `### 小标题`，其余 markdown（列表 / 链接 / 表格 / 代码块 / 斜体）**拒收并触发重试** —— 放宽提示词前先想清楚会不会让模型反复被判违规。
- **窗口区间由代码拼**（AI 只给 headline）：首页卡片里区间单独成行、渲染成 chip（en-dash 形式）；总结页 hero 标题**不含**区间，只在 hero-sub 里加粗（`~` 形式）。两处都必须**单元素内连续** —— `verify.mjs` 逐字查。
- **标题字体**：中英文同一字族（`--headline` == `--headline-zh`，系统衬线栈），**不再使用 Chomsky 黑体**；`verify.mjs` 会挡住"把 Chomsky 加回标题栈"的回退。
- **AI 块旁注 provider / model**：日报 / 总结页 / 首页卡片都在 AI 徽章右侧显示 `provider / model`（历史数据只有 `aiProvider` 时退化成只有 provider）。`.ai-badge` 不参与收缩，窄屏由旁注换行吸收。
- **总结的 AI 输出受严格校验**：`highlights` / `byRepo` 里的仓库与条目编号必须真实存在于输入数据，链接一律由校验器从输入注入（模型不许给 URL）；**AI 不许提任何条目的评论数**。
- **`data/backfill/` 是一次性回填**：事件流只保留最近 300 条 / 90 天，2026-09-16 ~ 10-01 只能用 Search API + 逐条 REST 校时重建，属**近似**（stars 留空、releases 只覆盖自有仓库、评论数不回填），每个文件带 `source: "search-backfill"` 与 `backfillLimits`。窗口每天前移，这批日期会逐日退出窗口。
- **30 天活动卡片的窗口** = 最近 30 个 +08 自然日、**含今天**（`cstDayMinus(29)..cstDayMinus(0)`）；`daily` 柱状也按 +08 自然日分桶（不能用 UTC 日期）。卡片线 `totals` 与日报同一条恒等式：只由**过滤后的公开明细**求和；`contributionsCollection` 标量在 user-scoped token 下含私有贡献，故逐仓 / 逐条按 `isPrivate` / `visibility` 过滤（拿不准一律按不公开），标量只用于对账告警、不进产物。`README.md` 里 `<!--START:activity-->`…`<!--END:activity-->` 必须各出现且仅一次，否则直接 fail。
- 站点 head 与字体受 `verify.mjs` 硬约束（改 head / CSS / 渲染层后**必跑 `check.mjs`**）：必须有 Chomsky `@font-face`（资产保留，但标题栈不得引用）、`--headline` 与 `--headline-zh` 同字族、zh h1 用 `var(--headline-zh)`、favicon 与 `docs/assets/fonts/chomsky.woff2` 实体（wOF2 魔数）都在；**`<head>` 里禁用字体名 `Newsreader` / `霞鹜文楷` / `lxgw`**。
- 不擅自新增依赖；改 CI / 改权限前先确认。代码修改必须走分支：新建分支 → 提交 → 合并回 `main` → push；不要直接在 `main` 上改。

## 已知问题（别当成自己弄坏的）

- 活动卡片线的事件翻页**只认 `Link` 头**（`decideEventPage()`），别用「满页即有下一页」推断 —— 最后一页恰好满页时会请求不存在的页并拿到 `HTTP 422 pagination is limited for this resource`（历史坑，已修）。第 2 页起的 422 / 4xx / 5xx 重试耗尽属「分页到底」：告警 + 停 + 保留已取部分并置 `stoppedByLimit`。**只有第 1 页取不到才 fail**。看到 `stoppedByLimit` 告警是预期行为。
- `update-activity.yml` 没有 push 触发 —— 看到它被 `workflow_dispatch` 触发，是 Cloudflare watchdog 在补 GitHub 丢掉的 schedule，不是有人手动跑。
- `.openchamber/`、`.opencode/`、`.slim/`、`.history/`、`data/ai-failure.json`、`data/ai-diagnosis.md`、`scripts/preview-*.svg`、`assets/_preview.html`、`daily-pipeline.excalidraw` 都在 `.gitignore` 里 —— 不用管，也别提交。

## Repository Map

`codemap.md`（根目录）是文件职责 / 数据流 / 模块边界的权威；深挖某个目录时读该目录下的 `codemap.md`（`scripts/`、`scripts/daily/`、`scripts/daily/lib/`、`scripts/summary/`、`ops/`、`ops/cloudflare-cron/`）。映射只覆盖 `scripts/**` 与 `ops/**`；`docs/` / `data/` / `assets/` 是生成物，不在范围内。

**开始改动前先核对映射是否过期**：判断命令写在 `codemap.md` 顶部（`git log --oneline <基线>..HEAD -- scripts ops ':(exclude)*.md'`，有输出即需复核）。不要用"提交号是否等于 HEAD"判断 —— 本仓每 2 小时有 bot 自动提交生成物，那样会恒报过期。`.slim/` 只是 codemap 工具的本地缓存，不要提交。
