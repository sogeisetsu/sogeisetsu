#!/usr/bin/env node
/**
 * scripts/test-activity-window.mjs
 * ------------------------------------------------------------------
 * 活动卡片线（scripts/generate-activity.mjs）纯函数的确定性回归（零依赖，不触网、不需要 key）。
 *
 * 覆盖：
 *   · computeWindow        — 窗口是 +08 自然日、含今天（UTC 日 ≠ 北京日时取北京今天）
 *   · buildData 事件分桶   — 事件按 +08 自然日归档，含 16:00Z 这个换日边界
 *   · buildData 可见性     — 非公开仓库整体剔除（totals / splits / reposOwn / reposOther / details）
 *   · totals 恒等式        — totals 恒等于公开明细求和（= splits 之和），标量只用于对账
 *   · decideEventPage      — 翻页只认 Link 头（满页不等于还有下一页）、422 不是致命错误、
 *                            后续页不可用降级停、第 1 页失败仍 fail、窗口边界正常停
 *   · truncatedFrom        — 截断起点用 +08 日期；stoppedByLimit 也要进 truncated；
 *                            窗口外的远古事件不得污染"最早事件"
 *   · isPublicRepoRef      — 拿不准一律按不公开
 *
 * 用法：node scripts/test-activity-window.mjs
 * 输出：每个用例一行 PASS/FAIL；结尾 N/M；有失败退出码 1。
 */

// 归属判定依赖 GITHUB_REPOSITORY_OWNER，固定成默认 owner 再 import，保证回归不受本地环境影响。
process.env.GITHUB_REPOSITORY_OWNER = "sogeisetsu";
delete process.env.GITHUB_TOKEN; // 纯函数用例不该碰网络

const { buildData, computeWindow, decideEventPage, isPublicRepoRef } = await import(
  new URL("./generate-activity.mjs", import.meta.url).href
);

// ---------------------------------------------------------------- 断言收集

let passed = 0;
const cases = [];

const check = (name, fn) => {
  cases.push(name); // 计入总数，保证抛异常的用例也拉低通过率
  let results;
  try {
    results = fn();
  } catch (err) {
    console.log(`FAIL ${name}  [threw: ${err && err.message}]`);
    return;
  }
  const ok = results.every(([, v]) => v);
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}  [${results.map(([k, v]) => `${k}=${v}`).join(", ")}]`
  );
};

// ---------------------------------------------------------------- 造数工具

const pub = (name) => ({
  nameWithOwner: name,
  isPrivate: false,
  visibility: "PUBLIC", // GraphQL 枚举是大写
  owner: { login: name.split("/")[0] },
});
const priv = (name) => ({
  nameWithOwner: name,
  isPrivate: true,
  visibility: "PRIVATE",
  owner: { login: name.split("/")[0] },
});
const ISO = "2026-09-10T00:00:00Z";
const emptyCollection = () => ({
  totalCommitContributions: 0,
  totalIssueContributions: 0,
  totalPullRequestContributions: 0,
  totalPullRequestReviewContributions: 0,
  commitContributionsByRepository: [],
  issueContributions: { nodes: [] },
  pullRequestContributions: { nodes: [] },
  pullRequestReviewContributions: { nodes: [] },
});
const push = (ts, repo = "sogeisetsu/x", size = 1) => ({
  type: "PushEvent",
  created_at: ts,
  repo: { name: repo },
  payload: { size },
});

// ---------------------------------------------------------------- computeWindow

check("computeWindow: 末日取北京今天（UTC 09-17T20:00Z = 北京 09-18）", () => {
  const w = computeWindow(Date.parse("2026-09-17T20:00:00Z"));
  return [
    ["endISO", w.endISO === "2026-09-18"],
    ["startISO", w.startISO === "2026-08-20"],
    ["days30", w.dates.length === 30],
    ["ascending", w.dates[0] === w.startISO && w.dates[29] === w.endISO],
    ["startMsIsCstMidnight", w.startMs === Date.parse("2026-08-20T00:00:00+08:00")],
    ["endMsIsNextCstMidnight", w.endMs === Date.parse("2026-09-19T00:00:00+08:00")],
  ];
});

check("computeWindow: 同一个 UTC 日、不同北京日 → 末日不同", () => {
  const a = computeWindow(Date.parse("2026-09-17T02:00:00Z")); // 北京 09-17 10:00
  const b = computeWindow(Date.parse("2026-09-17T20:00:00Z")); // 北京 09-18 04:00
  return [
    ["earlyEnd", a.endISO === "2026-09-17"],
    ["lateEnd", b.endISO === "2026-09-18"],
    ["windowShifts", a.startISO === "2026-08-19" && b.startISO === "2026-08-20"],
  ];
});

// ---------------------------------------------------------------- 事件分桶

check("buildData: 事件按 +08 自然日分桶（16:00Z 是换日边界）", () => {
  const w = computeWindow(Date.parse("2026-09-17T20:00:00Z")); // 窗口末日 09-18
  const events = [
    push("2026-09-17T15:59:59Z"), // 北京 09-17 23:59:59
    push("2026-09-17T16:00:00Z"), // 北京 09-18 00:00:00 ← 边界
    push("2026-09-18T02:00:00Z"), // 北京 09-18 10:00
    push("2026-09-18T16:00:00Z"), // 北京 09-19 → 出窗
  ];
  const { data } = buildData(emptyCollection(), events, w);
  const byDate = new Map(data.daily.map((d) => [d.date, d]));
  return [
    ["d0917", byDate.get("2026-09-17")?.own === 1],
    ["d0918", byDate.get("2026-09-18")?.own === 2],
    ["outOfWindowDropped", byDate.size === 30 && !byDate.has("2026-09-19")],
    ["dailySum", data.daily.reduce((s, d) => s + d.own + d.other, 0) === 3],
  ];
});

// ---------------------------------------------------------------- 可见性过滤

check("buildData: 非公开仓库整体剔除（且不泄漏名字 / 标题 / 链接）", () => {
  const w = computeWindow(Date.parse("2026-09-17T20:00:00Z"));
  const collection = {
    ...emptyCollection(),
    // 标量含私有贡献：commits 20 = 公开 12 + 私有 10
    totalCommitContributions: 20,
    totalIssueContributions: 3,
    totalPullRequestContributions: 2,
    totalPullRequestReviewContributions: 1,
    commitContributionsByRepository: [
      { repository: pub("sogeisetsu/public-a"), contributions: { totalCount: 10 } },
      { repository: priv("sogeisetsu/secret-b"), contributions: { totalCount: 10 } },
      { repository: pub("other/public-c"), contributions: { totalCount: 2 } },
      // 字段自相矛盾时 isPrivate 优先；internal 不是公开
      { repository: { nameWithOwner: "sogeisetsu/secret-d", isPrivate: true, visibility: "PUBLIC", owner: { login: "sogeisetsu" } }, contributions: { totalCount: 5 } },
      { repository: { nameWithOwner: "sogeisetsu/internal-e", isPrivate: false, visibility: "internal", owner: { login: "sogeisetsu" } }, contributions: { totalCount: 7 } },
    ],
    issueContributions: {
      nodes: [
        { issue: { repository: pub("sogeisetsu/public-a"), title: "public issue", url: "https://x/1", createdAt: ISO } },
        { issue: { repository: priv("sogeisetsu/secret-b"), title: "SECRET TITLE", url: "https://x/secret", createdAt: ISO } },
      ],
    },
    pullRequestContributions: {
      nodes: [
        { pullRequest: { repository: pub("other/public-c"), title: "public pr", url: "https://x/2", state: "MERGED", createdAt: ISO, mergedAt: ISO } },
      ],
    },
    pullRequestReviewContributions: {
      nodes: [
        { repository: priv("sogeisetsu/secret-b"), pullRequest: { title: "SECRET PR", url: "https://x/secret-pr", createdAt: ISO } },
      ],
    },
  };
  const { data, details, audit } = buildData(collection, [], w);
  const dataJson = JSON.stringify(data);
  const detailsJson = JSON.stringify(details);
  const leak = (hay) => ["secret-b", "secret-d", "internal-e", "SECRET TITLE", "SECRET PR", "/secret"].some((s) => hay.includes(s));
  return [
    ["commitsPublicOnly", data.totals.commits === 12],
    ["issuesPublicOnly", data.totals.issues === 1],
    ["prsPublicOnly", data.totals.prs === 1],
    ["reviewsPublicOnly", data.totals.reviews === 0],
    ["reposOwn", JSON.stringify(data.reposOwn) === JSON.stringify([{ name: "sogeisetsu/public-a", count: 11 }])],
    ["reposOther", JSON.stringify(data.reposOther) === JSON.stringify([{ name: "other/public-c", count: 3 }])],
    ["noLeakInData", !leak(dataJson)],
    ["noLeakInDetails", !leak(detailsJson)],
    ["hiddenCommits", audit.hidden.commits === 22],
    ["hiddenIssuesReviews", audit.hidden.issues === 1 && audit.hidden.reviews === 1],
    ["hiddenRepos", audit.hidden.repos === 3],
    ["scalarsKept", audit.scalars.commits === 20],
    ["notEmpty", data.empty === false],
  ];
});

check("buildData: totals 恒等于公开明细求和（= splits 之和）", () => {
  const w = computeWindow(Date.parse("2026-09-17T20:00:00Z"));
  const collection = {
    ...emptyCollection(),
    totalCommitContributions: 999, // 标量与公开口径故意不一致，totals 必须跟着明细走
    commitContributionsByRepository: [
      { repository: pub("sogeisetsu/public-a"), contributions: { totalCount: 4 } },
      { repository: priv("sogeisetsu/secret-b"), contributions: { totalCount: 8 } },
    ],
  };
  const { data } = buildData(collection, [], w);
  return [
    ["commitsIgnoresScalar", data.totals.commits === 4],
    ...["commits", "prs", "issues", "reviews"].map((k) => [
      `splitSum${k}`,
      data.splits[k].own + data.splits[k].others === data.totals[k],
    ]),
  ];
});

// ---------------------------------------------------------------- 事件分页判定（Link 为准）

const WINDOW_START_MS = Date.parse("2026-09-20T00:00:00+08:00");
const LINK_NEXT =
  '<https://api.github.com/user/1/events/public?per_page=100&page=2>; rel="next", ' +
  '<https://api.github.com/user/1/events/public?per_page=100&page=3>; rel="last"';
const LINK_LAST =
  '<https://api.github.com/user/1/events/public?per_page=100&page=2>; rel="prev", ' +
  '<https://api.github.com/user/1/events/public?per_page=100&page=1>; rel="first"';
// 页面内的事件时间都晚于窗口起点（09-20 之后），故停不因窗口边界
const inWindowTs = Date.parse("2026-09-25T00:00:00Z");

const decide = (over = {}) =>
  decideEventPage({
    page: 1,
    ok: true,
    status: 200,
    chunkLength: 0,
    link: "",
    oldestTs: 0,
    windowStartMs: WINDOW_START_MS,
    ...over,
  });

check('decideEventPage: Link 有 rel="next" → 继续（满页 / 短页都继续）', () => {
  return [
    ["fullPageContinues", decide({ page: 1, chunkLength: 100, link: LINK_NEXT, oldestTs: inWindowTs }).action === "continue"],
    ["shortPageContinues", decide({ page: 1, chunkLength: 77, link: LINK_NEXT, oldestTs: inWindowTs }).action === "continue"],
    ["hasNext", decide({ chunkLength: 100, link: LINK_NEXT, oldestTs: inWindowTs }).hasNext === true],
    ["notStoppedByLimit", decide({ chunkLength: 100, link: LINK_NEXT, oldestTs: inWindowTs }).stoppedByLimit === false],
  ];
});

check('decideEventPage: Link 无 rel="next" + 满页 → 停且标记可能没抓全（今天的 422 坑）', () => {
  const d = decide({ page: 3, chunkLength: 100, link: LINK_LAST, oldestTs: inWindowTs });
  return [
    ["stop", d.action === "stop"],
    ["hasNextFalse", d.hasNext === false],
    ["stoppedByLimit", d.stoppedByLimit === true],
  ];
});

check('decideEventPage: Link 无 rel="next" + 短页 → 停，且不算截断', () => {
  const d = decide({ page: 3, chunkLength: 77, link: LINK_LAST, oldestTs: inWindowTs });
  return [
    ["stop", d.action === "stop"],
    ["notStoppedByLimit", d.stoppedByLimit === false],
  ];
});

check("decideEventPage: 空数组 → 停（不算截断）", () => {
  const d = decide({ page: 1, chunkLength: 0, link: LINK_NEXT });
  return [
    ["stop", d.action === "stop"],
    ["notFail", d.action !== "fail"],
    ["notStoppedByLimit", d.stoppedByLimit === false],
  ];
});

check("decideEventPage: 本页最旧事件早于窗口起点 → 正常停（不算截断）", () => {
  const oldest = Date.parse("2026-09-19T00:00:00Z"); // 早于 09-20 00:00+08
  const d = decide({ page: 2, chunkLength: 100, link: LINK_NEXT, oldestTs: oldest });
  return [
    ["stop", d.action === "stop"],
    ["notStoppedByLimit", d.stoppedByLimit === false],
  ];
});

check("decideEventPage: 422 → 停 + stoppedByLimit，不 fail（分页到底不是错误）", () => {
  const d = decide({ page: 4, ok: false, status: 422 });
  return [
    ["notFail", d.action !== "fail"],
    ["stop", d.action === "stop"],
    ["stoppedByLimit", d.stoppedByLimit === true],
  ];
});

check("decideEventPage: 第 1 页非 2xx → fail（没有事件样本会让卡片与 totals 自相矛盾）", () => {
  const http = decide({ page: 1, ok: false, status: 500 });
  const net = decide({ page: 1, ok: false, status: 0 });
  return [
    ["httpFail", http.action === "fail"],
    ["netFail", net.action === "fail"],
    ["failNotStoppedByLimit", http.stoppedByLimit === false],
  ];
});

check("decideEventPage: 第 2 页起非 422 错误 → 降级停 + stoppedByLimit（不致命）", () => {
  const d = decide({ page: 2, ok: false, status: 500 });
  return [
    ["stop", d.action === "stop"],
    ["notFail", d.action !== "fail"],
    ["stoppedByLimit", d.stoppedByLimit === true],
  ];
});

// ---------------------------------------------------------------- 截断标记

check("buildData: truncatedFrom 用 +08 日期（UTC 09-17T20:00Z = 北京 09-18）", () => {
  const w = computeWindow(Date.parse("2026-09-17T20:00:00Z"));
  // 事件必须落在窗口内（08-20 → 09-18）：取满 300 条触发 reachedCap，最早一条在北京 09-18 04:00
  const base = Date.parse("2026-09-17T20:00:00Z");
  const events = Array.from({ length: 300 }, (_, i) => push(new Date(base + i * 1000).toISOString()));
  const { data } = buildData(emptyCollection(), events, w);
  return [
    ["truncated", data.truncated === true],
    ["cstDate", data.truncatedFrom === "2026-09-18"],
    ["notUtcDate", data.truncatedFrom !== "2026-09-17"],
  ];
});

check("buildData: 窗口外的远古事件不污染 truncatedFrom（实测事件流会混进 2019 年事件）", () => {
  const w = computeWindow(Date.parse("2026-09-17T20:00:00Z")); // 窗口 2026-08-20 → 2026-09-18
  const base = Date.parse("2026-09-17T20:00:00Z");
  const events = [
    push("2019-08-09T09:09:53Z"), // 窗口外的远古事件：不得参与"最早事件"判定
    ...Array.from({ length: 299 }, (_, i) => push(new Date(base + i * 1000).toISOString())),
  ];
  const { data } = buildData(emptyCollection(), events, w, true);
  return [
    ["windowsOutsideIgnored", data.truncatedFrom === "2026-09-18"],
    ["truncated", data.truncated === true],
  ];
});

check("buildData: 分页提前停止 + 最早事件晚于窗口起点 → truncated=true（今天 277 条 < 300 却漏了前两天）", () => {
  const w = computeWindow(Date.parse("2026-09-17T20:00:00Z")); // 窗口 2026-08-20 → 2026-09-18
  const events = [
    push("2026-09-17T19:47:25Z"), // 北京 09-18 03:47，晚于窗口起点 +24h（08-21 00:00+08）
    push("2026-09-17T20:00:00Z"),
  ];
  const { data } = buildData(emptyCollection(), events, w, true);
  return [
    ["truncated", data.truncated === true],
    ["truncatedFrom", data.truncatedFrom === "2026-09-18"],
    ["underMax", events.length < 300],
  ];
});

check("buildData: 分页提前停止但最早事件落在窗口首日 → 不标截断（窗口前段本来就没数据）", () => {
  const w = computeWindow(Date.parse("2026-09-17T20:00:00Z"));
  const events = [push("2026-08-20T02:00:00Z")]; // 北京 08-20 10:00 = 窗口首日
  const { data } = buildData(emptyCollection(), events, w, true);
  return [
    ["notTruncated", data.truncated === false],
    ["noFrom", data.truncatedFrom === null],
  ];
});

check("buildData: 未提前停止且未取满 → truncated=false（默认行为不变）", () => {
  const w = computeWindow(Date.parse("2026-09-17T20:00:00Z"));
  const events = [push("2026-09-17T19:47:25Z")];
  const { data } = buildData(emptyCollection(), events, w);
  return [["notTruncated", data.truncated === false]];
});

// ---------------------------------------------------------------- isPublicRepoRef

check("isPublicRepoRef: 拿不准一律按不公开", () => {
  return [
    ["null", isPublicRepoRef(null) === false],
    ["undefined", isPublicRepoRef(undefined) === false],
    ["isPrivateWinsOverVisibility", isPublicRepoRef({ isPrivate: true, visibility: "PUBLIC" }) === false],
    ["internal", isPublicRepoRef({ isPrivate: false, visibility: "internal" }) === false],
    ["uppercasePublic", isPublicRepoRef({ isPrivate: false, visibility: "PUBLIC" }) === true],
    ["lowercasePublic", isPublicRepoRef({ isPrivate: false, visibility: "public" }) === true],
    ["missingVisibility", isPublicRepoRef({ isPrivate: false }) === false],
    ["nullVisibility", isPublicRepoRef({ isPrivate: false, visibility: null }) === false],
  ];
});

// ---------------------------------------------------------------- 汇总

console.log(`\n${passed}/${cases.length} cases passed`);
process.exit(passed === cases.length ? 0 : 1);
