# AGENTS.md — sogeisetsu/sogeisetsu

个人主页仓库。核心产物：**每日 GitHub 活动日报**（Pages: https://sogeisetsu.github.io/sogeisetsu/，英文默认 / 中文可切换）、**近 30 天 AI 总结**（首页卡片 + `docs/summary.html`），以及**近 30 天活动卡片**（回写 README）。

零依赖：没有 `package.json`、没有任何 npm 脚本 —— 全部是 `node` 直跑的 ESM，CI 固定 Node 20（用内置 `fetch`）。别去找 `npm test` / `npm ci`，没有。

## 布局
- `repo-overview.excalidraw` —— 一页速览草图：这个仓库是干什么的 + 四条 Action 的运行规律矩阵（多久跑一次 / 更新哪些内容 / 依据哪些内容）（用 OpenChamber 的 Excalidraw 扩展打开，Files 视图里点开就是画布）
- `codemap.md` + 各目录 `codemap.md` —— 架构映射（根 Atlas + 6 个分目录），见文末「Repository Map」
- `scripts/daily/index.mjs` —— 日报编排：取数 → dataHash 去重 → AI → 写 `docs/`
- `scripts/daily/render.mjs` —— HTML/MD 渲染（内联 CSS，双语切换，段落切分，标题字体）；页面外壳 `pageStyle` / `htmlDoc` 等已导出，供总结页复用
- `scripts/daily/lib/github.mjs` —— GitHub 采集（公开口径）；`collectHistoricalData` 是 Search API 历史回填通道（一次性，见下）
- `scripts/daily/lib/ai.mjs` —— SenseNova 适配（JSON 模式 + 重试）；`generateStructured` 是通用结构化生成入口，日报与总结共用
- `scripts/daily/lib/days.mjs` —— 已定稿日目录的共享助手（+08 日期推算、JSON 读写、内容哈希、docs/data 扫描）；+08 日期口径本体在 `scripts/cst.mjs`，这里原样转出
- `scripts/cst.mjs` —— 三条产物线共用的 +08 自然日口径（零 import）；`cstDateOf` 是唯一正确的"时间戳 → 日期"，别用 `toISOString().slice(0,10)`（那是 UTC 日）
- `scripts/daily/verify.mjs` —— 本地不变式自检（含 30 天总结的数字一致性）
- `scripts/summary/collect.mjs` —— 30 天窗口聚合：数字条由代码逐日求和 + 压缩 AI 输入
- `scripts/summary/prompt.mjs` / `validate-summary.mjs` —— 总结提示词与严格校验（条目必须真实存在；URL 由校验器从输入注入）
- `scripts/summary/render.mjs` —— 总结页与首页卡片渲染
- `scripts/summary/index.mjs` —— 总结编排：聚合 → 窗口哈希去重 → AI → 写 `docs/`
- `scripts/summary/backfill.mjs` —— 一次性 Search API 回填 CLI（写 `data/backfill/`，不挂 workflow）
- `scripts/summary/test-summary.mjs` —— 总结侧确定性回归（假数据 + 假 provider）
- `scripts/generate-activity.mjs` / `scripts/render-svg.mjs` —— 近 30 天活动卡片线（GraphQL `contributionsCollection` + `events/public`）→ 写 `assets/30-day-activity.svg` 并替换 `README.md` 里 `<!--START:activity-->`…`<!--END:activity-->` 之间的内容；两个 marker 必须各出现且仅一次，否则脚本直接 fail；窗口与分桶同为 **+08 自然日**（含今天），逐仓 / 逐条按 `isPrivate` / `visibility` **只取公开**，`totals` 只由过滤后的公开明细求和
- `scripts/preview.mjs` + `scripts/fixtures/*.json` —— 用 fixture 出本地预览 SVG（`scripts/preview-*.svg`、`assets/_preview.html` 已 gitignore）
- `docs/` —— **生成物**（Pages Source = `main` / `docs`）：`index.html`、`data/<date>.json`、`report/<date>.{html,md}`、`summary.json`、`summary.html`
- `data/backfill/<date>.json` —— 回填日数据（**不在 `docs/` 下，因此不站点可见**、不出现在归档列表）
- `.github/workflows/update-daily-report.yml` —— cron `17 */2 * * *`：定稿「昨天」+ 滚动「今天」
- `.github/workflows/update-activity.yml` —— cron `30 */2 * * *`：30 天活动卡片（无 AI）
- `.github/workflows/update-summary.yml` —— cron `17 22 * * *`（UTC，= 北京次日 06:17）：30 天 AI 总结
- `.github/workflows/check.yml` —— push / PR 上只跑 `scripts/daily/check.mjs`（零 secret）
- `ops/cloudflare-cron/` —— 定时任务 watchdog（Cloudflare Worker，补 GitHub 丢掉的 schedule 触发）；**推 `ops/cloudflare-cron/**` 到 main 会被 Cloudflare Workers Builds 自动构建 + 部署**，与日报生成逻辑无关，细节见 `ops/README.md`

## 本地运行
环境变量：`GITHUB_TOKEN`（`gh auth token`；**可省**——无 token 只跑公开段，stars / discussions 等 GraphQL 段静默降级为空）、`SENSENOVA_API_KEY`（同名仓库 secret；**不得提交明文 / 不得轮换用户 key**）、`OPENCODE_API_KEY`（可选兜底 provider）。`GITHUB_REPOSITORY_OWNER` 可覆盖默认的 `sogeisetsu`（本地/异地复跑用）。
```
node scripts/daily/index.mjs                 # 昨天（定稿）+ 今天（滚动）
node scripts/daily/index.mjs --date=YYYY-MM-DD [--force]
node scripts/daily/index.mjs --rerender       # 只按已存 JSON 重渲染，不抓数据、不调 AI（改渲染代码后用）
node scripts/daily/index.mjs --no-ai [--dry-run]
node scripts/daily/verify.mjs                 # 不变式自检
node scripts/summary/index.mjs                # 近 30 天 AI 总结：聚合 → 去重 → AI → 写 docs/
node scripts/summary/index.mjs --rerender      # 只按已存 docs/summary.json 重渲染 summary.html + index.html
node scripts/summary/index.mjs --no-ai [--dry-run]
node scripts/summary/backfill.mjs --from=YYYY-MM-DD --to=YYYY-MM-DD [--force] [--dry-run]  # 一次性回填（需要 GITHUB_TOKEN；已存在的日期默认跳过，只有 --force 才会重抓）
node scripts/daily/check.mjs                   # 一次跑完语法检查 + 全部确定性测试 + verify
```
- AI provider 顺序：sensenova → OpenCode Go 的 `longcat-2.5-preview-free`（限时免费、不限量）→ `deepseek-v4.1-flash`（计入 Go 套餐额度），后两条共用 `OPENCODE_API_KEY`；SenseNova 的模型名是运行时从 `GET /models` 动态挑的（`SENSENOVA_MODEL` 可钉死），改提示词后行为可能随模型变。
- `--force`：绕过 dataHash 跳过，强制重取 + 重调 AI（改了提示词 / 数据口径后用）。
- 无变化时脚本**自行跳过 AI 与写入**——这是设计，不是 bug。
- `check.mjs` 变红先看是不是 `verify.mjs` 的 summary 窗口那项：它拿 `docs/summary.json` 的窗口跟「今天」重算的窗口硬比（`cstDayMinus(30)~cstDayMinus(1)`），所以**本地 docs/ 落后远端、或当天总结还没成功跑**（AI 全失败时按设计不写文件）都会 FAIL 这一项 —— 先 `git pull --rebase --autostash` 再看，别当成自己的改动。
- 没有 `SENSENOVA_API_KEY` 时总结只能出「确定数字 + AI 暂不可用」版（`--no-ai` 的行为）；真实 AI 叙述在 CI 里生成。

## 发布流程
1. 生成 / 重渲染（见上）。
2. `node scripts/daily/check.mjs` 全绿（= 语法检查 + test-ai + test-render + test-summary + verify）。
3. `git add scripts docs assets README.md data/backfill .github AGENTS.md` → 提交（中文信息用 `git commit -F <msgfile>`，不要用 `-m` 传中文）→ `git pull --rebase --autostash origin main` → `git push`。（代码修改按口径段的分支规则走分支）
4. push 后**手动触发 Action，不要等 cron**：
   - 日报：`gh workflow run update-daily-report.yml --ref main`
   - 30 天总结：`gh workflow run update-summary.yml --ref main [ -f force=true ]`
   - 各自的 `gh run watch <run-id> --exit-status` 等完成；CI 会把生成物提交推回 main，本地记得 `git pull --rebase --autostash`。
   - 只有日报 workflow 挂了 push 触发（白名单 `scripts/daily/**` + 它自己），所以改日报脚本时推 main 本来就会带一次 run；**改 `scripts/summary/**` 后必须手动 dispatch**，它没有 push 触发。
5. `gh api repos/sogeisetsu/sogeisetsu/pages/builds/latest` 确认 `status: built`。
6. 用 openchamber_web 打开线上页（带 `?v=<短哈希>` 击穿缓存）截图确认。

## 与 Action 产物冲突（重要）
两个 workflow 每 2 小时、总结 workflow 每天一次会自动提交 `docs/`（活动卡片另提交 `README.md`），手动 `git pull --rebase` 常在生成物上报 CONFLICT。
**生成物可丢弃，一律以本地最新代码重新生成为准，绝不手工合并 HTML/JSON：**
```
git rebase --abort
git fetch origin
git reset --soft origin/main      # HEAD 移到远端，保留本地脚本与已生成 docs
node scripts/daily/index.mjs ...  # 必要时重新生成 / 重渲染
git add scripts/daily docs
git commit -F <msgfile>
git push
```

## 口径与约束
- 公开口径：只用公开活动；**不泄露私有仓库名 / 数量**。
- 提交按 **commit date** 统计；本人与机器人（`[bot]`）**分开且相加**（`count` 与 `automated` 互不相交）；**不含合并提交**（parents>1）。
- 提交归属＝`login` 或 `commit.author.name` 命中 `sogeisetsu` 或别名（`COMMIT_AUTHOR_ALIASES`，见 `scripts/daily/lib/github.mjs`，如 `suyue`），大小写不敏感；GitHub 按提交邮箱关联账号，未关联的署名（如本地邮箱 `suyue@localhost`）须列别名才计入本人。
- `totals` 只由展示数据求和；页面数字与 AI 摘要数字都以此为准。
- Discussions：我发起（`started`）/ 我评论（`commented`）+ 他人回复并入 replies（`kind=discussion_comment`）；仅公开仓库；不进 `totals` / `empty`（与 releases / stars 一致）。
- Issue/PR 行的评论数（REST 取，含机器人与本人，仅展示用，不进 `totals`；仓库非公开或读取失败则不显示）：**Issue＝会话评论**（`/issues/:n` 的 `comments`），**PR＝会话评论＋行内评审评论**（`/pulls/:n` 的 `comments + review_comments`，与 Replies 段 `issue_comment + review_comment` 口径对齐）；**窗口已关闭的定稿日冻结已存 `docs/data/<date>.json` 里的快照**，重采集不取实时值，避免计数漂移改写定稿页面（「今天」滚动报仍取实时值；`--force` 会一并重取实时值，是口径变更后的逃生口）。重跑已关闭日期时 `replies` / `stateChanges` 可能比原产物多（历史漏采被补录，属修复而非漂移），被冻结的只有评论数这一项。
- **30 天总结的窗口** = 最近 30 个「已定稿」的 +08 自然日（`cstDayMinus(30)..cstDayMinus(1)`，不含今天）；数据源 = `docs/data` ∪ `data/backfill`，同日两份都有时以 `docs/data` 为准。
- **总结页的数字条完全由代码求和**（Σ 各日 `totals` / `automatedCommits`），AI 只叙述、不计算；`verify.mjs` 逐项核对，偏了就 FAIL。
- **总结的 AI 输出受严格校验**：`highlights` / `byRepo` 里出现的仓库与条目编号必须真实存在于输入数据，链接一律由校验器从输入注入（模型不许给 URL）；**AI 不许提任何条目的评论数**（`comments` 是采集那一刻的实时值）。
- **`data/backfill/` 是一次性回填**：事件流（`/users/:u/events/public`）只保留最近 300 条 / 90 天，2026-09-16 ~ 10-01 的动作级事件已过期，只能用 Search API（`author:` / `commenter:` / `reviewed-by:` + 日期区间）+ 逐条 REST 校时重建，属**近似**：`stars` 无法重建（留空）、`releases` 只覆盖自有仓库、issue/评审可能偏低、评论数（`comments`）不回填；每个回填文件带 `source: "search-backfill"` 与 `backfillLimits`，页面如实标注。窗口每天前移，这批日期会逐日退出窗口（约 15 天后窗口完全由 `docs/data` 覆盖）。
- **30 天活动卡片的窗口** = 最近 30 个 +08 自然日、**含今天**（`cstDayMinus(29)..cstDayMinus(0)`），与日报「今天滚动」同口径；`daily` 柱状也按 +08 自然日分桶（不能用 UTC 日期，否则 +08 的 00:00–08:00 会归错天）。卡片线的 `totals` 与日报同一条恒等式：只由**过滤后的公开明细**求和；`contributionsCollection` 的四项标量在 user-scoped token 下含私有贡献，故逐仓 / 逐条按 `isPrivate` / `visibility` 过滤（拿不准一律按不公开），标量只用于对账告警、不进产物。
- 站点 head 与字体受 `scripts/daily/verify.mjs` 硬约束（改 head / CSS / 渲染层后必跑 `check.mjs`）：必须有 Chomsky `@font-face`、`--headline` 必须以 `"Chomsky"` 开头、favicon 路径与 `docs/assets/fonts/chomsky.woff2` 实体（wOF2 魔数）都在；**`<head>` 里禁用字体名 `Newsreader` / `霞鹜文楷` / `lxgw`**（历史遗留，正文提到不算）。
- 代码修改必须走分支：新建分支 → 提交 → 合并回 `main` → push；不要直接在 `main` 上修改。
- 不擅自新增依赖；改 CI / 改权限前先确认。

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

