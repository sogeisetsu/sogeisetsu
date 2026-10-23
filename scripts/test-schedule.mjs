#!/usr/bin/env node
/**
 * scripts/test-schedule.mjs
 * ------------------------------------------------------------------
 * 调度对账（零依赖，不触网、不需要 key）：workflow 的 `cron:` 与 Cloudflare
 * watchdog 的 `TARGETS` 必须逐项一致。
 *
 * 为什么需要它：调度事实手抄在三处 —— 三份 workflow 的 `cron:`、Worker 的 TARGETS、
 * `ops/README.md` 的文字。改了一处忘另两处，表现是「补跑风暴」或「该补的没补」，
 * 而且只在 GitHub 丢 schedule 的那天才暴露。这里把前两处做成硬断言（README 是文档，
 * 不参与）。
 *
 * 断言（任一不满足即红）：
 *   · 每个被 TARGETS 引用的 workflow 文件存在；TARGETS 恰好 3 条
 *   · 三个 workflow 恰好各 1 条 `cron:`；形态必须落在已支持的两种：
 *       `m *​/n * * *`（每 n 小时的第 m 分）或 `m h * * *`（每天固定 UTC h 时第 m 分）
 *     不认识的形态直接红 —— 否则将来改 cron 写法会静默失配
 *   · label / workflow 名 / 分钟 / 小时步长 / 固定 UTC 时点逐项与 cron 一致
 *   · 有 `cron:` 的 workflow 与 TARGETS 覆盖的 workflow 集合相等（不多不少）
 *
 * 刻意不碰 `wrangler.toml`、不重新部署、不改运行时行为：Cloudflare 运行时没有仓文件，
 * 让 Worker 自己去读 workflow 是做不到的。
 *
 * 用法：node scripts/test-schedule.mjs
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "./lib/paths.mjs";

const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const WORKER = path.join(ROOT, "ops", "cloudflare-cron", "worker.mjs");

let failed = 0;

function check(name, ok, detail) {
  if (ok) console.log(`PASS ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * 解析一条 cron 表达式，只接受「按小时步长」与「每天固定时点」两种形态。
 * @returns {{minute:number, hourStep?:number, hour?:number}|null}
 */
export function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteRaw, hourRaw, dom, month, dow] = parts;
  if (!/^\d{1,2}$/.test(minuteRaw)) return null;
  if (dom !== "*" || month !== "*" || dow !== "*") return null;
  const minute = Number(minuteRaw);
  if (minute > 59) return null;

  const step = /^\*\/(\d{1,2})$/.exec(hourRaw);
  if (step) {
    const hourStep = Number(step[1]);
    if (hourStep < 1 || hourStep > 24) return null;
    return { minute, hourStep };
  }
  if (/^\d{1,2}$/.test(hourRaw)) {
    const hour = Number(hourRaw);
    if (hour > 23) return null;
    return { minute, hour };
  }
  return null;
}

/** 从一份 workflow 里取出全部 `cron:` 值（先剔 YAML 注释行，避免注释里的示例被算进去）。 */
export function cronsOf(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    const m = /^\s*-\s*cron:\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = m[1].replace(/^["']|["']$/g, "").trim();
    if (value) out.push(value);
  }
  return out;
}

/** 解析 worker.mjs 的 TARGETS 数组（源码级、不执行 Worker）。 */
export function parseTargets(source) {
  const start = String(source || "").indexOf("const TARGETS = [");
  if (start === -1) return null;
  const end = String(source).indexOf("];", start);
  if (end === -1) return null;
  const block = String(source).slice(start, end);
  const targets = [];
  for (const m of block.matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1];
    const label = /label:\s*["']([^"']+)["']/.exec(body);
    const workflow = /workflow:\s*["']([^"']+)["']/.exec(body);
    const slotMinute = /slotMinute:\s*(\d+)/.exec(body);
    const hourStep = /hourStep:\s*(\d+)/.exec(body);
    const slotHourUtc = /slotHourUtc:\s*(\d+)/.exec(body);
    if (!label || !workflow || !slotMinute) continue;
    targets.push({
      label: label[1],
      workflow: workflow[1],
      slotMinute: Number(slotMinute[1]),
      hourStep: hourStep ? Number(hourStep[1]) : undefined,
      slotHourUtc: slotHourUtc ? Number(slotHourUtc[1]) : undefined,
    });
  }
  return targets;
}

// ---------------------------------------------------------------- 自测（解析器必须命中）

{
  const stepped = parseCron("17 */2 * * *");
  const fixed = parseCron("17 22 * * *");
  check("parseCron: 两种已支持形态", [
    stepped && stepped.minute === 17 && stepped.hourStep === 2,
    fixed && fixed.minute === 17 && fixed.hour === 22,
  ].every(Boolean));
  check("parseCron: 不认识的形态返回 null",
    parseCron("0 0 * * 1") === null && parseCron("*/5 * * * *") === null && parseCron("nope") === null);
  const sample = cronsOf('jobs:\n  x:\n    steps:\n      - run: echo\n# - cron: "0 0 * * *"\non:\n  schedule:\n    - cron: "17 */2 * * *"\n');
  check("cronsOf: 注释里的示例不算数", sample.length === 1 && sample[0] === "17 */2 * * *");
}

// ---------------------------------------------------------------- 真实对账

{
  const seen = new Set();
  const targets = parseTargets(readFileSync(WORKER, "utf8"));
  check("worker TARGETS 可解析", Array.isArray(targets) && targets.length === 3, `${targets ? targets.length : "null"} 条`);
  check("TARGETS 恰好 3 条", Array.isArray(targets) && targets.length === 3);

  for (const t of targets || []) {
    const file = path.join(WORKFLOW_DIR, t.workflow);
    check(`${t.label}: workflow 存在（${t.workflow}）`, existsSync(file));

    const crons = existsSync(file) ? cronsOf(readFileSync(file, "utf8")) : [];
    check(`${t.label}: 恰好 1 条 cron`, crons.length === 1, `实际 ${crons.length} 条`);
    if (crons.length !== 1) continue;
    seen.add(t.workflow);

    const parsed = parseCron(crons[0]);
    check(`${t.label}: cron 形态可识别（${crons[0]}）`, parsed !== null);
    if (!parsed) continue;

    check(`${t.label}: 分钟一致`, parsed.minute === t.slotMinute, `cron=${parsed.minute} worker=${t.slotMinute}`);
    if (Number.isInteger(t.slotHourUtc)) {
      check(
        `${t.label}: 固定时点一致`,
        parsed.hour === t.slotHourUtc && t.hourStep === undefined,
        `cron hour=${parsed.hour} step=${parsed.hourStep} worker hour=${t.slotHourUtc}`
      );
    } else {
      check(
        `${t.label}: 小时步长一致`,
        parsed.hourStep === t.hourStep,
        `cron step=${parsed.hourStep} worker step=${t.hourStep}`
      );
    }
  }

  // 文件系统里带 cron 的 workflow 必须都被 TARGETS 覆盖（不漏）
  const allCronWorkflows = [];
  for (const entry of readdirSyncSafe(WORKFLOW_DIR)) {
    if (!entry.endsWith(".yml")) continue;
    const crons = cronsOf(readFileSync(path.join(WORKFLOW_DIR, entry), "utf8"));
    if (crons.length > 0) allCronWorkflows.push(entry);
  }
  const uncovered = allCronWorkflows.filter((f) => !seen.has(f));
  check(
    "带 cron 的 workflow 都被 TARGETS 覆盖",
    uncovered.length === 0,
    `未覆盖: ${uncovered.join(", ")}（改调度要同时改 ops/cloudflare-cron/worker.mjs）`
  );
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

console.log(failed === 0 ? "\nschedule OK" : `\nschedule FAILED（${failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
