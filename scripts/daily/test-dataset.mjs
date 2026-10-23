#!/usr/bin/env node
/**
 * scripts/daily/test-dataset.mjs
 * ------------------------------------------------------------------
 * 数据契约的确定性回归（零依赖，不触网、不需要 key）。
 *
 * 锁的是 scripts/lib/dataset.mjs 的两个常量：
 *   · HASH_EXCLUDED —— 抽取时必须**逐项等于**原来的排除名单。改它等于改全部历史日期的
 *     dataHash：会触发重采集、重调 AI、并改写已发布页面（计划 R3）。
 *   · DAY_FIELDS    —— 顶层字段全集的「⊆」方向：docs/data ∪ data/backfill 里出现的
 *     每个字段都必须在名单里；历史文件缺可选段不算问题。
 *
 * 最强的那条断言是「复算」：对每份**已发布**的 docs/data/<date>.json 重算
 * contentHash，必须等于文件里存的 dataHash —— 抽取前后哈希口径有任何变化，它立刻红。
 *
 * 用法：node scripts/daily/test-dataset.mjs
 * 输出：每个用例一行 PASS/FAIL，结尾 N/M；有失败时退出码 1。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "../lib/paths.mjs";
import { DAY_FIELDS, HASH_EXCLUDED } from "../lib/dataset.mjs";

const docsDataDir = path.join(ROOT, "docs", "data");
const backfillDir = path.join(ROOT, "data", "backfill");

const { contentHash } = await import(new URL("./lib/days.mjs", import.meta.url).href);

let passed = 0;
let total = 0;

/** 每个用例一行 PASS/FAIL；checks 是 [名字, 布尔] 数组。 */
function check(name, checks) {
  total += 1;
  const ok = checks.every(([, v]) => v);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  [${checks.map(([k, v]) => `${k}=${v}`).join(", ")}]`);
}

/** 读一个目录下全部 <YYYY-MM-DD>.json（新→旧）；目录缺失返回空。 */
function readDays(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort()
    .reverse()
    .map((n) => {
      try {
        return { name: n, data: JSON.parse(readFileSync(path.join(dir, n), "utf8")) };
      } catch {
        return { name: n, data: null };
      }
    });
}

// ---------------------------------------------------------------- 1 排除名单冻结

{
  const frozen = ["generatedAt", "ai", "aiProvider", "aiModel", "aiFailure", "dataHash"];
  check("HASH_EXCLUDED 冻结", [
    ["exactList", JSON.stringify([...HASH_EXCLUDED].sort()) === JSON.stringify([...frozen].sort())],
    ["noDuplicate", new Set(HASH_EXCLUDED).size === HASH_EXCLUDED.length],
    ["allInDayFields", HASH_EXCLUDED.every((k) => DAY_FIELDS.includes(k))],
  ]);
}

// ---------------------------------------------------------------- 2 哈希口径（含复算已发布数据）

{
  const base = {
    date: "2026-10-03",
    windowStart: "2026-10-03T00:00:00+08:00",
    windowEnd: "2026-10-03T23:59:59+08:00",
    username: "tester",
    generatedAt: "2026-10-04T00:00:00.000Z",
    empty: false,
    totals: { commits: 1, prs: 0, issues: 0, reviews: 0 },
    commits: [{ repo: "a/b", count: 1, own: true, automated: 0, messages: [{ message: "init" }] }],
    pullRequests: [],
    reviews: [],
    issues: [],
    releases: [],
    stars: [],
    starInventory: [],
    replies: [],
    stateChanges: [],
    dataHash: "stale",
  };
  // 同一份数据，只改「运行状态」字段 → 哈希必须不变
  const noisy = {
    ...base,
    generatedAt: "2026-10-24T12:34:56.789Z",
    ai: { en: { headline: "x", summary: "y", releaseNotes: [] }, zh: { headline: "x", summary: "y", releaseNotes: [] } },
    aiProvider: "nvidia-minimax-flash",
    aiModel: "minimaxai/minimax-m3.1-flash",
    aiFailure: { state: "failed", attempts: [{ provider: "p", model: "m", reason: "r" }] },
    dataHash: "another",
  };
  // 改一行数据内容 → 哈希必须变
  const changed = { ...base, totals: { ...base.totals, commits: 2 } };
  const published = readDays(docsDataDir);
  const recomputed = published.filter((d) => d.data && typeof d.data.dataHash === "string");
  const mismatched = recomputed.filter((d) => contentHash(d.data) !== d.data.dataHash);

  check("contentHash 口径", [
    ["ignoresRunState", contentHash(base) === contentHash(noisy)],
    ["changesWithData", contentHash(base) !== contentHash(changed)],
    ["hex64", /^[0-9a-f]{64}$/.test(contentHash(base))],
    ["publishedRecomputed", recomputed.length > 0],
    ["publishedMatch", mismatched.length === 0],
  ]);

  // 复算不一致时把文件名说清楚（上面的 check 只给 booleans，这里补一行）
  if (mismatched.length) {
    console.log(`  复算不一致（抽取前后哈希口径变了）: ${mismatched.map((d) => d.name).join(", ")}`);
  }
}

// ---------------------------------------------------------------- 3 DAY_FIELDS 覆盖真实数据

{
  const all = [...readDays(docsDataDir), ...readDays(backfillDir)].filter((d) => d.data);
  const unknown = new Map(); // 字段 → 首个出现的文件
  for (const d of all) {
    for (const key of Object.keys(d.data)) {
      if (!DAY_FIELDS.includes(key) && !unknown.has(key)) unknown.set(key, d.name);
    }
  }
  // 名单里的必备字段必须在每份文件里都存在（可选段不在此列，由 verify 各自判定）
  const required = ["date", "windowStart", "windowEnd", "username", "generatedAt", "empty", "totals", "dataHash"];
  const missingRequired = all.filter((d) => required.some((k) => !(k in d.data)));

  check("DAY_FIELDS 覆盖", [
    ["hasFiles", all.length > 0],
    ["noUnknownField", unknown.size === 0],
    ["requiredEverywhere", missingRequired.length === 0],
    ["noDuplicate", new Set(DAY_FIELDS).size === DAY_FIELDS.length],
  ]);
  for (const [k, file] of unknown) console.log(`  名单外字段 ${k}（首见于 ${file}）`);
  if (missingRequired.length) {
    console.log(`  必备字段缺失: ${missingRequired.slice(0, 5).map((d) => d.name).join(", ")}`);
  }
}

console.log(`\n${passed}/${total} cases passed`);
process.exit(passed === total ? 0 : 1);
