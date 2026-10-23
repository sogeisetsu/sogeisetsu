#!/usr/bin/env node
/**
 * scripts/daily/test-attribution.mjs
 * ------------------------------------------------------------------
 * `data/attribution.json` 归属修正数据的确定性回归（零依赖、**不触网**、不需要 key）。
 *
 * 两段独立：
 *   1 commits    sha 白名单：合法条目归一（sha 小写、说明字段保留）；非 40 位十六进制
 *                （含 7 位短 sha）拒收；重复 sha 只留第一条
 *   2 identities 身份规则：name + email 精确配对；ownReposOnly / requireUnlinkedAuthor
 *                默认为 true（保守），显式 false 才放宽；缺 name 或 email 的条目拒收
 *   3 容错      根不是对象 / 列表不是数组 / 元素不是对象 → 跳过，不抛
 *   4 lookup    sha 命中（大小写不敏感）、身份命中（两条件都满足才算）、空数据 / 非法输入 → null
 *   5 load      文件不存在 / JSON 损坏 → 空数据且不抛；真实数据文件可解析且字段齐备
 *
 * 判定语义（buildCommits 里的接线）不在这里测：修正数据只接管“其他人类提交”这一档，
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

const { parseAttribution, loadAttribution, attributionLookup, identityLookup } = await import(
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

// --- 1 commits：合法条目归一 ------------------------------------------------------
{
  const attr = parseAttribution({
    commits: [
      { sha: SHA_A.toUpperCase(), repo: "sogeisetsu/sopen-translate", author: "opencode <opencode@local>", ts: "2026-10-23T11:15:48Z", reason: "agent 占位身份" },
      { sha: SHA_B, repo: "a/b" },
    ],
  });
  const a = attr.commits.get(SHA_A);
  check("commits：合法条目归一（sha 小写 + 说明字段保留）", [
    ["size", attr.commits.size === 2],
    ["lowercased", a && attr.commits.get(SHA_A.toLowerCase()) === a],
    ["author", a && a.author === "opencode <opencode@local>"],
    ["reason", a && a.reason === "agent 占位身份"],
    ["missingFieldsEmpty", attr.commits.get(SHA_B) && attr.commits.get(SHA_B).reason === ""],
    ["noIdentities", attr.identities.length === 0],
  ]);
}

// --- 2 identities：精确配对 + 保守默认值 -------------------------------------------
{
  const attr = parseAttribution({
    identities: [
      { name: "Jinansu", email: "Suyuesheng@Duck.com" },
      { name: "loose", email: "loose@x", ownReposOnly: false, requireUnlinkedAuthor: false },
      { name: "noemail" },
      { name: "", email: "x@y" },
      null,
    ],
  });
  const [first, second] = attr.identities;
  check("identities：精确配对归一 + 默认保守（两条都 true）", [
    ["size", attr.identities.length === 2],
    ["lowercased", first && first.name === "jinansu" && first.email === "suyuesheng@duck.com"],
    ["defaultsTrue", first && first.ownReposOnly === true && first.requireUnlinkedAuthor === true],
    ["explicitFalse", second && second.ownReposOnly === false && second.requireUnlinkedAuthor === false],
    ["missingEmailRejected", !attr.identities.some((r) => r.name === "noemail")],
  ]);
}

// --- 3 容错 ---------------------------------------------------------------------
{
  const warns = [];
  const empty = (v) => {
    const attr = parseAttribution(v, (m) => warns.push(m));
    return attr.commits.size + attr.identities.length;
  };
  check("parse：结构非法 → 空数据且不抛", [
    ["null", empty(null) === 0],
    ["string", empty("not json") === 0],
    ["noLists", empty({ version: 2 }) === 0],
    ["listsNotArray", empty({ commits: {}, identities: "x" }) === 0],
    ["garbageItems", empty({ commits: [null, 3, "x", {}], identities: [3, {}] }) === 0],
    ["noThrow", true],
  ]);
}

// --- 4 sha 校验 + 重复 ----------------------------------------------------------
{
  const warns = [];
  const attr = parseAttribution(
    {
      commits: [
        { sha: "982f916", repo: "short/sha" }, // 7 位短 sha：拒收（不做前缀匹配）
        { sha: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", repo: "not-hex" },
        { sha: SHA_A, repo: "first/repo" },
        { sha: SHA_A.toLowerCase(), repo: "second/repo" },
      ],
      identities: [
        { name: "dup", email: "dup@x" },
        { name: "dup", email: "dup@x" },
      ],
    },
    (m) => warns.push(m)
  );
  check("parse：短 sha / 非十六进制拒收，重复 sha 与重复身份都以第一条为准", [
    ["size", attr.commits.size === 1],
    ["firstWins", attr.commits.get(SHA_A) && attr.commits.get(SHA_A).repo === "first/repo"],
    ["identityDeduped", attr.identities.length === 1],
    ["warns", warns.length === 4],
    ["shortRejected", !attr.commits.has("982f916")],
  ]);
}

// --- 5 lookup -------------------------------------------------------------------
{
  const attr = parseAttribution({
    commits: [{ sha: SHA_A, repo: "a/b" }],
    identities: [
      { name: "jinansu", email: "suyuesheng@duck.com" },
      { name: "loose", email: "loose@x", ownReposOnly: false, requireUnlinkedAuthor: false },
    ],
  });
  const hit = (o) => identityLookup(attr, o) !== null;
  check("lookup：sha 命中 / 身份三道闸门", [
    ["shaHit", attributionLookup(attr, SHA_A) !== null],
    ["shaUpper", attributionLookup(attr, SHA_A.toUpperCase()) !== null],
    ["shaMiss", attributionLookup(attr, SHA_B) === null],
    ["shaEmpty", attributionLookup({ commits: new Map(), identities: [] }, SHA_A) === null],
    ["shaNoData", attributionLookup(null, SHA_A) === null],
    ["shaShort", attributionLookup(attr, "982f916") === null],
    ["idHit", hit({ name: "Jinansu", email: "Suyuesheng@duck.com", ownRepo: true, linked: false })],
    ["idNeedsOwnRepo", !hit({ name: "jinansu", email: "suyuesheng@duck.com", ownRepo: false, linked: false })],
    ["idNeedsUnlinked", !hit({ name: "jinansu", email: "suyuesheng@duck.com", ownRepo: true, linked: true })],
    ["idWrongEmail", !hit({ name: "jinansu", email: "other@duck.com", ownRepo: true, linked: false })],
    ["idWrongName", !hit({ name: "someone", email: "suyuesheng@duck.com", ownRepo: true, linked: false })],
    ["idLooseElsewhere", hit({ name: "loose", email: "loose@x", ownRepo: false, linked: true })],
    ["idNoData", identityLookup(null, { name: "jinansu", email: "suyuesheng@duck.com", ownRepo: true, linked: false }) === null],
  ]);
}

// --- 6 load：缺文件 / 坏 JSON / 真实数据 -----------------------------------------
{
  const missing = loadAttribution(path.join(TMP, "nope.json"));
  const brokenFile = path.join(TMP, "broken.json");
  writeFileSync(brokenFile, "{ not json ", "utf8");
  const broken = loadAttribution(brokenFile);
  const live = loadAttribution(LIVE_FILE);
  const entries = [...live.commits.values()];
  check("load：缺文件 / 坏 JSON → 空数据；真实数据可解析且字段齐备", [
    ["missingEmpty", missing.commits.size === 0 && missing.identities.length === 0],
    ["brokenEmpty", broken.commits.size === 0 && broken.identities.length === 0],
    ["liveCommits", entries.length > 0],
    ["liveFullSha", [...live.commits.keys()].every((s) => /^[0-9a-f]{40}$/.test(s))],
    ["liveRepo", entries.every((e) => e.repo.length > 0)],
    ["liveAuthor", entries.every((e) => e.author.length > 0)],
    ["liveTs", entries.every((e) => e.ts.length > 0)],
    ["liveReason", entries.every((e) => e.reason.length > 0)],
    ["liveIdentity", live.identities.length > 0 && live.identities.every((r) => r.name && r.email)],
  ]);
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed}/${total} attribution checks passed`);
process.exit(passed === total ? 0 : 1);
