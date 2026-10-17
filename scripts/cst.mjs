#!/usr/bin/env node
/**
 * scripts/lib/cst.mjs
 * ------------------------------------------------------------------
 * Asia/Shanghai（+08:00，固定偏移、无夏令时）自然日的共享口径（零依赖 ESM，Node 20+）。
 *
 * 为什么单独成文件：三条产物线 —— 日报（scripts/daily）、30 天总结（scripts/summary）、
 * 30 天活动卡片（scripts/generate-activity.mjs）—— 必须共用同一个「天」的定义，
 * 否则同一天的数据在两条线上会归到不同日期。本文件零 import，谁都可以拿；
 * scripts/daily/lib/days.mjs 从这里转出，老路径 `import { cstDayMinus } from "./lib/days.mjs"`
 * 全部不受影响。
 *
 * 天的定义：date 当天 00:00:00+08:00 ≤ ts < 次日 00:00:00+08:00。
 *
 * 别用 toISOString().slice(0, 10) 直接当日期 —— 那是 UTC 日历日，在 +08 的
 * 00:00–08:00 之间会比北京日期少一天。取日期一律走 cstDateOf()。
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CST_OFFSET_MS = 8 * 3600 * 1000;
export const DAY_MS = 24 * 3600 * 1000;

/** 毫秒时间戳 → 它落在的 +08 日历日（YYYY-MM-DD）。非法输入返回空串。 */
export function cstDateOf(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t)) return "";
  return new Date(t + CST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 此刻的 +08 日历日。 */
export function cstToday() {
  return cstDateOf(Date.now());
}

/** +08 日历日 → 该日 00:00:00+08:00 的 UTC 毫秒（闭区间下界）。 */
export function cstDateStartMs(date) {
  const t = Date.parse(`${date}T00:00:00+08:00`);
  return Number.isFinite(t) ? t : NaN;
}

/** +08 日历日 → 次日 00:00:00+08:00 的 UTC 毫秒（半开区间上界，该日不含）。 */
export function cstDateNextStartMs(date) {
  return cstDateStartMs(nextDateOf(date));
}

/** 把 +08 日历日平移 days 天（负数为往前），返回 YYYY-MM-DD。纯日历运算，无夏令时问题。 */
export function cstDateShift(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** +08 日历日，往前推 days 天，返回 YYYY-MM-DD。 */
export function cstDayMinus(days) {
  const shifted = new Date(Date.now() + CST_OFFSET_MS);
  const t = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - days)
  );
  return t.toISOString().slice(0, 10);
}

/** 把 YYYY-MM-DD 往前推一天。 */
export function prevDateOf(date) {
  return cstDateShift(date, -1);
}

/** 把 YYYY-MM-DD 往后推一天。 */
export function nextDateOf(date) {
  return cstDateShift(date, 1);
}

/** 闭区间 [from, to] 的日期列表（升序）。 */
export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = nextDateOf(d)) out.push(d);
  return out;
}
