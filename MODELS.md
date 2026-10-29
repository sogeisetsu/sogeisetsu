# 大模型配置说明

> 机器可读的唯一事实来源是 `config/providers.json`；本文件是它的人类可读说明。
> **改 `config/providers.json` 就必须同步改本文件**（链顺序、模型、参数、预算、key 名任何一项变了都算）。
> 怎么改（CLI、探测、接线）：见 `assets/providers-cli.md`。

---

## 1. 哪些功能会调用大模型

| 功能 | 入口 | 触发 | 用的链 |
| --- | --- | --- | --- |
| 每日活动日报正文（中英 headline + 摘要） | `scripts/daily/index.mjs` | `update-daily-report.yml`：cron `17 */2 * * *`（+08 每 2 小时），另有 `scripts/daily/**`、`config/**` 等 push 触发、手动 dispatch | `lanes.daily` |
| 近 30 天 AI 总结（overview / highlights / byRepo） | `scripts/summary/index.mjs` | `update-summary.yml`：cron `17 22 * * *`（UTC，+08 06:17），**无 push 触发**，改完要手动 dispatch | `lanes.summary` |
| AI 失败后的诊断叙述（写进 issue 回帖） | `scripts/diagnose-narrate.mjs` | 只在**本次新建**了常驻 `ai-failure` issue 时，由日报 / 总结 workflow 在推送后调用 | 不走 lane，见第 4 节 |
| `/oc` 手动诊断 | `.github/workflows/opencode.yml` | 仓库所有者评论含 `/oc` | 同上 |

不调用大模型的功能：近 30 天活动卡片（`scripts/generate-activity.mjs`）、日报里的数字 / 表格 / 图表、`check.mjs` 与全部测试。

**什么时候真正发出请求**：只有该功能判定「有变化」时（日报按 dataHash 跳过未变化的一天，总结同理）；`--force` 绕过这个跳过；`--no-ai` 与「一个 key 都没配」的情况只产出「确定数字 + AI 暂不可用」版本，不发请求。

## 2. 日报链（`lanes.daily`）

按顺序尝试，某条腿失败（网络异常 / 429 / 超时 / 输出不合校验）就换下一条；整条链总预算 **480000ms（8 分钟）**，单次请求超时 180s，`max_tokens` 49152（截断时翻倍到 65536）。

| # | slug | endpoint / 真实模型 | 关键参数 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `nvidia-minimax-flash` | `nvidia` / `minimaxai/minimax-m3.1-flash` | `reasoningEffort: low` | 最快且中英对称（实测 8.9–9.8s）；连续快调会 429 |
| 2 | `nvidia-nemotron-ultra` | `nvidia` / `nvidia/nemotron-3-ultra-550b-a55b` | 默认（`reasoning_effort: none`） | 27–33s，事实 3/3；改 `low` 会到 37–106s，别改 |
| 3 | `opencode-go-deepseek` | `opencode-go` / `deepseek-v4.1-flash` | 默认 | OpenCode Go 套餐内额度 |
| 4 | `sensenova` | `sensenova` / `glm-5.2` | `extraBody.thinking.type=disabled` | 额度独立于 Go 账号；不关思考 content 恒为空 |
| 5 | `dots3-note-prev` | `dots` / `dots3-note-prev` | `extraBody.chat_template_kwargs.enable_thinking=false` | 小红书 Dots Studio，限时免费。**实测生产 prompt 撞 180s 超时，未过 ≤90s 门槛**，所以只做链尾兜底 |

- 每次日报运行会跑**两天**：昨天（定稿）+ 今天（滚动），所以链的耗时是双份的。
- 链尾的 `dots3-note-prev` 只在前四条全挂时才会被用到；它慢，但慢在最后一段，不会拖累正常路径。
- 认证：`dots` 用 `Authorization: Bearer <key>`（平台文档写的 `api-key` 头同样可用），所以传输层不需要特例。

## 3. 30 天总结链（`lanes.summary`）

不设总预算（`budgetMs` 省略），单次请求同样 180s 超时。

| # | slug | endpoint / 真实模型 | 说明 |
| --- | --- | --- | --- |
| 1 | `opencode-go-deepseek` | `opencode-go` / `deepseek-v4.1-flash` | 长输出 + 强校验只有它稳定过 |
| 2 | `sensenova` | `sensenova` / `glm-5.2` | Go 不可用时的兜底 |

总结线**不用** `nvidia-*` 与 `dots3-note-prev`：它的输出更长、校验更严，免费额度的限流会拖垮整条链。

## 4. 不在 lane 里的模型

| 用途 | 模型 | 配置位置 |
| --- | --- | --- |
| AI 失败诊断叙述 | `opencode-go/deepseek-v4.1-flash`（默认） | 仓库变量 `DIAG_MODEL`；`opencode-go` 整体挂掉时换成 `sensenova/glm-5.2` |
| 配置坏掉时的灾备链 | `opencode-go-deepseek` → `sensenova` | `scripts/daily/lib/providers.mjs` 的 `FALLBACK_CHAIN`（**刻意不跟随配置改动**，只在 JSON 读不出 / schema 不合法时生效） |

诊断叙述走 `opencode run`，凭据用 `OPENCODE_CONFIG_CONTENT` 里的 `{env:OPENCODE_API_KEY}` / `{env:SENSENOVA_API_KEY}` 注入，不依赖 `auth.json`。

## 5. key 与接线

| endpoint | 环境变量 | 用途 |
| --- | --- | --- |
| `nvidia` | `NVIDIA_API_KEY`（本地别名 `Nvidia`） | 日报链 1–2 |
| `opencode-go` | `OPENCODE_API_KEY` | 日报链 3、总结链 1、诊断 |
| `sensenova` | `SENSENOVA_API_KEY` | 日报链 4、总结链 2、诊断兜底 |
| `dots` | `DOTS_API_KEY` | 日报链 5 |

key 只以环境变量名出现在配置里，明文永不入库。跑 `node scripts/daily/index.mjs` 的 workflow 必须有 daily 链每个 endpoint 的 `secrets.<KEY_ENV>`；跑总结的必须有 summary 链的；跑诊断的必须有**每个 enabled endpoint** 的 —— 这套接线是硬断言（`node scripts/providers.mjs check`，`check.mjs` 里会跑），漏配提交前就红。

## 6. 改配置时的检查清单

```powershell
node scripts/providers.mjs check     # schema + workflow 接线
node scripts/daily/check.mjs         # 全量预检（含 test-ai / test-providers 的链顺序断言）
```

- 新增 / 删除 / 换序一条腿 → 同步改本文件第 2、3 节的表。
- 改了 `scripts/daily/test-ai.mjs` 里的 `dailyFullOrder` 断言（它逐字比对 `lanes.daily.order`）。
- `config/**` 在日报 workflow 的 push 白名单里：合并即触发一次真实运行，这是验收也是第一次真实证据。

## 7. 选型记录（P0 实测，2026-10-23）

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

`dots3-note-prev`（2026-10-30 实测，同一份生产 prompt）：小 prompt（`--prompt=small`）27s 通过；完整日报 prompt 两次都撞 180s 超时，所以没进链首、只做链尾兜底。

局限（别当成保证）：CI 在 ubuntu-latest、本地探测在本机，境内外可达性与延迟可能不同 —— 合并后第一次真实运行才是终局证据；更重的日子 prompt 更大（`SECTION_CAP=30` 封顶）；minimax 连续快调会 429（线上开始频繁 429 先看是不是同一天跑了两次 AI）；免费层随时可能下架（`longcat-2.5-preview-free` / `minimax-m3.1-flash-free` 已在 2026-10-23 走过这条路），所以删一条腿的成本必须仍然只是「改 JSON 里一行」。
