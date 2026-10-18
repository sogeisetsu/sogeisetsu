#!/usr/bin/env node
/**
 * scripts/summary/test-summary.mjs
 * ------------------------------------------------------------------
 * 30 天总结（collect / buildItemIndex / validateSummary / render / prompt / AI 闭环）
 * 的确定性回归测试：临时假数据目录 + 本地假 http 服务器，零依赖、不触网、不需要 API key。
 *
 * 覆盖：
 *   A 聚合 collectSummaryData —— totals/automatedCommits 逐日手算 Σ、窗口 30 天、
 *     missing 4 天集合、sources/backfilled/backfillLimits 与放置一致、
 *     同日两份以 daily 为准、dataHash 确定性（同数据相同 / 改动后不同）、
 *     aiPayload.repos 的每仓库确定数字与手算一致
 *   B buildItemIndex          —— repos 集合、repo#number 条目（kind/url）、repo@@tag releases
 *   C validateSummary         —— 合法接受（URL 逐条来自输入数据）、拒绝矩阵（含 overview
 *     的 markdown 拒收：列表 / 链接 / 代码块 / 斜体，### 小标题与 **bold** 放行）、
 *     超长 overview 按空行块截断 / headline / teaser 截断不拒收、byRepo 条数随真实仓库数放宽
 *   D 端到端                  —— 假 provider → generateStructured（含纠正重试 2 次）→
 *     renderSummaryPage / summaryCard 的数字、双语、headline、teaser（旧数据回退第一段）、
 *     两个板块标题的条数 pill、缺日标注、窗口前缀标题、### → h3.ai-h3、
 *     provider/model 旁注、AI 全失败的失败卡（reason 脱敏）
 *   E 临时目录清理
 *
 * 用法：node scripts/summary/test-summary.mjs
 * 输出：每个用例一行 PASS/FAIL，结尾 N/M；有失败退出码 1。
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { generateStructured } from "../daily/lib/ai.mjs";
import { dateRange } from "../daily/lib/days.mjs";
import { buildItemIndex, collectSummaryData } from "./collect.mjs";
import { SUMMARY_SYSTEM, buildSummaryPrompts, summaryFeedback } from "./prompt.mjs";
import { renderSummaryPage, summaryCard } from "./render.mjs";
import { validateSummary } from "./validate-summary.mjs";

// ---------------------------------------------------------------- 断言收集（照 test-render.mjs）

let passed = 0;
const cases = [];
const check = async (name, fn) => {
  cases.push(name); // 计入总数，保证抛异常的用例也拉低通过率
  let results;
  try {
    results = await fn();
  } catch (err) {
    console.log(`FAIL ${name}  [threw: ${err && err.message}]`);
    return;
  }
  const ok = results.every(([, v]) => v);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  [${results.map(([k, v]) => `${k}=${v}`).join(", ")}]`);
};

// ---------------------------------------------------------------- 假数据夹具

const START = "2026-01-01";
const END = "2026-01-30";
const REPO_A = "sogeisetsu/sogeisetsu";
const REPO_B = "openchamber/openchamber";
const PR42_URL = `https://github.com/${REPO_A}/pull/42`;
const ISSUE7_URL = `https://github.com/${REPO_A}/issues/7`;
const DISC4502_URL = `https://github.com/${REPO_B}/discussions/4502`;
const REL_URL = `https://github.com/${REPO_A}/releases/tag/v1.2.0`;
const BACKFILL_LIMITS = { stars: "unavailable", releases: "own-repos-only", issues: "search-approx" };

const MISSING = ["2026-01-27", "2026-01-28", "2026-01-29", "2026-01-30"]; // 4 天不写文件
const BACKFILL_ONLY = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"];
// 同日两份都有：2026-01-07 以 daily 为准，backfill 那份是刻意不同的假数据
const DUP_DATE = "2026-01-07";

/** 单日假数据：i = 窗口内第几天（1..30），结构与 docs/data 真实口径同构。 */
function makeDay(date, i, { source = "daily", hash } = {}) {
  const commits = [
    {
      repo: REPO_A,
      count: i % 3,
      own: true,
      automated: i % 2,
      automatedBots: ["github-actions[bot]"],
      messages: [{ message: `change ${i}` }],
    },
  ];
  if (i % 2 === 0) {
    commits.push({
      repo: REPO_B,
      count: (i % 4) + 1,
      own: false,
      automated: 0,
      automatedBots: [],
      messages: [{ message: `upstream ${i}` }],
    });
  }
  const pullRequests =
    i % 5 === 0
      ? [
          {
            repo: REPO_A,
            number: 100 + i,
            title: `pr ${i}`,
            url: `https://github.com/${REPO_A}/pull/${100 + i}`,
            action: "opened",
            ts: `${date}T03:00:00.000Z`,
            own: false,
          },
        ]
      : [];
  if (i === 10) {
    pullRequests.push({
      repo: REPO_A,
      number: 42,
      title: "feat: 30-day summary",
      url: PR42_URL,
      action: "merged",
      ts: `${date}T04:00:00.000Z`,
      own: true,
    });
  }
  const issues =
    i % 4 === 0
      ? [
          {
            repo: REPO_B,
            number: 200 + i,
            title: `issue ${i}`,
            url: `https://github.com/${REPO_B}/issues/${200 + i}`,
            action: "opened",
            ts: `${date}T05:00:00.000Z`,
            own: false,
          },
        ]
      : [];
  if (i === 12) {
    issues.push({
      repo: REPO_A,
      number: 7,
      title: "stale issue",
      url: ISSUE7_URL,
      action: "closed",
      ts: `${date}T06:00:00.000Z`,
      own: true,
    });
  }
  const reviews =
    i % 6 === 0
      ? [
          {
            repo: REPO_A,
            number: 300 + i,
            title: `review ${i}`,
            url: `https://github.com/${REPO_A}/pull/${300 + i}`,
            action: "reviewed",
            ts: `${date}T07:00:00.000Z`,
            own: true,
          },
        ]
      : [];
  const discussions =
    i % 7 === 0 && i !== 14
      ? [
          {
            repo: REPO_B,
            number: 400 + i,
            title: `discussion ${i}`,
            url: `https://github.com/${REPO_B}/discussions/${400 + i}`,
            category: "Ideas",
            action: "commented",
            ts: `${date}T08:00:00.000Z`,
            own: false,
          },
        ]
      : [];
  if (i === 14) {
    discussions.push({
      repo: REPO_B,
      number: 4502,
      title: "Store relay keys",
      url: DISC4502_URL,
      category: "Ideas",
      action: "started",
      ts: `${date}T09:00:00.000Z`,
      own: false,
    });
  }
  const releases =
    i === 16
      ? [
          {
            repo: REPO_A,
            tag: "v1.2.0",
            name: "v1.2.0",
            url: REL_URL,
            notes: "Bug fixes and small improvements.",
            publishedAt: `${date}T10:00:00.000Z`,
          },
        ]
      : [];
  const replies =
    i === 18
      ? [
          {
            repo: REPO_B,
            number: 4502,
            title: "Store relay keys",
            url: DISC4502_URL,
            author: "someone",
            excerpt: "nice idea",
            kind: "discussion_comment",
            ts: `${date}T11:00:00.000Z`,
            own: false,
          },
        ]
      : [];
  const stateChanges =
    i === 18
      ? [{ repo: REPO_A, number: 100 + i, action: "closed", actor: "someone", ts: `${date}T12:00:00.000Z` }]
      : [];

  const sumCommits = commits.reduce((s, c) => s + c.count, 0);
  const sumAuto = commits.reduce((s, c) => s + c.automated, 0);
  const day = {
    date,
    windowStart: `${date}T00:00:00+08:00`,
    windowEnd: `${date}T23:59:59+08:00`,
    username: "tester",
    totals: {
      commits: sumCommits,
      prs: pullRequests.length,
      issues: issues.length,
      reviews: reviews.length,
    },
    commits,
    automatedCommits: sumAuto,
    pullRequests,
    reviews,
    issues,
    discussions,
    releases,
    replies,
    stateChanges,
    empty: sumCommits + pullRequests.length + issues.length + reviews.length === 0,
    dataHash: hash || `hash-${date}`,
  };
  if (source === "search-backfill") {
    day.source = source;
    day.backfillLimits = { ...BACKFILL_LIMITS };
  }
  return day;
}

/** 建临时目录并写入假数据；返回 { tmpRoot, dailyDir, backfillDir, chosen }。 */
function buildFixture() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "summary-test-"));
  const dailyDir = path.join(tmpRoot, "daily");
  const backfillDir = path.join(tmpRoot, "backfill");
  fs.mkdirSync(dailyDir);
  fs.mkdirSync(backfillDir);

  const chosen = new Map(); // date → 实际会被聚合采用的数据（daily 优先）
  for (const d of dateRange(START, END)) {
    if (MISSING.includes(d)) continue;
    const i = Number(d.slice(8)); // 窗口是 1 月 1..30 日
    const isBackfill = BACKFILL_ONLY.includes(d);
    const data = makeDay(d, i, isBackfill ? { source: "search-backfill" } : {});
    const dir = isBackfill ? backfillDir : dailyDir;
    fs.writeFileSync(path.join(dir, `${d}.json`), JSON.stringify(data, null, 2));
    chosen.set(d, data);
  }

  // 同日两份：backfill 相里再放一份 2026-01-07，数字刻意不同（commits=99）
  const dup = makeDay(DUP_DATE, 7, { source: "search-backfill", hash: "hash-duplicate" });
  dup.commits = [{ repo: REPO_B, count: 99, own: false, automated: 0, automatedBots: [], messages: [] }];
  dup.totals = { commits: 99, prs: 0, issues: 0, reviews: 0 };
  dup.automatedCommits = 0;
  fs.writeFileSync(path.join(backfillDir, `${DUP_DATE}.json`), JSON.stringify(dup, null, 2));

  return { tmpRoot, dailyDir, backfillDir, chosen };
}

const { tmpRoot, dailyDir, backfillDir, chosen } = buildFixture();
const collectArgs = { start: START, end: END, dataDir: dailyDir, backfillDir };

// 手算期望值：只按 chosen（daily 优先）里的明细数组求和，不经过 totals 字段
const expTotals = { commits: 0, prs: 0, issues: 0, reviews: 0 };
let expAutomated = 0;
for (const [, data] of chosen) {
  expTotals.commits += data.commits.reduce((s, c) => s + (Number(c.count) || 0), 0);
  expTotals.prs += data.pullRequests.length;
  expTotals.issues += data.issues.length;
  expTotals.reviews += data.reviews.length;
  expAutomated += data.commits.reduce((s, c) => s + (Number(c.automated) || 0), 0);
}

// ---------------------------------------------------------------- A 聚合与确定性

const c1 = collectSummaryData(collectArgs);

await check("collect: totals/automated = 逐日手算 Σ", () => [
  ["commits", c1.totals.commits === expTotals.commits],
  ["prs", c1.totals.prs === expTotals.prs],
  ["issues", c1.totals.issues === expTotals.issues],
  ["reviews", c1.totals.reviews === expTotals.reviews],
  ["automated", c1.automatedCommits === expAutomated],
  ["got", JSON.stringify(c1.totals) + "/" + c1.automatedCommits],
]);

await check("collect: 窗口 30 天", () => [
  ["start", c1.windowStart === START],
  ["end", c1.windowEnd === END],
  ["days", c1.days === 30],
  ["dailyLen", c1.daily.length === 26],
]);

await check("collect: missing = 4 天且日期集合正确", () => [
  ["days", c1.missing.days === 4],
  ["dates", JSON.stringify([...c1.missing.dates].sort()) === JSON.stringify(MISSING)],
]);

await check("collect: sources/backfilled/backfillLimits 与放置一致", () => {
  const dailyExpected = dateRange(START, END).filter((d) => !MISSING.includes(d) && !BACKFILL_ONLY.includes(d));
  return [
    ["dailySources", dailyExpected.every((d) => c1.sources[d] === "daily")],
    ["backfillSources", BACKFILL_ONLY.every((d) => c1.sources[d] === "backfill")],
    ["sourceKeys", Object.keys(c1.sources).length === 26],
    ["backfilled", JSON.stringify([...c1.backfilled].sort()) === JSON.stringify(BACKFILL_ONLY)],
    ["limitsKeys", JSON.stringify(Object.keys(c1.backfillLimits).sort()) === JSON.stringify(BACKFILL_ONLY)],
    ["noDupLimits", c1.backfillLimits[DUP_DATE] === undefined],
  ];
});

await check("collect: 同日两份以 daily 为准", () => {
  const entry = c1.daily.find((e) => e.date === DUP_DATE);
  const entryCommits = entry ? entry.data.commits.reduce((s, c) => s + (Number(c.count) || 0), 0) : -1;
  return [
    ["dupFileExists", fs.existsSync(path.join(backfillDir, `${DUP_DATE}.json`))],
    ["sourceIsDaily", c1.sources[DUP_DATE] === "daily"],
    ["notBackfilled", !c1.backfilled.includes(DUP_DATE)],
    ["entrySource", Boolean(entry && entry.source === "daily")],
    ["commitsNot99", entryCommits !== 99 && entryCommits < 10],
  ];
});

const c2 = collectSummaryData(collectArgs);
const hashFile = path.join(dailyDir, "2026-01-08.json");
const origHashFileText = fs.readFileSync(hashFile, "utf8");
const mutated = JSON.parse(origHashFileText);
mutated.dataHash = "mutated-data-hash";
fs.writeFileSync(hashFile, JSON.stringify(mutated, null, 2));
const c3 = collectSummaryData(collectArgs);
fs.writeFileSync(hashFile, origHashFileText);
const c4 = collectSummaryData(collectArgs);

await check("collect: dataHash 确定性", () => [
  ["sameDataSameHash", c1.dataHash === c2.dataHash && c2.dataHash === c4.dataHash],
  ["mutatedDiffers", c3.dataHash !== c1.dataHash],
  ["hashNonEmpty", typeof c1.dataHash === "string" && c1.dataHash.length > 0],
]);

await check("collect: aiPayload.repos = 每仓库确定数字（代码统计）", () => {
  const want = new Map();
  const row = (repo) => {
    const name = String(repo || "").trim();
    if (!name) return null;
    if (!want.has(name)) {
      want.set(name, { commits: 0, automated: 0, prs: 0, issues: 0, reviews: 0, releases: 0 });
    }
    return want.get(name);
  };
  for (const [, data] of chosen) {
    for (const c of data.commits || []) {
      const r = row(c.repo);
      if (!r) continue;
      r.commits += Number(c.count) || 0;
      r.automated += Number(c.automated) || 0;
    }
    for (const [key, field] of [
      ["pullRequests", "prs"],
      ["issues", "issues"],
      ["reviews", "reviews"],
      ["releases", "releases"],
    ]) {
      for (const e of data[key] || []) {
        const r = row(e.repo);
        if (r) r[field] += 1;
      }
    }
  }
  const got = new Map(c1.aiPayload.repos.map((r) => [r.repo, r]));
  const fields = ["commits", "automated", "prs", "issues", "reviews", "releases"];
  const weights = c1.aiPayload.repos.map(
    (r) => r.commits + r.prs + r.issues + r.reviews + r.releases
  );
  const a = got.get(REPO_A);
  return [
    ["keys", got.size === want.size && [...want.keys()].every((k) => got.has(k))],
    [
      "values",
      [...want].every(([repo, w]) => {
        const g = got.get(repo) || {};
        return fields.every((f) => g[f] === w[f]);
      }),
    ],
    ["sortedByActivity", weights.every((w, i) => i === 0 || weights[i - 1] >= w)],
    ["repoA", Boolean(a && a.repo === REPO_A)],
    ["numbersInts", [...got.values()].every((r) => fields.every((f) => Number.isInteger(r[f])))],
  ];
});

// ---------------------------------------------------------------- B buildItemIndex

const ctx = { ...buildItemIndex(c1.daily), missing: c1.missing };

await check("buildItemIndex: repos 集合", () => {
  const want = new Set();
  for (const { data } of c1.daily) {
    for (const key of ["commits", "pullRequests", "reviews", "issues", "discussions", "releases", "replies", "stateChanges"]) {
      for (const e of data[key] || []) if (e && e.repo) want.add(e.repo);
    }
  }
  return [
    ["size", ctx.repos.size === want.size],
    ["hasA", ctx.repos.has(REPO_A)],
    ["hasB", ctx.repos.has(REPO_B)],
    ["noExtra", [...want].every((r) => ctx.repos.has(r))],
  ];
});

await check("buildItemIndex: repo#number 条目（kind/url）", () => {
  const want = new Map();
  for (const { data } of c1.daily) {
    for (const [list, kind] of [
      [data.pullRequests, "pr"],
      [data.issues, "issue"],
      [data.discussions, "discussion"],
    ]) {
      for (const e of list || []) want.set(`${e.repo}#${e.number}`, kind);
    }
  }
  const pr = ctx.items.get(`${REPO_A}#42`);
  const issue = ctx.items.get(`${REPO_A}#7`);
  const disc = ctx.items.get(`${REPO_B}#4502`);
  return [
    ["size", ctx.items.size === want.size],
    ["kinds", [...want].every(([k, kind]) => (ctx.items.get(k) || {}).kind === kind)],
    ["pr42", Boolean(pr && pr.kind === "pr" && pr.url === PR42_URL)],
    ["issue7", Boolean(issue && issue.kind === "issue" && issue.url === ISSUE7_URL)],
    ["disc4502", Boolean(disc && disc.kind === "discussion" && disc.url === DISC4502_URL)],
  ];
});

await check("buildItemIndex: repo@@tag releases", () => {
  const want = new Set();
  for (const { data } of c1.daily) for (const r of data.releases || []) want.add(`${r.repo}@@${r.tag}`);
  const rel = ctx.releases.get(`${REPO_A}@@v1.2.0`);
  return [
    ["size", ctx.releases.size === want.size],
    ["entry", Boolean(rel && rel.repo === REPO_A && rel.tag === "v1.2.0" && rel.url === REL_URL)],
  ];
});

// ---------------------------------------------------------------- C validateSummary 矩阵

const EN_OVERVIEW = [
  "Shipped steadily across two repositories during the window. The work mixed features, fixes and maintenance. Review activity stayed consistent. Release v1.2.0 went out on schedule. 4 days of the window have no data and are excluded. The overall pace was even.",
  "Most commits landed in the primary repository. Secondary work focused on upstream fixes. No unusual incidents were recorded. The summary stays factual and concise.",
].join("\n\n");
const ZH_OVERVIEW = [
  "本窗口的推进节奏平稳，主要集中在两个仓库。工作内容混合了功能、修复与维护。评审活动保持稳定。v1.2.0 版本按计划发布。窗口内有 4 天缺少数据，已从统计中排除。整体节奏没有异常。",
  "多数提交落在主仓库。次要工作以上游修复为主。记录中没有意外事件。本摘要只陈述事实。",
].join("\n\n");
// 「未写缺几天」反例用：去掉唯一的「4」（其余文本不含数字 4）
const EN_OVERVIEW_NO4 = EN_OVERVIEW.replace("4 days of the window", "Several days of the window");
const ZH_OVERVIEW_NO4 = ZH_OVERVIEW.replace("4 天缺少数据", "若干天缺少数据");

const HIGHLIGHTS_EN = [
  { repo: REPO_A, number: 42, kind: "pr", text: "Merged the 30-day summary feature." },
  { repo: REPO_A, number: 7, kind: "issue", text: "Closed a long-running issue." },
  { repo: REPO_B, number: 4502, kind: "discussion", text: "Opened a discussion thread." },
  { repo: REPO_A, kind: "release", tag: "v1.2.0", text: "Published v1.2.0." },
];
const HIGHLIGHTS_ZH = [
  { repo: REPO_A, number: 42, kind: "pr", text: "合并了 30 天总结功能。" },
  { repo: REPO_A, number: 7, kind: "issue", text: "关闭了一个积压 issue。" },
  { repo: REPO_B, number: 4502, kind: "discussion", text: "发起了一条讨论。" },
  { repo: REPO_A, kind: "release", tag: "v1.2.0", text: "发布了 v1.2.0。" },
];
const BY_EN = [
  { repo: REPO_A, text: "Primary repository: steady commits, one release and an issue closed." },
  { repo: REPO_B, text: "Upstream work: fixes, a discussion thread and replies." },
];
const BY_ZH = [
  { repo: REPO_A, text: "主仓库：提交稳定，发布了一个版本并关闭了一个 issue。" },
  { repo: REPO_B, text: "上游工作：修复、一条讨论与若干回复。" },
];
const TEASER_EN = "Two repositories moved forward: features, fixes and maintenance landed steadily, and v1.2.0 shipped on schedule.";
const TEASER_ZH = "两个仓库稳步推进：功能、修复与维护按节奏落地，v1.2.0 也已发布。";

/** 每次返回全新副本，避免用例间互相污染共享夹具。 */
const baseRaw = () => ({
  en: {
    headline: "Steady shipping across two repositories",
    teaser: TEASER_EN,
    overview: EN_OVERVIEW,
    highlights: HIGHLIGHTS_EN.map((h) => ({ ...h })),
    byRepo: BY_EN.map((b) => ({ ...b })),
  },
  zh: {
    headline: "两个仓库稳步推进",
    teaser: TEASER_ZH,
    overview: ZH_OVERVIEW,
    highlights: HIGHLIGHTS_ZH.map((h) => ({ ...h })),
    byRepo: BY_ZH.map((b) => ({ ...b })),
  },
});

await check("validate: 合法输出接受 + URL 逐条来自输入数据", () => {
  const res = validateSummary(baseRaw(), ctx);
  if (!res.ok) return [["ok", false], ["reason", res.reason || ""]];
  const urlsEn = res.value.en.highlights.map((h) => h.url);
  const urlsZh = res.value.zh.highlights.map((h) => h.url);
  return [
    ["ok", res.ok === true],
    ["enCount", res.value.en.highlights.length === 4],
    ["zhCount", res.value.zh.highlights.length === 4],
    ["prUrl", urlsEn[0] === PR42_URL],
    ["issueUrl", urlsEn[1] === ISSUE7_URL],
    ["discUrl", urlsEn[2] === DISC4502_URL],
    ["relUrl", urlsEn[3] === REL_URL],
    ["zhSameUrls", JSON.stringify(urlsZh) === JSON.stringify(urlsEn)],
    ["teaserEn", res.value.en.teaser === TEASER_EN],
    ["teaserZh", res.value.zh.teaser === TEASER_ZH],
    ["missingMention", res.value.en.overview.includes("4") || res.value.zh.overview.includes("4")],
  ];
});

const reject = (name, keyword, mutate) =>
  check(name, () => {
    const raw = baseRaw();
    mutate(raw);
    const res = validateSummary(raw, ctx);
    return [
      ["okFalse", res.ok === false],
      ["kw", String(res.reason || "").includes(keyword)],
    ];
  });

await reject("validate: 拒绝-不存在的 repo", "输入之外", (raw) => {
  raw.en.highlights[0].repo = "ghost/repo";
});
await reject("validate: 拒绝-不存在的编号", "输入之外", (raw) => {
  raw.en.highlights[1].number = 999999;
});
await reject("validate: 拒绝-缺 zh", "缺少 zh", (raw) => {
  delete raw.zh;
});
await reject("validate: 拒绝-teaser 为空", "teaser", (raw) => {
  delete raw.en.teaser;
});
await reject("validate: 拒绝-overview 仅 1 句", "句数", (raw) => {
  raw.en.overview = "Only one sentence here.";
});
await reject("validate: 拒绝-overview 单段不分段", "段数", (raw) => {
  raw.en.overview = "One. Two. Three. Four. Five. Six. Seven.";
});
await reject("validate: 拒绝-headline 含反引号", "反引号", (raw) => {
  raw.en.headline = "Summary `done`";
});
await reject("validate: 拒绝-overview 提评论数", "评论数", (raw) => {
  raw.en.overview = EN_OVERVIEW.replace(
    "The overall pace was even.",
    "The overall pace was even. It had 3 comments."
  );
});
await reject("validate: 拒绝-highlights 仅 2 条", "至少 3 条", (raw) => {
  raw.en.highlights = raw.en.highlights.slice(0, 2);
});
await reject("validate: 拒绝-kind 非法", "kind 非法", (raw) => {
  raw.en.highlights[0].kind = "commit";
});
await reject("validate: 拒绝-未写缺几天", "缺几天", (raw) => {
  raw.en.overview = EN_OVERVIEW_NO4;
  raw.zh.overview = ZH_OVERVIEW_NO4;
});

// --- 章节式 overview：### 小标题放行；其余 markdown（列表/链接/代码块/斜体）拒收
await check("validate: overview 接受行首 ### 小标题（段数不计、内容原样保留）", () => {
  const raw = baseRaw();
  raw.en.overview = `### Window overview\n\n${EN_OVERVIEW}`;
  raw.zh.overview = `### 窗口总览\n\n${ZH_OVERVIEW}`;
  const res = validateSummary(raw, ctx);
  return [
    ["ok", res.ok === true],
    ["keptHeadingEn", Boolean(res.ok && res.value.en.overview.startsWith("### Window overview"))],
    ["keptHeadingZh", Boolean(res.ok && res.value.zh.overview.startsWith("### 窗口总览"))],
  ];
});

await reject("validate: 拒绝-overview 项目符号列表", "markdown", (raw) => {
  raw.en.overview = `${EN_OVERVIEW}\n- one more bullet line`;
});
await reject("validate: 拒绝-overview markdown 链接", "markdown", (raw) => {
  raw.en.overview = EN_OVERVIEW.replace(
    "The overall pace was even.",
    "The overall pace was even. See [the repo](https://example.com/x)."
  );
});
await reject("validate: 拒绝-overview 代码块", "markdown", (raw) => {
  raw.en.overview = `${EN_OVERVIEW}\n\n\`\`\`\nconst x = 1;\n\`\`\``;
});
await reject("validate: 拒绝-overview 斜体（**bold** 不误伤）", "markdown", (raw) => {
  raw.en.overview = EN_OVERVIEW.replace(
    "The overall pace was even.",
    "The overall pace was even. The pace was *quite steady*."
  );
});

// **bold** / 行内 code 是被放行的内联子集（aiInlineToHtml 只渲染这两种）
await check("validate: overview 接受 **bold** 与行内 code（斜体规则不误伤）", () => {
  const raw = baseRaw();
  raw.en.overview = EN_OVERVIEW.replace(
    "The overall pace was even.",
    "The overall pace was even. The pace was **steady** throughout `sogeisetsu/sogeisetsu`."
  );
  const res = validateSummary(raw, ctx);
  return [["ok", res.ok === true], ["keptBold", Boolean(res.ok && res.value.en.overview.includes("**steady**"))]];
});

await check("validate: overview 超 4200 按空行块截断不拒收", () => {
  const raw = baseRaw();
  const filler =
    "Detailed maintenance work continued across repositories with careful review and steady follow-up. ".repeat(60);
  raw.en.overview = `${EN_OVERVIEW}\n\n${filler}`;
  const res = validateSummary(raw, ctx);
  return [
    ["ok", res.ok === true],
    ["lenEn", Boolean(res.ok && res.value.en.overview.length <= 4200)],
    ["lenZh", Boolean(res.ok && res.value.zh.overview.length <= 4200)],
    ["truncated", Boolean(res.ok && res.value.en.overview.length < raw.en.overview.length)],
    ["stillMentionsMissing", Boolean(res.ok && res.value.en.overview.includes("4"))],
  ];
});

await check("validate: headline 超 80 截断不拒收", () => {
  const raw = baseRaw();
  raw.en.headline =
    "A fairly long headline describing the thirty day activity window in detail ".repeat(3);
  const res = validateSummary(raw, ctx);
  return [
    ["ok", res.ok === true],
    ["lenEn", Boolean(res.ok && res.value.en.headline.length <= 80)],
    ["lenZh", Boolean(res.ok && res.value.zh.headline.length <= 80)],
  ];
});

await check("validate: teaser 超 240 截断不拒收", () => {
  const raw = baseRaw();
  raw.en.teaser = "Home page teaser. ".repeat(40);
  raw.zh.teaser = "首页短文案。".repeat(80);
  const res = validateSummary(raw, ctx);
  return [
    ["ok", res.ok === true],
    ["lenEn", Boolean(res.ok && res.value.en.teaser.length <= 240)],
    ["lenZh", Boolean(res.ok && res.value.zh.teaser.length <= 240)],
    ["nonEmpty", Boolean(res.ok && res.value.en.teaser && res.value.zh.teaser)],
  ];
});

await check("validate: byRepo 按真实仓库数放宽（不再固定 8 条砍掉仓库）", () => {
  // ctx 里本来就有的两个仓库必须保留（highlights 引用它们），再补 10 个凑到 12 条
  const repos12 = new Set([
    ...ctx.repos,
    ...Array.from({ length: 12 - ctx.repos.size }, (_, i) => `owner/repo-${i}`),
  ]);
  const raw = baseRaw();
  const mk = (repo) => ({ repo, text: `Concrete work landed in ${repo} during the window.` });
  const list = [...repos12];
  raw.en.byRepo = list.map(mk);
  raw.zh.byRepo = list.map(mk);
  const res = validateSummary(raw, { ...ctx, repos: repos12 });
  return [
    ["ok", res.ok === true],
    ["repos12", list.length === 12],
    ["kept12", Boolean(res.ok && res.value.en.byRepo.length === 12)],
    ["zh12", Boolean(res.ok && res.value.zh.byRepo.length === 12)],
  ];
});

await check("prompt: summaryFeedback 按原因给章节式纠正提示（3-6 段 / 4200 / markdown）", () => {
  const seg = summaryFeedback("en.overview 段数不足（当前 1 段）", 0);
  const sent = summaryFeedback("en.overview 句数不足（4 < 6）", 0);
  const md = summaryFeedback("en.overview 含未允许的 markdown（列表）", 0);
  return [
    ["segParas3to6", /3-6 paragraphs/.test(seg)],
    ["segChars4200", seg.includes("4200")],
    ["sentChars4200", sent.includes("10-16 sentences") && sent.includes("4200")],
    ["mdOnlySubset", md.includes("### ") && md.includes("markdown")],
  ];
});

// ---------------------------------------------------------------- D 端到端（假 provider）

let queue = [];
const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* 非 JSON 请求体 */
    }
    requests.push({ url: req.url, body: parsed });
    const next = queue.shift();
    if (!next) {
      res.writeHead(500);
      res.end("exhausted");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(next.body));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const provider = {
  name: "mock",
  baseUrl: `http://127.0.0.1:${PORT}/v1`,
  apiKey: "test-key",
  model: "mock-model",
  shape: "chat",
};
const chatResp = (content) => ({
  body: {
    choices: [{ message: { content, reasoning: "" }, finish_reason: "stop" }],
    usage: { total_tokens: 10 },
  },
});

const { user } = buildSummaryPrompts({ collected: c1 });
const origErr = console.error;
console.error = () => {}; // 屏蔽 ai.mjs 的调试日志

requests.length = 0;
queue = [chatResp(JSON.stringify(baseRaw()))];
const e2e = await generateStructured({
  system: SUMMARY_SYSTEM,
  user,
  validate: (p) => validateSummary(p, ctx),
  providers: [provider],
  feedback: summaryFeedback,
});

let e2eSummary = null;
await check("e2e: 合法 JSON 一次通过", () => [
  ["gotValue", Boolean(e2e && e2e.value)],
  ["calls", requests.length === 1],
  ["provider", Boolean(e2e && e2e.provider === "mock")],
  ["headline", Boolean(e2e && e2e.value.en.headline === baseRaw().en.headline)],
  ["urlInjected", Boolean(e2e && e2e.value.en.highlights[0].url === PR42_URL)],
]);

if (e2e) {
  e2eSummary = {
    windowStart: c1.windowStart,
    windowEnd: c1.windowEnd,
    days: c1.days,
    username: "tester",
    generatedAt: "2026-01-31T12:00:00.000Z",
    missing: c1.missing,
    totals: c1.totals,
    automatedCommits: c1.automatedCommits,
    sources: c1.sources,
    backfilled: c1.backfilled,
    backfillLimits: c1.backfillLimits,
    dataHash: c1.dataHash,
    ai: e2e.value,
    aiProvider: e2e.provider,
  };
}

await check("e2e: renderSummaryPage 数字/双语/headline/缺日", () => {
  if (!e2eSummary) return [["summaryReady", false]];
  const html = renderSummaryPage({ summary: e2eSummary });
  const nums = [...html.matchAll(/<div class="stat-num">([^<]*)<\/div>/g)].map((m) => m[1]);
  const want = ["commits", "prs", "issues", "reviews"].map((k) => String(e2eSummary.totals[k]));
  const notices = [...html.matchAll(/<p class="trunc-notice">([\s\S]*?)<\/p>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, ""))
    .filter((t) => /Data missing for|缺数据/.test(t));
  const hEn = e2eSummary.ai.en.headline;
  const hZh = e2eSummary.ai.zh.headline;
  return [
    ["langEn", html.includes('data-lang="en"')],
    ["langZh", html.includes('data-lang="zh"')],
    ["statNums", nums.length === 4 && want.every((n, i) => nums[i] === n)],
    ["headEn", html.includes(hEn)],
    ["headZh", html.includes(hZh)],
    ["missingNotice", notices.some((t) => t.includes("4") && c1.missing.dates.some((d) => t.includes(d)))],
    ["aiBlocks", html.includes('<div class="ai-summary i18n" data-lang="en">') && html.includes('<div class="ai-summary i18n" data-lang="zh">')],
  ];
});

await check("e2e: Highlights / By repository 标题都带条数 pill", () => {
  if (!e2eSummary) return [["summaryReady", false]];
  const html = renderSummaryPage({ summary: e2eSummary });
  const pills = [...html.matchAll(/<span class="pill">([^<]*)<\/span>/g)].map((m) => m[1]);
  return [
    ["twoPills", pills.length === 2],
    ["highlightsPill", pills[0] === String(e2eSummary.ai.en.highlights.length)],
    ["byRepoPill", pills[1] === String(e2eSummary.ai.en.byRepo.length)],
  ];
});

await check("e2e: summaryCard 按钮/headline，null 时返回空串", () => {
  if (!e2eSummary) return [["summaryReady", false]];
  const card = summaryCard({ summary: e2eSummary });
  let nullSig = "threw";
  try {
    nullSig = summaryCard(null);
  } catch {
    nullSig = "threw"; // render.mjs 的解构签名（{ summary } = {}）对 null 抛 TypeError
  }
  return [
    ["hasButton", card.includes('href="./summary.html"')],
    ["hasHeadEn", card.includes(e2eSummary.ai.en.headline)],
    ["hasHeadZh", card.includes(e2eSummary.ai.zh.headline)],
    ["noArgEmpty", summaryCard() === ""],
    ["objNullEmpty", summaryCard({ summary: null }) === ""],
    ["nullSigEmptyOrThrows", nullSig === "" || nullSig === "threw"],
  ];
});

await check("e2e: 卡片只放 teaser（不带 overview 全文），旧数据回退第一段截断", () => {
  if (!e2eSummary) return [["summaryReady", false]];
  const fullEn = e2eSummary.ai.en.overview;
  const fullZh = e2eSummary.ai.zh.overview;
  const card = summaryCard({ summary: e2eSummary });

  // 旧 docs/summary.json：AI 输出里还没有 teaser 字段 → 回退 overview 第一段
  const legacy = JSON.parse(JSON.stringify(e2eSummary));
  delete legacy.ai.en.teaser;
  delete legacy.ai.zh.teaser;
  const legacyCard = summaryCard({ summary: legacy });
  const legacyFirstEn = fullEn.split(/\n\s*\n/)[0];
  const legacyFirstZh = fullZh.split(/\n\s*\n/)[0];
  // 卡片正文由 splitParagraphs 按句切段（含回退文案），取回纯文本比长度
  const legacyEnBlock = /<div class="ai-summary i18n" data-lang="en">([\s\S]*?)<\/div>/.exec(
    legacyCard
  );
  const legacyEnText = legacyEnBlock ? legacyEnBlock[1].replace(/<\/?p>/g, "").trim() : "";

  return [
    ["cardHasTeaserEn", card.includes(e2eSummary.ai.en.teaser)],
    ["cardHasTeaserZh", card.includes(e2eSummary.ai.zh.teaser)],
    ["cardWithoutFullOverview", !card.includes(fullEn) && !card.includes(fullZh)],
    ["cardStillHasNums", card.includes(`${e2eSummary.totals.commits} commits`)],
    [
      "legacyFallsBackToFirstPara",
      legacyCard.includes(legacyFirstEn.slice(0, 40)) &&
        legacyCard.includes(legacyFirstZh.slice(0, 12)),
    ],
    [
      "legacyTruncatedTo240",
      legacyFirstEn.length <= 240 ||
        (legacyEnText.length <= 241 && legacyEnText.endsWith("…")),
    ],
  ];
});

// --- 新增回归：窗口前缀标题 / 章节式 h3 / provider 旁注 / 失败卡（均为代码字段，非 AI 文本）

await check("render: 标题带窗口前缀（页面 h1 + 卡片 h2，代码拼装非 AI 文本）", () => {
  if (!e2eSummary) return [["summaryReady", false]];
  const html = renderSummaryPage({ summary: e2eSummary });
  const card = summaryCard({ summary: e2eSummary });
  const needle = `${c1.windowStart} – ${c1.windowEnd}`; // U+2013 连接两端日期
  return [
    ["pageHasNeedle", html.includes(needle)],
    ["cardHasNeedle", card.includes(needle)],
    ["pageH1", html.includes(`<h1><span class="mono">${needle}</span> · `)],
    ["cardH2", card.includes(`<h2 class="ai-headline"><span class="mono">${needle}</span> · `)],
    ["pageH1NotTilde", !html.includes(`<h1><span class="mono">${c1.windowStart} ~ `)],
  ];
});

await check("render: overview 的 ### 小标题渲染成 h3.ai-h3（双语结构保留）", () => {
  if (!e2eSummary) return [["summaryReady", false]];
  const s = JSON.parse(JSON.stringify(e2eSummary));
  s.ai.en.overview = `### What shipped\n\n${s.ai.en.overview}`;
  s.ai.zh.overview = `### 本期进展\n\n${s.ai.zh.overview}`;
  const html = renderSummaryPage({ summary: s });
  return [
    ["h3En", html.includes('<h3 class="ai-h3">What shipped</h3>')],
    ["h3Zh", html.includes('<h3 class="ai-h3">本期进展</h3>')],
    ["langBlocks", html.includes('<div class="ai-summary i18n" data-lang="en">') && html.includes('<div class="ai-summary i18n" data-lang="zh">')],
    ["h3Css", html.includes('.ai-h3{margin:14px 0 6px')],
  ];
});

await check("render: provider/model 旁注（卡片与页面都有；仅 provider 时无 / model 后缀）", () => {
  if (!e2eSummary) return [["summaryReady", false]];
  const both = { ...e2eSummary, aiProvider: "sensenova", aiModel: "glm-5.2" };
  const html = renderSummaryPage({ summary: both });
  const card = summaryCard({ summary: both });
  const only = { ...e2eSummary, aiProvider: "sensenova", aiModel: "" };
  const cardOnly = summaryCard({ summary: only });
  const noProvider = { ...e2eSummary, aiProvider: "", aiModel: "glm-5.2" };
  const cardNone = summaryCard({ summary: noProvider });
  return [
    ["cardBoth", card.includes("via sensenova / glm-5.2") && card.includes("由 sensenova / glm-5.2 生成")],
    ["pageBoth", html.includes("via sensenova / glm-5.2") && html.includes("由 sensenova / glm-5.2 生成")],
    ["pageHasClass", html.includes('class="ai-provider"') && card.includes('class="ai-provider"')],
    ["onlyProvider", cardOnly.includes("via sensenova") && !cardOnly.includes(" / ")],
    ["noProviderNothing", !cardNone.includes('class="ai-provider"')],
  ];
});

await check("render: AI 全失败时失败卡（卡片 + 页面）+ reason 脱敏", () => {
  if (!e2eSummary) return [["summaryReady", false]];
  const s = {
    ...e2eSummary,
    ai: null,
    aiProvider: "sensenova",
    aiModel: "glm-5.2",
    aiFailure: {
      attempts: [
        { provider: "sensenova", model: "glm-5.2", reason: "HTTP 401: Bearer sk-abcdef123456 rejected" },
      ],
      issue: { number: 9, url: `https://github.com/${REPO_A}/issues/9` },
    },
  };
  const html = renderSummaryPage({ summary: s });
  const card = summaryCard({ summary: s });
  const leak = "Bearer sk-abcdef123456";
  return [
    ["cardBlock", card.includes('class="ai-failure"')],
    ["pageBlock", html.includes('class="ai-failure"')],
    ["cardLine", card.includes('class="ai-failure-line"') && card.includes("sensenova / glm-5.2")],
    ["cardReason", card.includes("HTTP 401")],
    ["pageReason", html.includes("HTTP 401")],
    ["cardLink", card.includes(`href="https://github.com/${REPO_A}/issues/9"`) && card.includes("#9")],
    ["pageLink", html.includes(`href="https://github.com/${REPO_A}/issues/9"`) && html.includes("#9")],
    ["noLeakCard", !card.includes(leak)],
    ["noLeakPage", !html.includes(leak)],
    ["cardUnavailable", card.includes("ai-unavailable")],
    ["pageUnavailable", html.includes("ai-unavailable")],
  ];
});

await check("render: ai 缺失且无失败明细时卡片仍返回空串（维持原行为）", () => [
  ["emptyCard", summaryCard({ summary: { windowStart: START, windowEnd: END, totals: { commits: 1 } } }) === ""],
]);

await check("render: notifier 没跑成（有 aiFailure 但没 issue）→ 退化成「未取到 issue 链接」", () => {
  if (!e2eSummary) return [["summaryReady", false]];
  const s = {
    ...e2eSummary,
    ai: null,
    aiFailure: { attempts: [{ provider: "sensenova", model: "glm-5.2", reason: "HTTP 503" }], issue: null },
  };
  const html = renderSummaryPage({ summary: s });
  const card = summaryCard({ summary: s });
  const noAttempts = renderSummaryPage({
    summary: { ...s, aiFailure: { attempts: [], issue: null } },
  });
  return [
    ["pageNote", html.includes("失败详情：未取到 issue 链接")],
    ["cardNote", card.includes("失败详情：未取到 issue 链接")],
    ["pageNoLink", !/<a class="link"[^>]*href="https:\/\//.test(html.slice(html.indexOf('class="ai-failure"'), html.indexOf('class="ai-failure"') + 800))],
    ["pageStillShowsReason", html.includes("HTTP 503")],
    ["emptyAttemptsStillShows", noAttempts.includes('<div class="ai-failure">') && noAttempts.includes("失败详情：未取到 issue 链接")],
  ];
});

// 纠正重试：第一份引用不存在的 repo → summaryFeedback 生成纠正提示 → 第二份合法
requests.length = 0;
const invalid = baseRaw();
invalid.en.highlights[0].repo = "ghost/repo";
queue = [chatResp(JSON.stringify(invalid)), chatResp(JSON.stringify(baseRaw()))];
const retry = await generateStructured({
  system: SUMMARY_SYSTEM,
  user,
  validate: (p) => validateSummary(p, ctx),
  providers: [provider],
  feedback: summaryFeedback,
});

console.error = origErr;

await check("e2e: 非法 JSON 纠正重试后成功（2 次调用）", () => {
  const secondUser = requests[1] && requests[1].body && requests[1].body.messages
    ? String(requests[1].body.messages[1].content || "")
    : "";
  return [
    ["gotValue", Boolean(retry && retry.value)],
    ["calls", requests.length === 2],
    ["feedbackSent", secondUser.includes("REJECTED")],
  ];
});

// ---------------------------------------------------------------- E 清理

server.close();
await check("cleanup: 临时目录已删除", () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return [["removed", !fs.existsSync(tmpRoot)]];
});

// ---------------------------------------------------------------- 汇总

console.log(`\n${passed}/${cases.length} cases passed`);
process.exit(passed === cases.length ? 0 : 1);
