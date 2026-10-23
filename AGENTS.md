# AGENTS.md — sogeisetsu/sogeisetsu

个人主页仓库。产物三个：**每日 GitHub 活动日报**（Pages: https://sogeisetsu.github.io/sogeisetsu/ ，英文默认 / 中文可切换）、**近 30 天 AI 总结**（首页卡片 + `docs/summary.html`）、**近 30 天活动卡片**（回写 `README.md`）。

零依赖：**没有 `package.json`、没有 npm 脚本、没有构建步骤、没有测试框架** —— 全部是 `node` 直跑的 ESM，CI 固定 Node 20（用内置 `fetch`）。别去找 `npm test` / `npm ci`；唯一的全量"测试命令"是 `node scripts/daily/check.mjs`。

## 三条产物线（各一个自包含 `node` 入口）

| 产物 | 入口 | 触发 |
| --- | --- | --- |
| 日报 → `docs/data/`、`docs/report/`、`docs/index.html` | `scripts/daily/index.mjs` | `update-daily-report.yml`：cron `17 */2 * * *`，另有 push 触发（白名单 `scripts/daily/**`、`scripts/notify-ai-failure.mjs`、`config/**`、它自己） |
| 近 30 天总结 → `docs/summary.{json,html}` + 首页卡片 | `scripts/summary/index.mjs` | `update-summary.yml`：cron `17 22 * * *`（UTC）—— **没有 push 触发，改完必须手动 dispatch** |
| 近 30 天活动卡片 → `assets/30-day-activity.svg` + `README.md` | `scripts/generate-activity.mjs` | `update-activity.yml`：cron `30 */2 * * *`（无 AI） |

`check.yml`（push + PR）只跑 `node scripts/daily/check.mjs`：零 secret、只读、不碰 `docs/`。

## 动手前要先知道的几条

- `scripts/cst.mjs` 是三条线共用的 **+08 自然日**口径（零 import）。`cstDateOf` 是唯一正确的「时间戳 → 日期」；**别用 `toISOString().slice(0,10)`**（那是 UTC 日，会把 +08 的 00:00–08:00 归错天）。
- **全站 CSS 在 `scripts/site/css.mjs`**（`pageStyle`），它也定义了首页卡片能用的全部类名；总结页专属样式只能经 `htmlDoc({ extraCss })` 注入，而 **index 页没有这个钩子** —— 卡片上只能用 `pageStyle` 里已有的类。页面外壳 / Markdown / 首页分别在 `scripts/site/{shell,md,indexPage}.mjs`，`scripts/daily/render.mjs` 只剩日报正文。
- `docs/` 是**生成物但必须提交**（Pages Source = `main` / `docs`）：绝不手改、绝不手工合并 HTML/JSON；改了渲染层 / CSS 后要重跑两条 `--rerender` 并提交，否则 CI 的 `verify.mjs` 会红（它拿仓库里的 `docs/` 跟不变式比对）。
- `check.mjs` 的语法检查是**递归扫描** `scripts/` 下每个 `.mjs`（没有清单要维护）；新脚本自动纳入。但**新增跨目录 import 要过 `scripts/test-boundaries.mjs`**：七条禁边（lib 不回指表现层、表现层不碰采集/AI、两个 render 不互引、`fileURLToPath` 只许在 `lib/paths.mjs` 等）+ 名称级归属。写错了它在 `check.mjs` 里直接红。
- `data/backfill/<date>.json` 在 `docs/` 之外 → **不站点可见**、不出现在归档列表。
- `ops/**` 推 `main` 会被 Cloudflare Workers Builds 自动构建 + 部署（watchdog，补 GitHub 丢掉的 schedule 触发）；与内容生成无关，细节见 `ops/README.md`。
- 每文件职责、数据流、模块边界以 `codemap.md` 为准（文末有「映射是否过期」的判断方法）；本文件只留会改变你行为的部分。

## 本地运行

环境变量：`GITHUB_TOKEN`（`gh auth token`；**可省** —— 无 token 只跑公开段，stars / discussions 等 GraphQL 段静默降级为空）、provider key（**不得提交明文、不得轮换用户的 key**）—— 需要哪些只看 `config/providers.json` 的 `keyEnv`：`NVIDIA_API_KEY`（本地 OpenChamber 项目变量叫 `Nvidia`，配置里以 `keyEnvAliases` 表达）/ `OPENCODE_API_KEY` / `SENSENOVA_API_KEY`、`GITHUB_REPOSITORY_OWNER`（默认 `sogeisetsu`，异地复跑用）。

```
node scripts/daily/index.mjs                      # 昨天（定稿）+ 今天（滚动）；--date=YYYY-MM-DD 只跑一天
node scripts/daily/index.mjs --rerender            # 只按已存 JSON 重渲染，不抓数据、不调 AI（改渲染 / CSS 后用）
node scripts/daily/index.mjs --no-ai [--dry-run]   # 跳过 AI / 只打印不写文件
node scripts/summary/index.mjs                     # 近 30 天总结（--rerender / --no-ai / --dry-run / --force 同理）
node scripts/summary/backfill.mjs --from=… --to=… [--force] [--dry-run]   # 一次性 Search 回填，不挂 workflow
node scripts/preview.mjs                           # fixtures → scripts/preview-*.svg（活动卡片目测）
node scripts/daily/check.mjs                       # 全量预检：递归语法检查 + 分层边界 + 调度对账 + 7 套测试 + providers check + verify（提交前必跑）
node scripts/daily/verify.mjs [--quiet]            # 只跑 docs/ 不变式自检
# provider 配置（改链路 / 改参数 / 加腿；写操作先打印 diff，--yes 才落盘）：
node scripts/providers.mjs list --lane=daily       # 链顺序 + 每条的 key 状态
node scripts/providers.mjs status                  # 本机 env / repo secret / 配置 三方对照（只读）
node scripts/providers.mjs check                   # 配置 schema + workflow 接线硬断言（只读）
node scripts/providers.mjs probe --lane=daily --prompt=real   # 按生产同一套 prompt 探一遍（要 key）
# 单套测试（改哪块跑哪块，比全量快；都是零依赖、不触网、不需要 key）：
node scripts/test-boundaries.mjs       # 分层边界 / 名称级归属（合成图自测，不触网）
node scripts/test-schedule.mjs         # 调度对账：workflow cron ↔ Worker TARGETS
node scripts/daily/test-ai.mjs         # AI 适配层（假 HTTP 服务器）
node scripts/daily/test-render.mjs     # 渲染 / 规范化
node scripts/summary/test-summary.mjs  # 30 天总结链路
node scripts/test-activity-window.mjs  # 活动卡片口径 / 可见性
node scripts/test-providers.mjs        # provider 配置 / lane 解析 / 写操作 / 接线断言 / lane 预算
node scripts/daily/test-attribution.mjs # data/attribution.json 归属修正名单
node scripts/daily/test-dataset.mjs    # 数据契约 DAY_FIELDS / HASH_EXCLUDED + 已发布数据哈希复算
```

- 本地看页面：没有 dev server。`python -m http.server <port> --directory docs`，再开 `http://localhost:<port>/index.html`。**`.wrap > *` 有入场动画（最多约 1.1s），刚打开就截图会拍到空白** —— 中间插一次 snapshot / scroll 再 capture。
- 无变化时脚本**自行跳过 AI 与写入** —— 这是设计，不是 bug。
- `--force`：绕过 dataHash 跳过，强制重取 + 重调 AI（改了提示词 / 数据口径后用）。日报侧会顺带重取定稿日的评论数**实时值**，属口径变更，慎用。
- 配置里的 provider 一个 key 都没配时，日报 / 总结只能出「确定数字 + AI 暂不可用」版（`--no-ai` 的行为）；真实叙述由 CI 生成。
- `check.mjs` 变红先看 `verify.mjs` 的 summary 窗口那项：它比的是「**最近一次该写出的**总结窗口」（`cstDayMinus(30)..cstDayMinus(1)`；在今天那次总结的写入时点之前 —— cron `22:17` UTC = `06:17` +08，另留 1h 余量 —— 也接受前一天那次的窗口），所以**本地 `docs/` 落后一天、或当天总结还没到点都不算回归**；只有窗口停在两天前（总结连续没写出）才 FAIL。仍先 `git pull --rebase --autostash` 排除本地落后。

## AI 生成：provider 链、参数与失败可见性

**唯一事实来源是 `config/providers.json`**（提交进仓；JSON 而非 JS：CLI 改写安全、diff 干净）。`scripts/daily/lib/providers.mjs` 解析它，AI 执行细节在 `scripts/daily/lib/ai/`（`structured.mjs` 的 `generateStructured` + `transport.mjs` 的 `attemptProvider`；`ai.mjs` 只是 re-export 的桶），页面 / 诊断 / 测试都不再各抄一份链。

- `endpoints`：每个端点一组 `baseUrl` / `keyEnv`，可选 `keyEnvAliases`（本地便利，如 OpenChamber 项目变量叫 `Nvidia`）/ `headers` / `modelsUrl` / `shape`（`chat`|`responses`）。`headers` 里的 `${session}` 在**一次调用**里展开成同一个 UUID（一次运行 = 一个会话，Go 的路由与提示缓存有依据）。
- `models`：`slug`（**稳定身份** —— `attempts[].provider`、页面徽章、历史数据都用它）→ `endpoint` + `apiModel`（真实 API id）+ 可选 `enabled` / `note` / `params`。
- `params` 只有三个字段：`reasoningEffort`（chat 的 `reasoning_effort`，默认 `"none"`）、`extraBody`（合并进 chat 请求体）、`responseFormat`（`false` = 从不发 `json_object`）。**刻意没有** per-model `maxTokens` / `maxTokensCap` / `temperature` / `timeoutMs`：P0 实测三条 NIM 腿对 `max_tokens=49152` 全部 200，慢腿由 lane 预算统一兜住 —— 少开口子 = 少一处能配错的地方。
- `lanes`：`daily` / `summary` 各自 `order`（slug 数组）+ 可选 `budgetMs`。日报 `480000`（8 分钟），总结线不设预算。
- 链现状（2026-10-23）：`daily` = `nvidia-minimax-flash`（`reasoningEffort:"low"`）→ `nvidia-nemotron-ultra` → `opencode-go-deepseek` → `sensenova`；`summary` = `opencode-go-deepseek` → `sensenova`（30 天总结要长输出 + 强校验，只有 deepseek 稳定过；免费额度的限流会拖垮唯一稳定的腿）。
- 商汤腿必须带 `extraBody:{thinking:{type:"disabled"}}` 关思考 —— 不关则 reasoning 吃光预算、content 恒为空。`SENSENOVA_MODEL` 覆盖已删除：配置就是唯一入口，留着两处会漂。
- 配置缺失 / JSON 损坏 / schema 不合法 → `providers.mjs` warn 并回落内置 `FALLBACK_CHAIN`（deepseek → sensenova），CI 不因一个坏 JSON 全挂；`node scripts/providers.mjs check`（`check.mjs` 会跑）让坏配置在提交前就红。
- `MAX_TOKENS = 49152`（截断时翻倍到上限 65536）；`CHAT_TIMEOUT_MS = 180000`。lane 预算的收敛方式：每次发请求前剩余 ≤1s 就放弃，否则 `timeout = min(180s, 剩余)`；预算在腿之间耗尽 → 对**剩余每条腿各补一条合成 attempt**（`未尝试（超出 lane 预算 8 分钟）`）并照常走失败可见性链路，**绝不静默截断**。abort / 网络异常不重试，直接换下一条。
- **全失败的可见性**：编排器写 `data/ai-failure.json`（**gitignore 的 run 状态，不发布、不提交**）+ 把 `aiFailure` 写进 `docs/data/<date>.json` / `docs/summary.json`；`node scripts/notify-ai-failure.mjs` 开 / 追加**常驻** issue（label `ai-failure`）、把 issue 号回写进数据文件并重渲染页面。两个 workflow 都保持 0 退出（生成物照常提交），可见性靠 issue + `::warning::` + `$GITHUB_STEP_SUMMARY` —— 为此这两个 workflow 需要 `issues: write`。
- **动 notifier 之前先读它的头注释**，两条都是实测踩过的坑，别"简化"掉：① 记录里的 `state:"ok"|"failed"` 才是恢复信号 —— **「没有记录」不等于已恢复**（CI 每次全新 checkout，文件在运行开始时必然不存在，一次跳过 AI 的运行会误关仍然有效的 issue）；② issue 列表（search 与 REST 也一样）在新建后有几秒可见延迟 —— 所以它走 REST `/issues`、只在"准备创建"前多确认几次，并在看到多条 open 时保留编号最小的一条、其余追加说明后关闭（自愈）。
- **AI 全失败后的自动诊断（触发点）**：只有**本次新建**了常驻 issue（＝ ok→failed 的首次转换）才诊断 —— notifier 在那条分支往 `$GITHUB_OUTPUT` 写 `should_diagnose` / `issue_number`，两个生成 workflow 于是在**「提交并推送」之后**跑三件套：安装 opencode CLI → `scripts/diagnose-providers.mjs`（纯脚本证据：失败记录 + 各 provider `/models` 现状 + 机械对账，**不依赖 LLM**）→ `scripts/diagnose-narrate.mjs`（`opencode run` 读证据与配置 / `attemptProvider` 追加结论，LLM 起不来就只留证据）→ `gh issue comment`（回帖是 workflow 的动作；agent 那步不注入任何 GitHub token，并先摘掉 checkout 的 git 凭据）。追加评论的路径不诊断 → 天然去重；同一失败事件另按产物首行的 `<!-- ai-diagnosis … -->` 标记再查一次重。
- **`DIAGNOSE=1`（workflow_dispatch 勾 `diagnose`）是逃生口**：强制写 `should_diagnose`，让「追加评论」的路径也再诊断一次（手动补查 / 本地演练用）。诊断模型走仓库变量 `DIAG_MODEL`（默认 `opencode-go/deepseek-v4.1-flash`；Go 整体挂掉时换 `sensenova/glm-5.2`）。**凭据不依赖 auth.json**：`OPENCODE_CONFIG_CONTENT` 用 `{env:OPENCODE_API_KEY}` / `{env:SENSENOVA_API_KEY}` 注入仓库已有的两个 secret（实测 auth.json 为空也能调通），`OPENCODE_AUTH_CONTENT` 配了也只当额外来源。
- **`/oc` 手动入口（`.github/workflows/opencode.yml`）**：门是 `comment.user.login == 'sogeisetsu'`（比 `author_association` 严）且评论含 `/oc` —— **别人评论的表现是 job `skipped`，不是失败、不产生 run 计费**。它先跑同一个证据脚本，再把 `diagnose-providers.mjs --prompt` 的共用提示词 + 评论正文交给 `anomalyco/opencode/github@latest`。
- 诊断产物 `data/ai-diagnosis.md` 与 `data/ai-failure.json` 同类：**gitignore 的 run 状态**，不发布、不提交；回帖正文里不出现 key / token（证据层异常文本一律过 `sanitizeReason`）。
- NIM 的思考正文在 `message.reasoning_content`（不是 `reasoning`）；空输出诊断两种都读（只影响日志可读性，不影响判定）。

### 为什么这几条腿在链里（P0 实测，2026-10-23）

只测了 `docs/data/2026-10-22.json` 一份 fixture、1–3 次采样，prompt 与生产完全相同（`buildPrompts` + `validateNarrative`）；**事实 / 中英对称 / 格式**三项是人工比稿结论，脚本能自动挡住的只有「3/3 结构合法 + 单次 ≤90s」。

| 腿 | `reasoning_effort` | 3 次耗时 | 事实 | 中英对称 | 格式 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| `minimaxai/minimax-m3.1-flash` | `low` | 8.9 / 9.8 / 9.8s | 3/3 | 3/3 | 合规 | **入链 · 链首** |
| 同上 | `none` | 10.9 / 13.8 / 15.1s | 3/3 | 2/3（两次 en 漏 `#5293`） | 合规 | 次优（所以配 `low`） |
| `nvidia/nemotron-3-ultra-550b-a55b` | `none` | 27.5 / 32.5 / 27.7s | 3/3 | 3/3 | 合规 | **入链 · 第二** |
| 同上 | `low` | 37.6 / 105.7s | 2/2 合法 | — | — | 别改（逼近 180s 超时） |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | `none` | 6.6 / 16.2 / 18.9s | **2/3**（把 `#5293` 的关闭写成本人） | 3/3 | **3/3 不合规**（无加粗、两次无反引号） | **淘汰** |
| 同上 | `low` | 180s × 3 全部 aborted | — | — | — | 不可用 |

参数面：三条腿对 `reasoning_effort` none/low、`response_format:json_object`、`max_tokens` 8192–49152 全部 200，没有一项需要退让；`usage.completion_tokens_details.reasoning_tokens` 在 `none` 下为 0（真关掉）。`lightning` 是三条里最快的，但**唯一能用的设置下事实会错**、开思考就挂满 180s —— 要复议就带上这两条判据重测。

局限（别当成保证）：CI 在 ubuntu-latest、本地探测在本机，NIM 的境内外可达性与延迟可能不同 —— 合并后第一次真实运行才是终局证据；更重的日子 prompt 更大（`SECTION_CAP=30` 封顶，不会爆炸）；minimax 连续快调会 429（2/7，真实路径未复现），线上开始频繁 429 先看是不是同一天跑了两次 AI（定稿 + 滚动）；免费层随时可能下架（`longcat-2.5-preview-free` / `minimax-m3.1-flash-free` 已在 2026-10-23 走过这条路），所以删一条腿的成本必须仍然只是「改 JSON 里一行」。

## 加一条腿 / 改链路（一条命令）

`node scripts/providers.mjs add <slug> --endpoint=<ep> --api-model=<id> [--param k=v]... [--lane=daily] [--yes]`

1. 打印配置 unified diff（不带 `--yes` 只干跑：**不联网、不落盘**）。
2. `--yes`：真实探测 3/3（默认 `--prompt=real`，与生产同一条代码路径；门槛 = 每次 ≤90s + 输出非空 + 过校验）—— **不通过就不写配置、不推密钥**。
3. 落盘；secret 只做干跑预览（name / 长度 / sha256 前 8 位），`--push-secret` 才真的 `gh secret set NAME`（值走 stdin，绝不 `--body`，输出永不含明文）。
4. 打印该抄的那行 `KEY: ${{ secrets.KEY }}`；`node scripts/providers.mjs check` 会指出还缺哪些 workflow / 哪一步。最后跑 `node scripts/daily/check.mjs`。

- 接线是**硬断言**（`providers check`，纯文本扫描、先剔 `#` 注释行）：跑 `scripts/daily/index.mjs` 的 workflow 必须有 daily lane 每个 endpoint 的 `secrets.<KEY_ENV>`；跑 `scripts/summary/index.mjs` 的必须有 summary lane 的；跑 `scripts/diagnose-providers.mjs` 的必须有**每个 enabled endpoint** 的（诊断探所有 `/models`，缺 key 会误报「未配置」）。
- 常用命令：`list --lane=daily`（链顺序 + key 状态）、`status`（本机 env / repo secret / 配置三方对照）、`probe --lane=daily --prompt=real`、`probe <slug> --compare=<slug>`（同一份数据并排看两腿输出）、`set <slug> params.reasoningEffort=low`、`enable|disable <slug>`、`lane add|move|remove`。
- 所有写操作：先打印 unified diff，`--yes` 才落盘，`--dry-run` 显式只读（CI 与本地都能随便跑的只有 `status` / `check` / `list` / `show` / `probe`）。
- **回滚只改往后**：`disable <slug>` 即可（测试断言的是 lane 顺序、不依赖某条腿 enabled，所以 `check.mjs` 仍绿）；**不重写历史日期**、不碰 `--force` —— 那是口径变更的逃生口。
- `config/**` 在日报 workflow 的 push 白名单里：**合并即触发一次真实运行**，这既是验收也是第一次真实证据。

## 发布流程

1. 生成 / 重渲染（见上）。
2. `node scripts/daily/check.mjs` 全绿（= 递归语法检查 + test-boundaries + test-schedule + test-ai + test-render + test-summary + test-activity-window + test-providers + test-attribution + test-dataset + providers check + verify）。
3. `git add scripts config docs assets README.md data/backfill data/attribution.json .github AGENTS.md` → 提交（**中文提交信息用 `git commit -F <msgfile>`，不要用 `-m` 传中文**）→ `git pull --rebase --autostash origin main` → `git push`。（代码修改走分支：新建分支 → 合并回 `main` → push；`config/**` 在日报 workflow 的 push 白名单里，所以合并会自动跑一次真实日报）
4. push 后**手动触发 Action，不要等 cron**：
   - 日报：`gh workflow run update-daily-report.yml --ref main`
   - 总结：`gh workflow run update-summary.yml --ref main [ -f force=true ]`
   - 各自 `gh run watch <run-id> --exit-status` 等完成；CI 会把生成物提交推回 main，本地记得 `git pull --rebase --autostash`。
5. `gh api repos/sogeisetsu/sogeisetsu/pages/builds/latest` 确认 `status: built`。
6. 用 `openchamber_web` 打开线上页（带 `?v=<短哈希>` 击穿缓存）截图确认。

## 与 Action 产物冲突（重要）

两个 workflow 每 2 小时、总结 workflow 每天一次会自动提交 `docs/`（活动卡片另提交 `README.md`），手动 `git pull --rebase` 常在生成物上报 CONFLICT。
**生成物可丢弃，一律以本地最新代码重新生成为准，绝不手工合并 HTML/JSON：**

```
git rebase --abort
git fetch origin
git reset --soft origin/main   # HEAD 移到远端，脚本改动仍留在 index / 工作区
git checkout HEAD -- docs      # 丢掉本地生成物，改用远端那份当基线
node scripts/daily/index.mjs --rerender    # 按新基线重新生成
node scripts/summary/index.mjs --rerender
git add scripts docs
git commit -F <msgfile>
git push
```

## 口径与约束

- 公开口径：只用公开活动；**不泄露私有仓库名 / 数量**。
- 提交按 **commit date** 统计；本人与机器人（`[bot]`）**分开且相加**（`count` 与 `automated` 互不相交）；**不含合并提交**（parents>1）。AI 正文（日报叙述 / 总结 overview 与 byRepo）里自动提交也必须写成相加（「另有 M 次」/「plus」），出现「其中/包含…自动提交」会被校验器拒收重试；`AUTOMATED_OVERLAP_RE`（`scripts/lib/rules.mjs`）是唯一口径，`verify.mjs` / 日报叙述 / 总结校验共用同一份。
- 提交归属＝`login` 或 `commit.author.name` 命中 `sogeisetsu` 或别名（`COMMIT_AUTHOR_ALIASES`，见 `scripts/daily/lib/github.mjs`，如 `suyue`），大小写不敏感；GitHub 按提交邮箱关联账号，未关联的署名（如本地邮箱 `suyue@localhost`）须列别名才计入本人。
- **`data/attribution.json` 是归属修正数据（两段独立，代码只读它、不内置任何规则）**：`commits` 只按**完整 40 位 sha** 认，不按名字 / 邮箱（作者字符串提交者自己就能写，PR 也能伪造；sha 全局唯一）；`identities` 按 **name + email 精确配对**认，`ownReposOnly`（仓库属主必须是本人）与 `requireUnlinkedAuthor`（作者未关联 GitHub 账号）**默认都是 true**，要放宽必须显式写 false —— 用于"整批同身份的本地提交"（如 `jinansu <suyuesheng@duck.com>`），因为几百条 sha 无法逐条维护。两段都只把「其他人类提交（原本静默丢弃）」改判为本人，`messages` 项带 `by: "attribution-sha"` / `"attribution-identity"` 便于核对；**合并提交 / 机器人 / 窗口过滤 / sha 去重一律不受影响**。不要用它做"占位身份"的长期归一 —— 环境层面的正解是把仓库/全局 `user.name`、`user.email` 配好。
- **事件动作时间一律取 payload 里的业务时间**（`issue/PR.created_at` / `closed_at` / `merged_at`、`comment.created_at`、`review.submitted_at`），不是事件的 `created_at`：GitHub 会重放旧 `IssuesEvent`（实证 #5489 于 10-23 10:57Z 创建、12:28Z 关闭，事件流却在 17:09Z 又投一条 `opened`），用事件时间会把昨天已关闭的 issue 算进今天、还标成「开启」。同一 (仓库, 编号, 动作) 只保留最早一条；评论与评审按各自 id 去重。
- **提交扫描只认公开仓库**：`fetchOwnRepos` 直接用响应里的 `private` / `visibility` 过滤（零额外请求），`selectScanRepos` 用同一谓词再挡一次，`buildCommits` 另对每个待扫仓库走 `isPublicRepo`（与 replies / stateChanges 共用缓存，fail-closed）。原因：`/users/:u/repos` 对带 `repo` 权限的 token 会连私有仓一起返回，本地用 `gh auth token` 跑时会把私有仓名 + 提交标题 + 次数写进 `docs/`；CI 的 `secrets.GITHUB_TOKEN` 只看得到本仓，所以线上一直没暴露。
- `totals` 只由展示数据求和；页面数字与 AI 摘要数字都以此为准。
- Discussions：我发起（`started`）/ 我评论（`commented`）+ 他人回复并入 replies（`kind=discussion_comment`）；仅公开仓库；不进 `totals` / `empty`（与 releases / stars 一致）。
- Issue/PR 行的评论数（REST 取，含机器人与本人，仅展示用，不进 `totals`；仓库非公开或读取失败则不显示）：**Issue＝会话评论**（`/issues/:n` 的 `comments`），**PR＝会话评论＋行内评审评论**（`/pulls/:n` 的 `comments + review_comments`，与 Replies 段 `issue_comment + review_comment` 口径对齐）；**窗口已关闭的定稿日冻结已存 `docs/data/<date>.json` 里的快照**，重采集不取实时值，避免计数漂移改写定稿页面（「今天」滚动报仍取实时值；`--force` 会一并重取实时值，是口径变更后的逃生口）。重跑已关闭日期时 `replies` / `stateChanges` 可能比原产物多（历史漏采被补录，属修复而非漂移），被冻结的只有评论数这一项。
- **30 天总结的窗口** = 最近 30 个「已定稿」的 +08 自然日（`cstDayMinus(30)..cstDayMinus(1)`，不含今天）；数据源 = `docs/data` ∪ `data/backfill`，同日两份都有时以 `docs/data` 为准。
- **总结页的数字条完全由代码求和**（Σ 各日 `totals` / `automatedCommits`），AI 只叙述、不计算；`verify.mjs` 逐项核对，偏了就 FAIL。
- **总结正文是章节式**：`overview` 3–6 段、约 4200 字符上限，允许行首 `### 小标题`（渲染成 `<h3 class="ai-h3">`），其余 markdown（列表 / 链接 / 表格 / 代码块 / 斜体）**拒收并触发重试** —— 放宽提示词前先想清楚会不会让模型反复被判违规。
- **窗口区间由代码拼**（AI 只给 headline）：**首页卡片**里区间单独成一行、渲染成 chip（`<p class="ai-range"><span class="mono">2026-09-18 – 2026-10-17</span></p>`，样式同 `.chip`）；**总结页 hero 标题不含区间**（eyebrow 已有「近 30 天」、hero-sub 已有 `2026-09-18 ~ 2026-10-17 · UTC+8`，标题里再来一遍是重复），区间只在 hero-sub 里加粗（`.hero-win`）。两处文本都必须保持**单元素内连续** —— `verify.mjs` 逐字查：卡片查 en-dash 形式，总结页查 `~` 形式且 hero `h1` 不得含区间。
- **标题字体**：中英文标题同一字族（`--headline` == `--headline-zh`，系统衬线栈），**不再使用 Chomsky 黑体**；中英文可按语言给不同字重 / 字号 / 行高（CJK 需要更大的字号与行高）。`verify.mjs` 会挡住"把 Chomsky 加回标题栈"的回退。
- **AI 块旁注 provider / model**：日报 / 总结页 / 首页卡片都在 AI 徽章右侧显示 `provider / model`（历史数据只有 `aiProvider` 时退化成只有 provider）。`.ai-badge` 不参与收缩（`flex:none`），窄屏由旁注换行吸收。
- **总结的 AI 输出受严格校验**：`highlights` / `byRepo` 里出现的仓库与条目编号必须真实存在于输入数据，链接一律由校验器从输入注入（模型不许给 URL）；**AI 不许提任何条目的评论数**（`comments` 是采集那一刻的实时值）。
- **`data/backfill/` 是一次性回填**：事件流（`/users/:u/events/public`）只保留最近 300 条 / 90 天，2026-09-16 ~ 10-01 的动作级事件已过期，只能用 Search API（`author:` / `commenter:` / `reviewed-by:` + 日期区间）+ 逐条 REST 校时重建，属**近似**：`stars` 无法重建（留空）、`releases` 只覆盖自有仓库、issue/评审可能偏低、评论数（`comments`）不回填；每个回填文件带 `source: "search-backfill"` 与 `backfillLimits`，页面如实标注。窗口每天前移，这批日期会逐日退出窗口（约 15 天后窗口完全由 `docs/data` 覆盖）。
- **30 天活动卡片的窗口** = 最近 30 个 +08 自然日、**含今天**（`cstDayMinus(29)..cstDayMinus(0)`），与日报「今天滚动」同口径；`daily` 柱状也按 +08 自然日分桶（不能用 UTC 日期）。卡片线的 `totals` 与日报同一条恒等式：只由**过滤后的公开明细**求和；`contributionsCollection` 的四项标量在 user-scoped token 下含私有贡献，故逐仓 / 逐条按 `isPrivate` / `visibility` 过滤（拿不准一律按不公开），标量只用于对账告警、不进产物。`README.md` 里 `<!--START:activity-->`…`<!--END:activity-->` 两个 marker 必须各出现且仅一次，否则脚本直接 fail。
- 站点 head 与字体受 `scripts/daily/verify.mjs` 硬约束（改 head / CSS / 渲染层后**必跑 `check.mjs`**）：必须有 Chomsky `@font-face`（资产保留，但**标题栈不得再引用 Chomsky**）、**`--headline` 与 `--headline-zh` 必须同字族**（粗细 / 字号允许分语言）、zh h1 规则用 `var(--headline-zh)`、favicon 路径与 `docs/assets/fonts/chomsky.woff2` 实体（wOF2 魔数）都在；**`<head>` 里禁用字体名 `Newsreader` / `霞鹜文楷` / `lxgw`**（历史遗留，正文提到不算）。
- 不擅自新增依赖；改 CI / 改权限前先确认。代码修改必须走分支：新建分支 → 提交 → 合并回 `main` → push；不要直接在 `main` 上改。

## 已知问题（别当成自己弄坏的）

- 活动卡片线的事件翻页**只认 `Link` 头**（`decideEventPage()`），别再用「满页即有下一页」推断 —— 最后一页恰好满页时会去请求不存在的页并拿到 `HTTP 422 pagination is limited for this resource`，那是历史坑（`4719825` 已修）。第 2 页起的 422 / 4xx / 5xx 重试耗尽属「分页到底」：告警 + 停 + 保留已取部分并置 `stoppedByLimit`，`truncated` 会如实标注。**只有第 1 页取不到才 fail**（没有事件样本会让时间轴全零、`reposOwn` 空，而 `totals` 来自 GraphQL 非零）。所以看到 `stoppedByLimit` 告警是预期行为，不是新 bug。
- `update-activity.yml` 没有 push 触发 —— 看到它被 `workflow_dispatch` 触发，是 Cloudflare watchdog 在补 GitHub 丢掉的 schedule，不是有人手动跑。
- `.openchamber/`、`.opencode/`、`.slim/`、`data/ai-failure.json`、`scripts/preview-*.svg`、`assets/_preview.html` 都在 `.gitignore` 里 —— 截图 / 预览产物不用管，也别提交。

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`
（`scripts/`、`scripts/daily/`、`scripts/daily/lib/`、`scripts/summary/`、`ops/`、`ops/cloudflare-cron/`）。

映射只覆盖 `scripts/**` 与 `ops/**` 的代码与配置；`docs/` / `data/` / `assets/` 是生成物，不在映射范围内。
**开始改动前先核对映射是否过期**：基线提交与判断命令写在 `codemap.md` 顶部
（`git log --oneline 5c9eeab..HEAD -- scripts ops`，有输出即需复核）。不要用"提交号是否等于 HEAD"判断
—— 本仓每 2 小时有 bot 自动提交生成物，那样会恒报过期。
注意：`.slim/` 只是 codemap 工具的本地缓存（已在 `.gitignore` 忽略），不要提交。
