# AGENTS.md — sogeisetsu/sogeisetsu

个人主页仓库。核心产物：**每日 GitHub 活动日报**（Pages: https://sogeisetsu.github.io/sogeisetsu/，英文默认 / 中文可切换），以及**近 30 天活动卡片**（回写 README）。

## 布局
- `scripts/daily/index.mjs` —— 编排：取数 → dataHash 去重 → AI → 写 `docs/`
- `scripts/daily/render.mjs` —— HTML/MD 渲染（内联 CSS，双语切换，段落切分，标题字体）
- `scripts/daily/lib/github.mjs` —— GitHub 采集（公开口径）
- `scripts/daily/lib/ai.mjs` —— SenseNova 适配（JSON 模式 + 重试）
- `scripts/daily/verify.mjs` —— 本地不变式自检
- `docs/` —— **生成物**（Pages Source = `main` / `docs`）：`index.html`、`data/<date>.json`、`report/<date>.{html,md}`
- `.github/workflows/update-daily-report.yml` —— cron `0 */2 * * *`：定稿「昨天」+ 滚动「今天」
- `.github/workflows/update-activity.yml` —— cron `30 */2 * * *`：30 天活动卡片（无 AI）

## 本地运行
环境变量：`GITHUB_TOKEN`（`gh auth token`）、`SENSENOVA_API_KEY`（同名仓库 secret；**不得提交明文 / 不得轮换用户 key**）。
```
node scripts/daily/index.mjs                 # 昨天（定稿）+ 今天（滚动）
node scripts/daily/index.mjs --date=YYYY-MM-DD [--force]
node scripts/daily/index.mjs --rerender       # 只按已存 JSON 重渲染，不抓数据、不调 AI（改渲染代码后用）
node scripts/daily/index.mjs --no-ai [--dry-run]
node scripts/daily/verify.mjs                 # 不变式自检
```
- `--force`：绕过 dataHash 跳过，强制重取 + 重调 AI（改了提示词 / 数据口径后用）。
- 无变化时脚本**自行跳过 AI 与写入**——这是设计，不是 bug。

## 发布流程
1. 生成 / 重渲染（见上）。
2. `node scripts/daily/verify.mjs` 全绿。
3. `git add scripts/daily docs` → 提交（中文信息用 `git commit -F <msgfile>`，不要用 `-m` 传中文）→ `git pull --rebase --autostash origin main` → `git push`。
4. `gh api repos/sogeisetsu/sogeisetsu/pages/builds/latest` 确认 `status: built`。
5. 用 openchamber_web 打开线上页（带 `?v=<短哈希>` 击穿缓存）截图确认。

## 与 Action 产物冲突（重要）
两个 workflow 每 2 小时会自动提交 `docs/` 与 `README.md`，手动 `git pull --rebase` 常在生成物上报 CONFLICT。
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
- `totals` 只由展示数据求和；页面数字与 AI 摘要数字都以此为准。
- 不擅自新增依赖；改 CI / 改权限前先确认。
