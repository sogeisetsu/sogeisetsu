#!/usr/bin/env node
/**
 * scripts/generate-activity.mjs
 * ------------------------------------------------------------------
 * 近 30 天 GitHub 活动数据抓取 + 组装 + 回写（零依赖 ESM，Node 20+ 内置 fetch）。
 *
 * 数据流：
 *   GraphQL contributionsCollection（官方四项总数 + 逐仓库/逐条明细）
 *   + REST /users/:owner/events/public（每日时间轴 + 评论/Release/Star 事件）
 *   → 组装 data（schema 见下）
 *   → renderActivityCard(data) → 原子写入 assets/30-day-activity.svg
 *   → 替换 README.md 中 <!--START:activity--> / <!--END:activity--> 之间的内容
 *
 * data schema（消费契约，与 render-svg.mjs 对齐）：
 *   {
 *     username, windowStart, windowEnd,
 *     totals:   { commits, prs, issues, reviews },
 *     splits:   { commits:{own,others}, prs:{own,others}, issues:{own,others}, reviews:{own,others} },
 *     daily:    [ { date, own, other } ],   // 30 项升序
 *     reposOwn: [ { name, count } ],
 *     reposOther:[ { name, count } ],
 *     empty: Boolean, quip: String|null,
 *     truncated: Boolean, truncatedFrom: String|null
 *   }
 *
 * 用法：node scripts/generate-activity.mjs [--dry-run]
 *   --dry-run 只打印摘要，不写任何文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderActivityCard } from "./render-svg.mjs";

// ---------------------------------------------------------------- 环境与常量

const TOKEN = process.env.GITHUB_TOKEN || null;
const OWNER = process.env.GITHUB_REPOSITORY_OWNER || "sogeisetsu";
const REPO = process.env.GITHUB_REPOSITORY || "sogeisetsu/sogeisetsu";
const DRY_RUN = process.argv.includes("--dry-run");
// --dump-data=FILE：把组装好的 data 原样导出为 JSON（调试/设计复核用），不改变其它行为
const DUMP_DATA = (process.argv.find((a) => a.startsWith("--dump-data=")) || "").slice(12) || null;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = path.join(ROOT, "README.md");
const SVG_PATH = path.join(ROOT, "assets", "30-day-activity.svg");

const START_MARK = "<!--START:activity-->";
const END_MARK = "<!--END:activity-->";

const WINDOW_DAYS = 30;
const EVENT_MAX_PAGES = 5; // 分页上限（per_page=100）
const EVENT_MAX = 300; // 事件总条数上限（取满则 truncated 可能为 true）
const EVENT_PER_PAGE = 100;
const REPO_TOP_N = 12; // 传给渲染层，渲染层按两栏条数自适应折叠（3~5 条 + 「其他 n 个仓库」）
const DETAIL_MAX = 10; // README 每个 <details> 最多 10 条

const QUIPS = [
  "quiet as a repo that never got initialized",
  "my contribution graph entered zen mode",
  "did absolutely nothing, and honestly I regret nothing",
  "empty calendar, suspiciously clear mind",
  "too lazy to even click a star",
];

const GRAPHQL_QUERY = `
query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      commitContributionsByRepository(maxRepositories: 25) {
        repository { nameWithOwner owner { login } }
        contributions { totalCount }
      }
      issueContributions(first: 50) {
        totalCount
        nodes {
          issue {
            repository { nameWithOwner owner { login } }
            title
            url
            createdAt
          }
        }
      }
      pullRequestContributions(first: 50) {
        totalCount
        nodes {
          pullRequest {
            repository { nameWithOwner owner { login } }
            title
            url
            state
            createdAt
            mergedAt
          }
        }
      }
      pullRequestReviewContributions(first: 50) {
        totalCount
        nodes {
          repository { nameWithOwner owner { login } }
          pullRequest { title url createdAt mergedAt }
        }
      }
    }
  }
}
`;

// ---------------------------------------------------------------- 小工具

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function fail(message, detail) {
  console.error(`[generate-activity] 错误: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

/** Markdown 转义：至少保证 []() 不破坏链接语法。 */
function escMd(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

const isOwnLogin = (login) => String(login ?? "").toLowerCase() === OWNER.toLowerCase();
const isOwnRepoName = (nameWithOwner) =>
  isOwnLogin(String(nameWithOwner ?? "").split("/")[0]);

const tsOf = (value) => {
  const t = Date.parse(value ?? "");
  return Number.isFinite(t) ? t : 0;
};

function apiHeaders(extra = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "sogeisetsu-activity-bot",
    ...extra,
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  return headers;
}

/** 网络请求：5xx / 网络异常重试 2 次（指数退避）；4xx 立即返回由调用方处理。 */
async function httpFetch(url, init = {}) {
  const retries = 2;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
      } else {
        return res;
      }
    } catch (err) {
      lastError = new Error(`网络请求失败 (${url}): ${err && err.message}`);
    }
    if (attempt < retries) {
      const backoff = 1000 * 2 ** attempt;
      console.error(
        `[generate-activity] ${lastError.message}，${backoff}ms 后重试（第 ${attempt + 1}/${retries} 次）`
      );
      await sleep(backoff);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------- 窗口计算

function computeWindow() {
  const now = new Date();
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  const iso = (d) => d.toISOString().slice(0, 10);

  const dates = [];
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(iso(d));
  }
  return { start, end, startISO: iso(start), endISO: iso(end), dates };
}

// ---------------------------------------------------------------- GraphQL

async function fetchContributions(window) {
  const res = await httpFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: apiHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: {
        login: OWNER,
        from: `${window.startISO}T00:00:00Z`,
        to: `${window.endISO}T23:59:59Z`,
      },
    }),
  });

  const text = await res.text();
  if (res.status >= 400) {
    // 4xx：打印响应体里的 errors 并非零退出
    fail(`GraphQL 返回 HTTP ${res.status}`, text.slice(0, 2000));
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    fail(`GraphQL 响应不是合法 JSON: ${err.message}`, text.slice(0, 500));
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    // 带 errors 字段：打印 errors 并非零退出
    fail("GraphQL 返回 errors 字段", JSON.stringify(body.errors, null, 2));
  }
  const collection = body.data && body.data.user && body.data.user.contributionsCollection;
  if (!collection) {
    fail("GraphQL 未返回 user.contributionsCollection", text.slice(0, 1000));
  }
  return collection;
}

// ---------------------------------------------------------------- REST 事件

async function fetchPublicEvents() {
  const all = [];
  let hasNext = true;
  for (let page = 1; page <= EVENT_MAX_PAGES && all.length < EVENT_MAX && hasNext; page += 1) {
    const url = `https://api.github.com/users/${encodeURIComponent(
      OWNER
    )}/events/public?per_page=${EVENT_PER_PAGE}&page=${page}`;
    const res = await httpFetch(url, { headers: apiHeaders() });
    const text = await res.text();
    if (res.status >= 400) {
      fail(`获取事件失败 HTTP ${res.status} (${url})`, text.slice(0, 1000));
    }
    let chunk;
    try {
      chunk = JSON.parse(text);
    } catch (err) {
      fail(`事件响应不是合法 JSON: ${err.message}`, text.slice(0, 500));
    }
    if (!Array.isArray(chunk)) {
      fail("事件响应不是数组", text.slice(0, 500));
    }
    all.push(...chunk);
    if (chunk.length === 0) break;
    const link = res.headers.get("link") || "";
    // 跟随 Link header；没有 Link 时按“满页即还有下一页”推断
    hasNext = /rel="next"/.test(link) ? true : chunk.length === EVENT_PER_PAGE;
  }
  return all.slice(0, EVENT_MAX);
}

// ---------------------------------------------------------------- 汇总

function bump(map, key, delta) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + delta);
}

function toRepoList(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, REPO_TOP_N);
}

function buildData(collection, rawEvents, window) {
  const totals = {
    commits: num(collection.totalCommitContributions),
    prs: num(collection.totalPullRequestContributions),
    issues: num(collection.totalIssueContributions),
    reviews: num(collection.totalPullRequestReviewContributions),
  };
  const splits = {
    commits: { own: 0, others: 0 },
    prs: { own: 0, others: 0 },
    issues: { own: 0, others: 0 },
    reviews: { own: 0, others: 0 },
  };

  const details = {
    commits: [], // { name, count, own }
    issues: [], // { repo, title, url, ts, own }
    prs: [], // { repo, title, url, state, ts, own }
    reviews: [], // { repo, title, url, ts, own }
    comments: [], // { repo, label, url, title, ts, own }
    releases: [], // { repo, tag, url, ts, own }
    stars: [], // { repo, ts, own }
  };

  const repoOwn = new Map();
  const repoOther = new Map();

  // --- 提交（逐仓库归属） ---
  for (const row of collection.commitContributionsByRepository || []) {
    const repo = row && row.repository && row.repository.nameWithOwner;
    if (!repo) continue;
    const count = num(row.contributions && row.contributions.totalCount);
    const own = isOwnLogin(row.repository.owner && row.repository.owner.login);
    splits.commits[own ? "own" : "others"] += count;
    details.commits.push({ name: repo, count, own });
    bump(own ? repoOwn : repoOther, repo, count);
  }

  // --- Issue / PR / 评审（逐条归属） ---
  for (const node of collection.issueContributions?.nodes || []) {
    const issue = node && node.issue;
    if (!issue) continue;
    const repo = issue.repository && issue.repository.nameWithOwner;
    const own = isOwnLogin(issue.repository && issue.repository.owner && issue.repository.owner.login);
    splits.issues[own ? "own" : "others"] += 1;
    details.issues.push({
      repo,
      title: issue.title || "",
      url: issue.url || "",
      ts: tsOf(issue.createdAt),
      own,
    });
    bump(own ? repoOwn : repoOther, repo, 1);
  }
  for (const node of collection.pullRequestContributions?.nodes || []) {
    const pr = node && node.pullRequest;
    if (!pr) continue;
    const repo = pr.repository && pr.repository.nameWithOwner;
    const own = isOwnLogin(pr.repository && pr.repository.owner && pr.repository.owner.login);
    splits.prs[own ? "own" : "others"] += 1;
    details.prs.push({
      repo,
      title: pr.title || "",
      url: pr.url || "",
      state: String(pr.state || "").toLowerCase(),
      // PR 贡献按合并时间计入，排序用 mergedAt，其次 createdAt
      ts: tsOf(pr.mergedAt) || tsOf(pr.createdAt),
      own,
    });
    bump(own ? repoOwn : repoOther, repo, 1);
  }
  for (const node of collection.pullRequestReviewContributions?.nodes || []) {
    const pr = node && node.pullRequest;
    const repo = node && node.repository && node.repository.nameWithOwner;
    if (!pr || !repo) continue;
    const own = isOwnLogin(node.repository.owner && node.repository.owner.login);
    splits.reviews[own ? "own" : "others"] += 1;
    details.reviews.push({
      repo,
      title: pr.title || "",
      url: pr.url || "",
      ts: tsOf(pr.mergedAt) || tsOf(pr.createdAt),
      own,
    });
    bump(own ? repoOwn : repoOther, repo, 1);
  }

  // --- 每日时间轴 + 事件类明细 ---
  const dailyByDate = new Map(window.dates.map((d) => [d, { date: d, own: 0, other: 0 }]));
  const pushWeight = (event) => {
    const payload = event.payload || {};
    return payload.size ?? payload.commits?.length ?? 1;
  };

  let earliestTs = Infinity;
  for (const event of rawEvents) {
    const ts = tsOf(event.created_at);
    if (ts && ts < earliestTs) earliestTs = ts;
    const date = String(event.created_at || "").slice(0, 10);
    if (!dailyByDate.has(date)) continue; // 只保留窗口内事件
    const own = isOwnRepoName(event.repo && event.repo.name);
    const weight = event.type === "PushEvent" ? pushWeight(event) : 1;
    const bucket = dailyByDate.get(date);
    bucket[own ? "own" : "other"] += weight;
    bump(own ? repoOwn : repoOther, event.repo && event.repo.name, weight);

    if (event.type === "IssueCommentEvent") {
      const payload = event.payload || {};
      const target = payload.pull_request || payload.issue || {};
      const comment = payload.comment || {};
      const number = target.number ?? "";
      const url =
        target.html_url ||
        comment.html_url ||
        `https://github.com/${event.repo.name}/issues/${number}`;
      details.comments.push({
        repo: event.repo.name,
        label: number ? `${event.repo.name}#${number}` : event.repo.name,
        url,
        title: target.title || "",
        ts,
        own,
      });
    } else if (event.type === "ReleaseEvent") {
      const release = (event.payload || {}).release || {};
      details.releases.push({
        repo: event.repo.name,
        tag: release.tag_name || release.name || "release",
        url: release.html_url || `https://github.com/${event.repo.name}/releases`,
        ts,
        own,
      });
    } else if (event.type === "WatchEvent" && (event.payload || {}).action !== "deleted") {
      details.stars.push({ repo: event.repo.name, ts, own });
    }
  }

  const daily = window.dates.map(
    (d) => dailyByDate.get(d) || { date: d, own: 0, other: 0 }
  );

  // --- 空状态 ---
  const totalsZero =
    totals.commits === 0 && totals.prs === 0 && totals.issues === 0 && totals.reviews === 0;
  const dailyZero = daily.every((d) => d.own === 0 && d.other === 0);
  const empty = totalsZero && dailyZero;
  const quip = empty ? QUIPS[Math.floor(Math.random() * QUIPS.length)] : null;

  // --- 截断标记 ---
  const reachedCap = rawEvents.length >= EVENT_MAX;
  const earliestAfterStart =
    Number.isFinite(earliestTs) && earliestTs > window.start.getTime() + 24 * 3600 * 1000;
  const truncated = reachedCap && earliestAfterStart;
  const truncatedFrom = truncated ? new Date(earliestTs).toISOString().slice(0, 10) : null;

  const data = {
    username: OWNER,
    windowStart: window.startISO,
    windowEnd: window.endISO,
    totals,
    splits,
    daily,
    reposOwn: toRepoList(repoOwn),
    reposOther: toRepoList(repoOther),
    empty,
    quip,
    truncated,
    truncatedFrom,
  };

  return { data, details };
}

// ---------------------------------------------------------------- README 区块

function sortDesc(items) {
  return [...items].sort((a, b) => b.ts - a.ts);
}

function prSuffix(state) {
  if (state === "merged") return "merged";
  if (state === "open") return "open";
  if (state === "closed") return "closed";
  return state || "unknown";
}

function buildOwnLines(details) {
  const lines = [];
  // 第 1 层：提交是全窗口聚合（无单条时间戳），按计数降序置顶
  for (const c of details.commits
    .filter((c) => c.own)
    .sort((a, b) => b.count - a.count)) {
    lines.push(
      `- 📝 Pushed ${c.count} commit${c.count === 1 ? "" : "s"} to \`${c.name}\``
    );
  }
  // 第 2 层：自己仓库的 PR / Issue / 评审，按时间倒序
  const contributions = [
    ...details.prs
      .filter((x) => x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 🚀 [${escMd(x.title)}](${x.url}) · ${prSuffix(x.state)}`,
      })),
    ...details.issues
      .filter((x) => x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 🐛 Opened issue [${escMd(x.title)}](${x.url}) in \`${x.repo}\``,
      })),
    ...details.reviews
      .filter((x) => x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 👀 Reviewed [${escMd(x.title)}](${x.url})`,
      })),
  ];
  lines.push(...sortDesc(contributions).map((x) => x.text));
  // 第 3 层：自己仓库的评论 / Release / Star，仅在有余量时补位
  const ownEvents = [
    ...details.comments
      .filter((x) => x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 💬 Commented on [${x.label}](${x.url})${
          x.title ? `: ${escMd(x.title)}` : ""
        }`,
      })),
    ...details.releases
      .filter((x) => x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 📦 Released [${escMd(x.tag)}](${x.url}) in \`${x.repo}\``,
      })),
    ...details.stars
      .filter((x) => x.own)
      .map((x) => ({ ts: x.ts, text: `- ⭐ Starred \`${x.repo}\`` })),
  ];
  lines.push(...sortDesc(ownEvents).map((x) => x.text));
  return lines.slice(0, DETAIL_MAX);
}

function buildOtherLines(details) {
  const timed = [
    ...details.prs
      .filter((x) => !x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 🚀 [${escMd(x.title)}](${x.url}) · ${prSuffix(x.state)}`,
      })),
    ...details.issues
      .filter((x) => !x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 🐛 Opened issue [${escMd(x.title)}](${x.url}) in \`${x.repo}\``,
      })),
    ...details.reviews
      .filter((x) => !x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 👀 Reviewed [${escMd(x.title)}](${x.url})`,
      })),
    ...details.comments
      .filter((x) => !x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 💬 Commented on [${x.label}](${x.url})${
          x.title ? `: ${escMd(x.title)}` : ""
        }`,
      })),
    ...details.releases
      .filter((x) => !x.own)
      .map((x) => ({
        ts: x.ts,
        text: `- 📦 Released [${escMd(x.tag)}](${x.url}) in \`${x.repo}\``,
      })),
    ...details.stars
      .filter((x) => !x.own)
      .map((x) => ({ ts: x.ts, text: `- ⭐ Starred \`${x.repo}\`` })),
  ];
  const lines = sortDesc(timed).map((x) => x.text);
  if (lines.length === 0) lines.push("- (no traces left on other people's repos lately)");
  return lines.slice(0, DETAIL_MAX);
}

function buildReadmeBlock(data, details, todayISO) {
  const head = `_Updated automatically: ${todayISO}_`;
  if (data.empty) {
    return [
      head,
      "",
      `> 🦥 ${data.quip} — not a single commit. I'm cooking something.`,
    ].join("\n");
  }
  const ownLines = buildOwnLines(details);
  const otherLines = buildOtherLines(details);
  if (ownLines.length === 0) ownLines.push("- (didn't touch my own repos lately)");
  return [
    head,
    "",
    "<details><summary>🔨 On my own repositories</summary>",
    "",
    ...ownLines,
    "",
    "</details>",
    "",
    "<details><summary>🌐 On other people's repositories</summary>",
    "",
    ...otherLines,
    "",
    "</details>",
  ].join("\n");
}

/** 只替换两个 marker 之间的内容，marker 之外的字节原样保留。 */
function replaceReadmeBlock(content, block) {
  const startCount = countOccurrences(content, START_MARK);
  const endCount = countOccurrences(content, END_MARK);
  if (startCount !== 1 || endCount !== 1) {
    fail(
      `README 标记必须各出现且只出现一次（START=${startCount}, END=${endCount}）`
    );
  }
  const startIdx = content.indexOf(START_MARK);
  const endIdx = content.indexOf(END_MARK);
  if (endIdx < startIdx) fail("README 标记顺序错误：END 出现在 START 之前");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return (
    content.slice(0, startIdx + START_MARK.length) +
    eol +
    block +
    eol +
    content.slice(endIdx)
  );
}

/** 原子写入：先写临时文件再 rename。 */
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const window = computeWindow();

  const collection = await fetchContributions(window);
  const rawEvents = await fetchPublicEvents();
  const { data, details } = buildData(collection, rawEvents, window);
  if (DUMP_DATA) {
    const dp = path.resolve(ROOT, DUMP_DATA);
    mkdirSync(path.dirname(dp), { recursive: true });
    writeFileSync(dp, JSON.stringify(data, null, 2), "utf8");
    console.log(`data: 已导出 ${path.relative(ROOT, dp)}`);
  }

  // 渲染（契约：renderActivityCard(data) -> SVG 字符串）
  const svg = await renderActivityCard(data);
  if (typeof svg !== "string" || !svg.trim().startsWith("<")) {
    fail("renderActivityCard 未返回 SVG 字符串");
  }

  // README 区块
  const todayISO = window.endISO;
  const readmeBefore = readFileSync(README_PATH, "utf8");
  const block = buildReadmeBlock(data, details, todayISO);
  const readmeAfter = replaceReadmeBlock(readmeBefore, block);
  const readmeChanged = readmeAfter !== readmeBefore;

  const svgBefore = existsSync(SVG_PATH) ? readFileSync(SVG_PATH, "utf8") : null;
  const svgChanged = svgBefore !== svg;

  // 摘要
  const activeDays = data.daily.filter((d) => d.own > 0 || d.other > 0).length;
  console.log(`仓库: ${REPO}（owner=${OWNER}）`);
  console.log(`窗口: ${data.windowStart} → ${data.windowEnd}（${WINDOW_DAYS} 天）`);
  console.log(
    `totals: commits=${data.totals.commits} prs=${data.totals.prs} issues=${data.totals.issues} reviews=${data.totals.reviews}`
  );
  console.log(
    `splits: commits own/others=${data.splits.commits.own}/${data.splits.commits.others}` +
      ` · prs=${data.splits.prs.own}/${data.splits.prs.others}` +
      ` · issues=${data.splits.issues.own}/${data.splits.issues.others}` +
      ` · reviews=${data.splits.reviews.own}/${data.splits.reviews.others}`
  );
  console.log(
    `empty: ${data.empty}${data.quip ? `（quip: ${data.quip}）` : ""}`
  );
  console.log(`daily 活跃天数: ${activeDays}/${WINDOW_DAYS}`);
  console.log(`事件样本: 取到 ${rawEvents.length} 条（上限 ${EVENT_MAX}）`);
  console.log(
    `truncated: ${data.truncated}${data.truncatedFrom ? `（from ${data.truncatedFrom}）` : ""}`
  );

  if (DRY_RUN) {
    console.log("--- README 区块预览（marker 之间，未写入）---");
    console.log(block);
    console.log("--- 预览结束 ---");
    console.log(`README: --dry-run，${readmeChanged ? "有变化（未写入）" : "无变化"}`);
    console.log(`SVG: --dry-run，${svgChanged ? "有变化（未写入）" : "无变化"}`);
    console.log("--dry-run：未写入任何文件");
    return;
  }

  if (svgChanged) {
    writeAtomic(SVG_PATH, svg);
    console.log(`SVG: 已写入 ${path.relative(ROOT, SVG_PATH)}（${svg.length} 字节）`);
  } else {
    console.log(`SVG: 无变化（${path.relative(ROOT, SVG_PATH)}）`);
  }
  if (readmeChanged) {
    writeFileSync(README_PATH, readmeAfter, "utf8");
    console.log(`README: 已回写 ${path.relative(ROOT, README_PATH)}（marker 内内容替换）`);
  } else {
    console.log(`README: 无变化（${path.relative(ROOT, README_PATH)}）`);
  }
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
