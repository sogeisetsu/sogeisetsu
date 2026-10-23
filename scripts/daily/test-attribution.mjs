#!/usr/bin/env node
/**
 * scripts/daily/test-attribution.mjs
 * ------------------------------------------------------------------
 * `data/attribution.json` 归属修正名单的确定性回归（零依赖、**不触网**、不需要 key）。
 *
 * 覆盖：
 *   1 parseAttribution   合法条目归一（sha 小写、说明字段保留）
 *   2 容错             根不是对象 / commits 不是数组 / 元素不是对象 → 跳过，不抛
 *   3 sha 校验         非 40 位十六进制（含 7 位短 sha）一律跳过并 warn；同 sha 只留第一条
 *   4 attributionLookup 命中（大小写不敏感）、未命中、空名单、非法 sha → null
 *   5 loadAttribution  文件不存在 / JSON 损坏 → 空 Map 且不抛；真实名单文件可解析且字段齐备
 *
 * 判定语义（buildCommits 里的接线）不在这里测：它只接管“其他人类提交”这一档，
 * 合并提交 / 机器人 / 窗口过滤 / sha 去重的行为不变，属于采集层（需网络）的既有约定。
 *
 * 用法：node scripts/daily/test-attribution.mjs
 * 输出：每个用例一行 PASS/FAIL，结尾 N/M；有失败时退出码 1。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const LIVE_FILE = path.join(ROOT, "data", "attribution.json");

const { parseAttribution, loadAttribution, attributionLookup } = await import(
  new URL("./lib/github.mjs", import.meta.url).href
);

const TMP = mkdtempSync(path.join(os.tmpdir(), "attribution-test-"));
const SHA_A = "982f9166004509d1ec2949fe9ada138f19687413";
const SHA_B = "00191c6490cd2bc76a97dbe415d4421f5ded62c8";

let total = 0;
let passed = 0;

function check(name, checks) {
  total += 1;
  const ok = checks.every(([, v]) => v);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  [${checks.map(([k, v]) => `${k}=${v}`).join(", ")}]`);
}

// --- 1 合法条目归一 -------------------------------------------------------------
{
  const map = parseAttribution({
    commits: [
      { sha: SHA_A.toUpperCase(), repo: "sogeisetsu/sopen-translate", author: "opencode <opencode@local>", ts: "2026-10-23T11:15:48Z", reason: "agent 占位身份" },
      { sha: SHA_B, repo: "a/b" },
    ],
  });
  const a = map.get(SHA_A);
  check("parse：合法条目归一（sha 小写 + 说明字段保留）", [
    ["size", map.size === 2],
    ["lowercased", a && map.get(SHA_A.toLowerCase()) === a],
    ["author", a && a.author === "opencode <opencode@local>"],
    ["reason", a && a.reason === "agent 占位身份"],
    ["missingFieldsEmpty", map.get(SHA_B) && map.get(SHA_B).reason === ""],
  ]);
}

// --- 2 容错 ---------------------------------------------------------------------
{
  const warns = [];
  const empty = (v) => parseAttribution(v, (m) => warns.push(m)).size;
  check("parse：结构非法 → 空名单且不抛", [
    ["null", empty(null) === 0],
    ["string", empty("not json") === 0],
    ["noCommits", empty({ version: 1 }) === 0],
    ["commitsNotArray", empty({ commits: {} }) === 0],
    ["garbageItems", empty({ commits: [null, 3, "x", {}] }) === 0],
    ["noThrow", true],
  ]);
}

// --- 3 sha 校验 + 重复 ----------------------------------------------------------
{
  const warns = [];
  const map = parseAttribution(
    {
      commits: [
        { sha: "982f916", repo: "short/sha" }, // 7 位短 sha：拒收（不做前缀匹配）
        { sha: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", repo: "not-hex" },
        { sha: SHA_A, repo: "first/repo" },
        { sha: SHA_A.toLowerCase(), repo: "second/repo" },
      ],
    },
    (m) => warns.push(m)
  );
  check("parse：短 sha / 非十六进制拒收，重复 sha 以第一条为准", [
    ["size", map.size === 1],
    ["firstWins", map.get(SHA_A) && map.get(SHA_A).repo === "first/repo"],
    ["warns", warns.length === 3],
    ["shortRejected", !map.has("982f916")],
  ]);
}

// --- 4 lookup -------------------------------------------------------------------
{
  const map = parseAttribution({ commits: [{ sha: SHA_A, repo: "a/b" }] });
  check("lookup：命中 / 未命中 / 空名单 / 非法 sha", [
    ["hit", attributionLookup(map, SHA_A) !== null],
    ["hitUpper", attributionLookup(map, SHA_A.toUpperCase()) !== null],
    ["miss", attributionLookup(map, SHA_B) === null],
    ["emptyMap", attributionLookup(new Map(), SHA_A) === null],
    ["noMap", attributionLookup(null, SHA_A) === null],
    ["shortSha", attributionLookup(map, "982f916") === null],
    ["blank", attributionLookup(map, "") === null],
  ]);
}

// --- 5 load：缺文件 / 坏 JSON / 真实名单 -----------------------------------------
{
  const missing = loadAttribution(path.join(TMP, "nope.json"));
  const brokenFile = path.join(TMP, "broken.json");
  writeFileSync(brokenFile, "{ not json ", "utf8");
  const broken = loadAttribution(brokenFile);
  const live = loadAttribution(LIVE_FILE);
  const entries = [...live.values()];
  check("load：缺文件 / 坏 JSON → 空名单；真实名单可解析且字段齐备", [
    ["missingEmpty", missing.size === 0],
    ["brokenEmpty", broken.size === 0],
    ["liveLoaded", entries.length > 0],
    ["liveAllFullSha", [...live.keys()].every((s) => /^[0-9a-f]{40}$/.test(s))],
    ["liveAllHaveRepo", entries.every((e) => e.repo.length > 0)],
    ["liveAllHaveAuthor", entries.every((e) => e.author.length > 0)],
    ["liveAllHaveTs", entries.every((e) => e.ts.length > 0)],
    ["liveAllHaveReason", entries.every((e) => e.reason.length > 0)],
  ]);
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed}/${total} attribution checks passed`);
process.exit(passed === total ? 0 : 1);
