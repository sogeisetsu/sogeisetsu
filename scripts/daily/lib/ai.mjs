#!/usr/bin/env node
/**
 * scripts/daily/lib/ai.mjs
 * ------------------------------------------------------------------
 * AI 适配层的**桶**（零依赖 ESM，Node 20+）。本文件**只有 re-export，没有实现**。
 *
 * 实现按职责分在 scripts/daily/lib/ai/ 下：
 *   prose.mjs       文本标尺：sanitizeReason / countSentences / splitSentences /
 *                   fitHeadline / fitText / fitSentences / unescapeProse（**零 import**，
 *                   表现层直连这里，不要绕桶）
 *   transport.mjs   单腿尝试：attemptProvider + 全部重试阶梯、JSON 提取、max_tokens 扩容
 *   structured.mjs  lane 编排：generateStructured（腿之间）+ lane 预算与合成失败腿
 *   narrative.mjs   日报叙述：SYSTEM_PROMPT / buildPrompts / validateNarrative / generateNarrative
 *   defaults.mjs    日报线默认 provider 列表（= providersForLane("daily")）
 * 叙述口径（自动提交必须是相加关系）在 scripts/lib/rules.mjs。
 *
 * **桶的使用边界**：编排层（daily/index、summary/index、providers.mjs CLI、diagnose-*、
 * 各测试）从本文件 import；表现层（render*.mjs / site/**）**不许** import 本文件 ——
 * 桶会把 transport + providers 拖回渲染路径，表现层只许直连 ai/prose.mjs 或 lib/rules.mjs。
 * 这条边界由 scripts/test-boundaries.mjs 的规则 e 锁住。
 *
 * data schema（generateNarrative 的输入契约）：
 *   {
 *     date, windowStart, windowEnd, username, generatedAt, empty,
 *     totals:      { commits, prs, issues, reviews },
 *     commits:       [ { repo, count, own } ],
 *     pullRequests:  [ { repo, number, title, url, action, ts, own } ],
 *     reviews:       [ { repo, number, title, url, ts, own } ],
 *     issues:        [ { repo, number, title, url, action, ts, own } ],
 *     releases:      [ { repo, tag, name, url, publishedAt, notes } ],
 *     stars:         [ { repo, delta, total } ],
 *     replies:       [ { repo, number, title, url, author, excerpt, kind, ts, own } ],
 *     stateChanges:  [ { repo, number, title, action, actor, ts } ],
 *     discussions:   [ { repo, number, title, category, comments, action, ts } ],
 *     truncated:     { events|targets|replies|stateChanges: { cap, hits } }
 *   }
 *
 * provider 结构：{ name, endpoint, baseUrl, apiKey, model, shape, headers?, reasoningEffort?, extraBody?, responseFormat? }
 *   name = **稳定 slug**（`attempts[].provider` / 页面徽章用它），model = 真实 API id；
 *   链顺序 / 参数 / 预算一律来自 `config/providers.json`（`scripts/daily/lib/providers.mjs` 解析）。
 *
 * 直接用 CLI 跑叙事：node scripts/daily/lib/ai/narrative.mjs --data=path.json
 */

export {
  countSentences,
  fitHeadline,
  fitSentences,
  fitText,
  sanitizeReason,
  splitSentences,
  unescapeProse,
} from "./ai/prose.mjs";
export { AUTOMATED_OVERLAP_RE, narrativeWordingOk } from "../../lib/rules.mjs";
export { generateStructured } from "./ai/structured.mjs";
export { generateNarrative } from "./ai/narrative.mjs";
export { defaultProviders } from "./ai/defaults.mjs";
