#!/usr/bin/env node
/**
 * scripts/daily/check.mjs
 * ------------------------------------------------------------------
 * 本地预检（零依赖）：一次跑完全部检查，任一失败即退出码 1。
 *   1) node --check 语法检查：ai.mjs / render.mjs / github.mjs / index.mjs
 *   2) scripts/daily/test-ai.mjs  —— AI 适配层确定性回归（假服务器，无需 key）
 *   3) scripts/daily/verify.mjs    —— docs/ 生成物不变式自检
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

const syntaxTargets = ["lib/ai.mjs", "render.mjs", "lib/github.mjs", "index.mjs"];
let failed = 0;

for (const t of syntaxTargets) {
  if (!run(`node --check ${t}`, ["--check", path.join(DIR, t)])) failed += 1;
}
if (!run("test-ai.mjs（AI 适配层回归）", [path.join(DIR, "test-ai.mjs")])) failed += 1;
if (!run("test-render.mjs（渲染/规范化回归）", [path.join(DIR, "test-render.mjs")])) failed += 1;
if (!run("verify.mjs（docs 不变式）", [path.join(DIR, "verify.mjs"), "--quiet"])) failed += 1;

console.log(failed === 0 ? "\npreflight OK" : `\npreflight FAILED（${failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
