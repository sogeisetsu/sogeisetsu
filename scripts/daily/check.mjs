#!/usr/bin/env node
/**
 * scripts/daily/check.mjs
 * ------------------------------------------------------------------
 * 本地预检（零依赖）：一次跑完全部检查，任一失败即退出码 1。
 *   1) node --check 语法检查：ai.mjs / render.mjs / github.mjs / index.mjs
 *      以及 30 天总结侧 scripts/summary/* 全部脚本、AI 失败通知器
 *      （notify-ai-failure.mjs）与失败诊断两件套
 *      （diagnose-providers.mjs / diagnose-narrate.mjs），外加活动卡片线
 *      （generate-activity.mjs / render-svg.mjs / preview.mjs / cst.mjs）
 *      与 provider 配置层（lib/providers.mjs / providers.mjs CLI / 它的回归测试）
 *   2) scripts/daily/test-ai.mjs     —— AI 适配层确定性回归（假服务器，无需 key）
 *      scripts/daily/test-render.mjs —— 渲染/规范化确定性回归
 *      scripts/summary/test-summary.mjs —— 30 天总结确定性回归（假数据 + 假服务器）
 *      scripts/test-activity-window.mjs —— 活动卡片线口径/可见性确定性回归
 *      scripts/test-providers.mjs —— provider 配置 / lane 解析 / 写操作 / 接线断言 / lane 预算回归
 *      providers.mjs check —— 配置 schema + workflow 接线硬断言（漏配 secret 直接红）
 *   3) scripts/daily/verify.mjs      —— docs/ 生成物不变式自检
 *
 * 用法：node scripts/daily/check.mjs [--quiet]
 * 建议在提交前手动运行；也可在 CI 里作为独立 job 复用（不触网、不需要 secret）。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const QUIET = process.argv.includes("--quiet");

function run(label, args) {
  const res = spawnSync(process.execPath, args, { cwd: path.resolve(DIR, "..", ".."), encoding: "utf8" });
  const ok = res.status === 0;
  const tail = (res.stdout || "").trim().split("\n").filter(Boolean).slice(-1)[0] || "";
  if (ok) {
    if (!QUIET) console.log(`OK   ${label}${tail ? `  (${tail})` : ""}`);
  } else {
    console.log(`FAIL ${label}`);
    if (res.stdout) console.log(res.stdout.trim());
    if (res.stderr) console.log(res.stderr.trim());
  }
  return ok;
}

const syntaxTargets = [
  "lib/ai.mjs",
  "lib/providers.mjs",
  "lib/days.mjs",
  "render.mjs",
  "lib/github.mjs",
  "index.mjs",
  "../cst.mjs",
  "../generate-activity.mjs",
  "../render-svg.mjs",
  "../preview.mjs",
  "../providers.mjs",
  "../notify-ai-failure.mjs",
  "../diagnose-providers.mjs",
  "../diagnose-narrate.mjs",
  "../summary/collect.mjs",
  "../summary/prompt.mjs",
  "../summary/validate-summary.mjs",
  "../summary/render.mjs",
  "../summary/backfill.mjs",
  "../summary/index.mjs",
  "../test-activity-window.mjs",
  "../test-providers.mjs",
];
let failed = 0;

for (const t of syntaxTargets) {
  if (!run(`node --check ${t}`, ["--check", path.join(DIR, t)])) failed += 1;
}
if (!run("test-ai.mjs（AI 适配层回归）", [path.join(DIR, "test-ai.mjs")])) failed += 1;
if (!run("test-render.mjs（渲染/规范化回归）", [path.join(DIR, "test-render.mjs")])) failed += 1;
if (!run("test-summary.mjs（30 天总结回归）", [path.join(DIR, "..", "summary", "test-summary.mjs")])) failed += 1;
if (!run("test-activity-window.mjs（活动卡片口径/可见性回归）", [path.join(DIR, "..", "test-activity-window.mjs")])) failed += 1;
if (!run("test-providers.mjs（provider 配置回归）", [path.join(DIR, "..", "test-providers.mjs")])) failed += 1;
if (!run("providers check（配置 schema + workflow 接线）", [path.join(DIR, "..", "providers.mjs"), "check"])) failed += 1;
if (!run("verify.mjs（docs 不变式）", [path.join(DIR, "verify.mjs"), "--quiet"])) failed += 1;

console.log(failed === 0 ? "\npreflight OK" : `\npreflight FAILED（${failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
