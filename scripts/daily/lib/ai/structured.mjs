#!/usr/bin/env node
/**
 * scripts/daily/lib/ai/structured.mjs
 * ------------------------------------------------------------------
 * lane 级编排：按顺序尝试 providers，管 lane 总预算与「剩余腿」的合成失败记录
 * （零依赖 ESM，Node 20+）。单腿的重试阶梯在 ai/transport.mjs。
 *
 * 命名不用 lane.mjs：`lane` 已经是 config/providers.json 的概念（daily / summary），
 * 两个 lane 会撞车。本文件叫 structured，指的是「结构化 JSON 输出」这一层。
 */

import { LOG, MIN_ATTEMPT_MS, attemptProvider, normalizeProvider } from "./transport.mjs";

// ---------------------------------------------------------------- 主入口

/**
 * 通用结构化生成入口：按顺序尝试 providers。
 *   成功 → { value, provider, model, attempts }
 *   没有可用 provider / 全部 provider 失败 → null（attempts 只在成功时随返回值给出；
 *   需要在失败时拿到逐条原因就传 onProviderFailure）
 *
 * `validate(parsed)`（同步）决定「这份 JSON 能不能收」，`feedback(reason, n)`（可选）
 * 给出针对性的纠正提示；日报的 generateNarrative 与 30 天总结都走这里，
 * 重试/JSON 模式/截断/退让行为完全一致。
 *
 * `onProviderFailure({ provider, model, reason })`（可选）：每有一条 provider 失败就回调一次 —
 * 调用方（日报 / 总结编排）据此收集 attempts，写失败记录并开常驻 issue。
 *
 * `budgetMs`（可选）：**整条 lane 的总预算**（来自 `config/providers.json` 的 `lanes.<lane>.budgetMs`）。
 * 入口算 deadline，交给 attemptProvider 收敛每条腿的单次超时；预算在腿之间耗尽时，
 * 对**剩余每条腿各补一条合成 attempt**（reason=「未尝试（超出 lane 预算 N 分钟）」）并照常回调
 * onProviderFailure —— 于是自然落进现有的失败记录 + 常驻 issue + 页面失败卡，**绝不静默截断**。
 * 不传 = 不设预算（总结线现状：deepseek 实测 51.8–83.0s + sensenova 兜底）。
 */
export async function generateStructured({
  system,
  user,
  validate,
  providers,
  feedback,
  onProviderFailure,
  budgetMs,
} = {}) {
  const list = Array.isArray(providers) ? providers : [];
  if (list.length === 0) {
    console.error(`${LOG} 没有可用 provider（未配置 API key）`);
    return null;
  }
  if (typeof validate !== "function") {
    console.error(`${LOG} 缺少 validate 校验器`);
    return null;
  }

  const hasBudget = Number.isFinite(budgetMs) && budgetMs > 0;
  const deadline = hasBudget ? Date.now() + budgetMs : Infinity;
  const budgetLabel = hasBudget
    ? budgetMs >= 60000
      ? `${Math.round(budgetMs / 60000)} 分钟`
      : `${Math.round(budgetMs / 1000)} 秒`
    : "";
  const budgetReason = `未尝试（超出 lane 预算 ${budgetLabel}）`;

  const notifyFailure = (failed) => {
    if (typeof onProviderFailure !== "function") return;
    try {
      onProviderFailure(failed);
    } catch (err) {
      // 回调是调用方的可见性旁路，它的异常不该影响生成流程
      console.error(`${LOG} onProviderFailure 回调异常: ${err && err.message ? err.message : String(err)}`);
    }
  };

  // 先规范化整条链，预算耗尽时才能对「剩余每条腿」都补出 provider/model 正确的合成 attempt
  const normalized = [];
  for (const raw of list) {
    const provider = await normalizeProvider(raw);
    if (provider) normalized.push(provider);
  }
  if (normalized.length === 0) {
    console.error(`${LOG} 没有可用 provider（条目都不完整）`);
    return null;
  }

  const attempts = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const provider = normalized[i];
    // 预算在腿之间耗尽：剩下的腿全部记成「未尝试」，不留「这条腿没提过」的黑洞
    if (deadline - Date.now() <= MIN_ATTEMPT_MS) {
      for (const skipped of normalized.slice(i)) {
        const failed = { provider: skipped.name, model: skipped.model, reason: budgetReason };
        console.error(`${LOG} ${skipped.name}: 跳过 — ${budgetReason}`);
        attempts.push(failed);
        notifyFailure(failed);
      }
      break;
    }
    console.error(`${LOG} ${provider.name}: 尝试（shape=${provider.shape}, model=${provider.model}）`);
    const outcome = await attemptProvider(provider, system, user, validate, feedback, deadline);
    if (outcome.ok) {
      console.error(`${LOG} ${provider.name}: 成功`);
      return { value: outcome.value, provider: provider.name, model: provider.model, attempts };
    }
    console.error(`${LOG} ${provider.name}: 失败 — ${outcome.reason}`);
    const failed = { provider: provider.name, model: provider.model, reason: outcome.reason };
    attempts.push(failed);
    notifyFailure(failed);
  }

  console.error(`${LOG} 所有 provider 均失败`);
  return null;
}
