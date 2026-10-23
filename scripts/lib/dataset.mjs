#!/usr/bin/env node
/**
 * scripts/lib/dataset.mjs
 * ------------------------------------------------------------------
 * `docs/data/<date>.json` 的**数据契约**（零依赖 ESM，Node 20+；**零 import**）。
 *
 * 为什么单独成文件：这份 JSON 是三条产物线（日报 / 30 天总结 / 活动卡片）共同的
 * 真相源，但它的字段集以前没有归口 —— 生产端（github.mjs 的 collectDailyData、
 * summary/backfill.mjs）各写各的，消费端（days.contentHash、verify 的手写 schema）
 * 各认一部分，新加一个字段只会在某处悄悄漏掉。
 *
 * 两个常量，两件事：
 *   DAY_FIELDS     顶层字段全集（含可选段）。verify 用 `⊆` 方向断言：
 *                  出现名单外的字段即红 —— 这样「新增字段」必须顺手登记，
 *                  而历史文件缺可选段（discussions / truncated / aiModel …）不会误伤。
 *   HASH_EXCLUDED  不参与内容哈希的字段。它们都是**运行状态**而不是数据内容：
 *                  同一份数据重跑一次就可能变，不能因此判定「内容有变化」而重采集。
 *
 * 红线：HASH_EXCLUDED 只许抽取，禁止顺手增删 —— 改它等于改全部历史日期的 dataHash，
 * 会触发重采集与重调 AI、并改写已发布页面。得改就得当成一次口径变更来评审。
 */

/**
 * `docs/data/<date>.json` 的顶层字段全集（2026-10-24 用 `docs/data` ∪ `data/backfill`
 * 的全量 union 实测：26 个字段 / 39 份文件；不得照抄计划文本，改数据结构后要重测）。
 * 可选段在历史文件里可以缺失，但**不许出现名单外的字段**。
 */
export const DAY_FIELDS = [
  // 标识与窗口
  "date",
  "windowStart",
  "windowEnd",
  "username",
  "generatedAt",
  "empty",
  // 确定数字与明细（totals = 明细求和，由代码算，AI 只叙述）
  "totals",
  "commits",
  "automatedCommits",
  "pullRequests",
  "reviews",
  "issues",
  "releases",
  "stars",
  "starInventory",
  "replies",
  "stateChanges",
  "discussions",
  "truncated",
  // AI 叙述与运行状态
  "ai",
  "aiProvider",
  "aiModel",
  "aiFailure",
  // 回填来源标记（data/backfill 专用，见 summary/backfill.mjs）
  "source",
  "backfillLimits",
  // 内容哈希（HASH_EXCLUDED 自带这一项：哈希不算自己的输入）
  "dataHash",
];

/**
 * 不参与 `contentHash` 的字段（运行状态，不是数据内容）。
 * 逐项等于抽取前 `contentHash` 的排除名单，一个都没多、一个都没少。
 */
export const HASH_EXCLUDED = ["generatedAt", "ai", "aiProvider", "aiModel", "aiFailure", "dataHash"];
