#!/usr/bin/env node
/**
 * scripts/daily/check.mjs
 * ------------------------------------------------------------------
 * 本地预检（零依赖）：一次跑完全部检查，任一失败即退出码 1。
 *   1) node --check 语法检查：递归扫描 scripts 目录下的**每一个** .mjs
 *      （清单不再手维护 —— 新增文件自动纳入，忘登记的类别连同它的断言一起消失）
 *   2) scripts/test-boundaries.mjs   —— 分层边界：七条禁边 + 合成图自测（不触网）
 *   3) scripts/daily/test-ai.mjs     —— AI 适配层确定性回归（假服务器，无需 key）
 *      scripts/daily/test-render.mjs —— 渲染/规范化确定性回归
 *      scripts/summary/test-summary.mjs —— 30 天总结确定性回归（假数据 + 假服务器）
 *      scripts/test-activity-window.mjs —— 活动卡片线口径/可见性确定性回归
 *      scripts/test-providers.mjs —— provider 配置 / lane 解析 / 写操作 / 接线断言 / lane 预算回归
 *      scripts/daily/test-attribution.mjs —— data/attribution.json 归属修正名单回归
 *      providers.mjs check —— 配置 schema + workflow 接线硬断言（漏配 secret 直接红）
 *   4) scripts/daily/verify.mjs      —— docs/ 生成物不变式自检
 *
 * 用法：node scripts/daily/check.mjs [--quiet]
 * 建议在提交前手动运行；也可在 CI 里作为独立 job 复用（不触网、不需要 secret）。
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

import { ROOT, SCRIPTS_DIR } from "../lib/paths.mjs";

const QUIET = process.argv.includes("--quiet");

function run(label, args) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
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

/** 递归列出 scripts 下的全部 .mjs（相对 scripts/ 的 posix 路径，排序稳定）。 */
function listScriptFiles(dir = SCRIPTS_DIR) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...listScriptFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      out.push(path.relative(SCRIPTS_DIR, abs).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

let failed = 0;

const syntaxFiles = listScriptFiles();
for (const rel of syntaxFiles) {
  if (!run(`node --check ${rel}`, ["--check", path.join(SCRIPTS_DIR, rel)])) failed += 1;
}
if (!run("test-boundaries.mjs（分层边界 + 合成图自测）", [path.join(SCRIPTS_DIR, "test-boundaries.mjs")])) failed += 1;
if (!run("test-ai.mjs（AI 适配层回归）", [path.join(SCRIPTS_DIR, "daily", "test-ai.mjs")])) failed += 1;
if (!run("test-render.mjs（渲染/规范化回归）", [path.join(SCRIPTS_DIR, "daily", "test-render.mjs")])) failed += 1;
if (!run("test-summary.mjs（30 天总结回归）", [path.join(SCRIPTS_DIR, "summary", "test-summary.mjs")])) failed += 1;
if (!run("test-activity-window.mjs（活动卡片口径/可见性回归）", [path.join(SCRIPTS_DIR, "test-activity-window.mjs")])) failed += 1;
if (!run("test-providers.mjs（provider 配置回归）", [path.join(SCRIPTS_DIR, "test-providers.mjs")])) failed += 1;
if (!run("test-attribution.mjs（归属修正名单回归）", [path.join(SCRIPTS_DIR, "daily", "test-attribution.mjs")])) failed += 1;
if (!run("providers check（配置 schema + workflow 接线）", [path.join(SCRIPTS_DIR, "providers.mjs"), "check"])) failed += 1;
if (!run("verify.mjs（docs 不变式）", [path.join(SCRIPTS_DIR, "daily", "verify.mjs"), "--quiet"])) failed += 1;

if (!QUIET) console.log(`\n语法检查覆盖 ${syntaxFiles.length} 个 .mjs（递归扫描）`);
console.log(failed === 0 ? "\npreflight OK" : `\npreflight FAILED（${failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
