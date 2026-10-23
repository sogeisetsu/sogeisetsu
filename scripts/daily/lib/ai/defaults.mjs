#!/usr/bin/env node
/**
 * scripts/daily/lib/ai/defaults.mjs
 * ------------------------------------------------------------------
 * 日报线的默认 provider 列表（零依赖 ESM，Node 20+）。
 */

import { providersForLane } from "../providers.mjs";

// ---------------------------------------------------------------- provider 列表

/**
 * 日报线的 provider 列表 —— 等价 `providersForLane("daily", env)`。
 *
 * 链顺序、模型 id、参数（reasoningEffort / extraBody / responseFormat）、endpoint 头**全部**来自
 * `config/providers.json`；本文件不再写死任何一条腿。改链路 / 改参数 = 改那个 JSON + 跑
 * `node scripts/providers.mjs check`（`check.mjs` 里会跑）。
 *
 * 配置缺失 / JSON 损坏 / schema 不合法时，`providers.mjs` 会 warn 并回落到内置 FALLBACK_CHAIN
 * （deepseek → sensenova）：CI 不能因为一个坏 JSON 全挂，但提交前预检会让坏配置直接红。
 */
export function defaultProviders(env = process.env) {
  return providersForLane("daily", env);
}
