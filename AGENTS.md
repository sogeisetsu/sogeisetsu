# AGENTS.md — sogeisetsu/sogeisetsu

个人主页仓库。核心产物：**每日 GitHub 活动日报**（Pages: https://sogeisetsu.github.io/sogeisetsu/，英文默认 / 中文可切换）、**近 30 天 AI 总结**（首页卡片 + `docs/summary.html`），以及**近 30 天活动卡片**（回写 README）。

## 布局
- `scripts/daily/index.mjs` —— 日报编排：取数 → dataHash 去重 → AI → 写 `docs/`
- `scripts/daily/render.mjs` —— HTML/MD 渲染（内联 CSS，双语切换，段落切分，标题字体）；页面外壳 `pageStyle` / `htmlDoc` 等已导出，供总结页复用
- `scripts/daily/lib/github.mjs` —— GitHub 采集（公开口径）；`collectHistoricalData` 是 Search API 历史回填通道（一次性，见下）
- `scripts/daily/lib/ai.mjs` —— SenseNova 适配（JSON 模式 + 重试）；`generateStructured` 是通用结构化生成入口，日报与总结共用
- `scripts/daily/lib/days.mjs` —— 已定稿日目录的共享助手（+08 日期推算、JSON 读写、内容哈希、docs/data 扫描）
- `scripts/daily/verify.mjs` —— 本地不变式自检（含 30 天总结的数字一致性）
- `scripts/summary/collect.mjs` —— 30 天窗口聚合：数字条由代码逐日求和 + 压缩 AI 输入
- `scripts/summary/prompt.mjs` / `validate-summary.mjs` —— 总结提示词与严格校验（条目必须真实存在；URL 由校验器从输入注入）
- `scripts/summary/render.mjs` —— 总结页与首页卡片渲染
- `scripts/summary/index.mjs` —— 总结编排：聚合 → 窗口哈希去重 → AI → 写 `docs/`
- `scripts/summary/backfill.mjs` —— 一次性 Search API 回填 CLI（写 `data/backfill/`，不挂 workflow）
- `scripts/summary/test-summary.mjs` —— 总结侧确定性回归（假数据 + 假 provider）
- `docs/` —— **生成物**（Pages Source = `main` / `docs`）：`index.html`、`data/<date>.json`、`report/<date>.{html,md}`、`summary.json`、`summary.html`
- `data/backfill/<date>.json` —— 回填日数据（**不在 `docs/` 下，因此不站点可见**、不出现在归档列表）
- `.github/workflows/update-daily-report.yml` —— cron `17 */2 * * *`：定稿「昨天」+ 滚动「今天」
- `.github/workflows/update-activity.yml` —— cron `30 */2 * * *`：30 天活动卡片（无 AI）
- `.github/workflows/update-summary.yml` —— cron `17 22 * * *`（UTC，= 北京次日 06:17）：30 天 AI 总结
- `.github/workflows/check.yml` —— push / PR 上只跑 `scripts/daily/check.mjs`（零 secret）

## 本地运行
环境变量：`GITHUB_TOKEN`（`gh auth token`）、`SENSENOVA_API_KEY`（同名仓库 secret；**不得提交明文 / 不得轮换用户 key**）。
```
node scripts/daily/index.mjs                 # 昨天（定稿）+ 今天（滚动）
node scripts/daily/index.mjs --date=YYYY-MM-DD [--force]
node scripts/daily/index.mjs --rerender       # 只按已存 JSON 重渲染，不抓数据、不调 AI（改渲染代码后用）
node scripts/daily/index.mjs --no-ai [--dry-run]
node scripts/daily/verify.mjs                 # 不变式自检
node scripts/summary/index.mjs                # 近 30 天 AI 总结：聚合 → 去重 → AI → 写 docs/
node scripts/summary/index.mjs --rerender      # 只按已存 docs/summary.json 重渲染 summary.html + index.html
node scripts/summary/index.mjs --no-ai [--dry-run]
node scripts/summary/backfill.mjs --from=YYYY-MM-DD --to=YYYY-MM-DD [--force] [--dry-run]  # 一次性回填（需要 GITHUB_TOKEN）
node scripts/daily/check.mjs                   # 一次跑完语法检查 + 全部确定性测试 + verify
```
- `--force`：绕过 dataHash 跳过，强制重取 + 重调 AI（改了提示词 / 数据口径后用）。
- 无变化时脚本**自行跳过 AI 与写入**——这是设计，不是 bug。
- 没有 `SENSENOVA_API_KEY` 时总结只能出「确定数字 + AI 暂不可用」版（`--no-ai` 的行为）；真实 AI 叙述在 CI 里生成。

## 发布流程
1. 生成 / 重渲染（见上）。
2. `node scripts/daily/check.mjs` 全绿（= 语法检查 + test-ai + test-render + test-summary + verify）。
3. `git add scripts/daily scripts/summary docs data/backfill .github AGENTS.md` → 提交（中文信息用 `git commit -F <msgfile>`，不要用 `-m` 传中文）→ `git pull --rebase --autostash origin main` → `git push`。（代码修改按口径段的分支规则走分支）
4. push 后**手动触发 Action，不要等 cron**：
   - 日报：`gh workflow run update-daily-report.yml --ref main`
   - 30 天总结：`gh workflow run update-summary.yml --ref main [ -f force=true ]`
   - 各自的 `gh run watch <run-id> --exit-status` 等完成；CI 会把生成物提交推回 main，本地记得 `git pull --rebase --autostash`。
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
- 代码修改必须走分支：新建分支 → 提交 → 合并回 `main` → push；不要直接在 `main` 上修改。
- 不擅自新增依赖；改 CI / 改权限前先确认。
