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
 * 口径（与日报 / 30 天总结同源，口径本体在 scripts/cst.mjs）：
 *   · 窗口 = 最近 30 个 +08 自然日（含今天），窗口末日 = 北京今天；
 *     一个「天」= 该日 00:00:00+08:00 ≤ ts < 次日 00:00:00+08:00。
 *   · 只统计公开数据：contributionsCollection 在 user-scoped token 下会含私有贡献，
 *     故逐仓 / 逐条一律按 repository 的 isPrivate / visibility 过滤，
 *     拿不准一律按不公开处理（宁可少报，不可泄露）。REST /events/public 本身即公开口径。
 *   · totals 只由过滤后实际展示的公开明细求和（恒等于 splits 之和）；
 *     GitHub 的四项标量只用于对账告警，不进产物。
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
import { pathToFileURL } from "node:url";

import { ROOT } from "./lib/paths.mjs";
import { cstDateNextStartMs, cstDateOf, cstDateShift, cstDateStartMs, dateRange } from "./cst.mjs";
import { renderActivityCard } from "./render-svg.mjs";

// ---------------------------------------------------------------- 环境与常量

const TOKEN = process.env.GITHUB_TOKEN || null;
const OWNER = process.env.GITHUB_REPOSITORY_OWNER || "sogeisetsu";
const REPO = process.env.GITHUB_REPOSITORY || "sogeisetsu/sogeisetsu";
const DRY_RUN = process.argv.includes("--dry-run");
// --dump-data=FILE：把组装好的 data 原样导出为 JSON（调试/设计复核用），不改变其它行为
const DUMP_DATA = (process.argv.find((a) => a.startsWith("--dump-data=")) || "").slice(12) || null;

const README_PATH = path.join(ROOT, "README.md");
const SVG_PATH = path.join(ROOT, "assets", "30-day-activity.svg");

const START_MARK = "<!--START:activity-->";
const END_MARK = "<!--END:activity-->";

const WINDOW_DAYS = 30;
// 分页页数上限（per_page=100）。注意这个上限由 API 决定而非我们：本端点从 page 1 起
// 就带 rel="last"（实测 = page 3，正好 EVENT_MAX/EVENT_PER_PAGE），真正"还有没有下一页"
// 一律以 Link 头为准（见 decideEventPage），页数只是个防失控的兜底。
const EVENT_MAX_PAGES = 3;
const EVENT_MAX = 300; // 事件总条数上限（取满、或撞分页上限，都让 truncated 可能为 true）
const EVENT_PER_PAGE = 100;
const REPO_TOP_N = 100; // 上限放宽到 API 上限，明细不再先截断；渲染层仍按两栏条数自适应折叠（3~5 条 + 「其他 n 个仓库」）
const DETAIL_MAX = 10; // README 每个 <details> 最多 10 条

const QUIPS = [
  "quiet as a repo that never got initialized",
  "the contribution graph entered zen mode",
  "did absolutely nothing, and honestly no regrets",
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
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner isPrivate visibility owner { login } }
        contributions { totalCount }
      }
      issueContributions(first: 100) {
        totalCount
        nodes {
          issue {
            repository { nameWithOwner isPrivate visibility owner { login } }
            title
            url
            createdAt
          }
        }
      }
      pullRequestContributions(first: 100) {
        totalCount
        nodes {
          pullRequest {
            repository { nameWithOwner isPrivate visibility owner { login } }
            title
            url
            state
            createdAt
            mergedAt
          }
        }
      }
      pullRequestReviewContributions(first: 100) {
        totalCount
        nodes {
          repository { nameWithOwner isPrivate visibility owner { login } }
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

/** 非致命告警：只打印一行，不改变退出码（与 fail 相对）。 */
function warn(message) {
  console.warn(`[generate-activity] 警告: ${message}`);
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

/**
 * 近 30 天窗口：+08 自然日、含今天，末日 = 北京今天（不是 UTC 今天）。
 * @param {number} nowMs 可注入的当前时刻（毫秒），便于确定性回归。
 * @returns {{startISO:string, endISO:string, dates:string[], startMs:number, endMs:number}}
 *   startMs = 窗口首日 00:00:00+08:00；endMs = 窗口末日次日 00:00:00+08:00（半开上界）。
 */
export function computeWindow(nowMs = Date.now()) {
  const endISO = cstDateOf(nowMs);
  const startISO = cstDateShift(endISO, -(WINDOW_DAYS - 1));
  return {
    startISO,
    endISO,
    dates: dateRange(startISO, endISO),
    startMs: cstDateStartMs(startISO),
    endMs: cstDateNextStartMs(endISO),
  };
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
        from: `${window.startISO}T00:00:00+08:00`,
        to: `${window.endISO}T23:59:59+08:00`,
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

/**
 * 单页事件的翻页决策（纯函数：无 IO、无全局状态，供 scripts/test-activity-window.mjs 确定性回归）。
 *
 * 「还有没有下一页」只认 Link 头：本端点从 page 1 起就带 rel="last"，
 * 而「满页 100 条」推不出还有下一页 —— 最后一页恰好满页是合法形态，
 * 拿它当 next 会去请求并不存在的下一页，得到 HTTP 422
 * （"pagination is limited for this resource"）。
 *
 * @param {object} p
 * @param {number} p.page             1-based 页码
 * @param {boolean} p.ok              是否拿到合法的事件数组（HTTP < 400 且响应体是数组）
 * @param {number} p.status           HTTP 状态码；网络异常 / JSON 解析失败用 0
 * @param {number} [p.chunkLength]    本页条数（失败时为 0）
 * @param {string} [p.link]           Link 头原文（无则空串）
 * @param {number} [p.oldestTs]       本页最旧事件的毫秒时间戳（0 = 未知）
 * @param {number} p.windowStartMs    窗口起点（毫秒）；本页最旧事件早于它即可正常停
 * @param {number} [p.perPage]        每页条数（满页判定）
 * @returns {{action:"continue"|"stop"|"fail", reason:string, hasNext:boolean, stoppedByLimit:boolean}}
 *   action=fail 只有一种情形：第 1 页没取到（一条事件都没有的话，daily 时间轴会全零、
 *   reposOwn 会空，而 totals 来自 GraphQL 非零 —— 卡片会「自己跟自己矛盾」，宁可红）。
 *   stoppedByLimit=true 表示「停不是因为数据自然读完，而是撞上了 API 的分页 / 可用性上限」，
 *   窗口内事件可能没抓全：不静默低报，交给调用方体现在 truncated 上。
 */
export function decideEventPage({
  page,
  ok,
  status,
  chunkLength = 0,
  link = "",
  oldestTs = 0,
  windowStartMs,
  perPage = EVENT_PER_PAGE,
}) {
  const stop = (reason, stoppedByLimit) => ({
    action: "stop",
    reason,
    hasNext: false,
    stoppedByLimit,
  });

  if (!ok) {
    if (page === 1) {
      return {
        action: "fail",
        reason: `第 1 页取数失败（HTTP ${status || "网络异常"}）`,
        hasNext: false,
        stoppedByLimit: false,
      };
    }
    if (status === 422) return stop(`公开事件分页上限（page ${page}）`, true);
    // 后续页是增量数据：拿不到只影响时间轴尾部，不值得让整条线红着不产出卡片 —— 降级停 + 如实标记
    return stop(`第 ${page} 页不可用（HTTP ${status || "网络异常"}）`, true);
  }

  if (chunkLength === 0) return stop("本页为空，事件已读完", false);
  // 事件按时间倒序：本页最旧一条已早于窗口起点，后面不可能再有窗口内事件
  if (oldestTs && oldestTs < windowStartMs) {
    return stop("本页最旧事件早于窗口起点", false); // 正常停，不算截断
  }

  if (!/rel="next"/.test(link)) {
    // Link 说没有下一页：可能是数据确实到此为止，也可能是撞上了 API 的分页上限
    // （本端点只给 3 页 / 300 条）。两者无法区分，满页时按「可能没抓全」诚实标记。
    return stop('Link 头没有 rel="next"', chunkLength >= perPage);
  }
  return {
    action: "continue",
    reason: 'Link 头有 rel="next"',
    hasNext: true,
    stoppedByLimit: false,
  };
}

/**
 * 抓取公开事件：翻页只认 Link 头（判定见 decideEventPage），另有页数 / 条数两道硬上限。
 * 失败策略：第 1 页失败仍然 fail；第 2 页起的 422 / 4xx / 5xx 重试耗尽 → 告警 + 停 +
 * 保留已取部分，并置 stoppedByLimit。
 * @returns {Promise<{events: object[], stoppedByLimit: boolean}>}
 */
async function fetchPublicEvents(window) {
  const all = [];
  let hasNext = true;
  let stoppedByLimit = false;
  let lastPage = 0;

  for (let page = 1; page <= EVENT_MAX_PAGES && hasNext; page += 1) {
    if (all.length >= EVENT_MAX) {
      stoppedByLimit = true; // 条数上限：窗口内事件可能被截
      break;
    }
    lastPage = page;
    const url = `https://api.github.com/users/${encodeURIComponent(
      OWNER
    )}/events/public?per_page=${EVENT_PER_PAGE}&page=${page}`;

    let status = 0;
    let link = "";
    let body = "";
    let chunk = [];
    let ok = false;
    try {
      const res = await httpFetch(url, { headers: apiHeaders() });
      status = res.status;
      link = res.headers.get("link") || "";
      body = await res.text();
      if (res.status < 400) {
        const parsed = JSON.parse(body); // 非法 JSON 会抛，落到下面的 catch
        if (Array.isArray(parsed)) {
          chunk = parsed;
          ok = true;
        } else {
          warn(`事件响应不是数组（page ${page}）`);
        }
      }
    } catch (err) {
      // httpFetch 重试耗尽（5xx / 网络异常），或响应体不是合法 JSON
      warn(`事件第 ${page} 页取数失败：${err && err.message}`);
    }

    const decision = decideEventPage({
      page,
      ok,
      status,
      chunkLength: chunk.length,
      link,
      oldestTs: chunk.length > 0 ? tsOf(chunk[chunk.length - 1].created_at) : 0,
      windowStartMs: window.startMs,
    });
    // 每页一行：页码 / 状态码 / 条数 / Link 是否给出下一页 / 判定结果，便于事后复盘中止原因
    console.log(
      `事件 page ${page}: status=${status || "-"} items=${chunk.length}` +
        ` linkHasNext=${/rel="next"/.test(link)} → ${decision.action}（${decision.reason}）`
    );

    if (decision.action === "fail") {
      fail(`获取事件失败 HTTP ${status} (${url})`, body.slice(0, 1000));
    }
    all.push(...chunk);
    hasNext = decision.hasNext;
    if (decision.stoppedByLimit) stoppedByLimit = true;
  }

  // 页数用尽而仍有下一页 → 窗口内事件可能被丢（正常形态下 Link 会先把它置 false）
  if (hasNext) stoppedByLimit = true;

  if (stoppedByLimit) {
    warn(
      `公开事件在第 ${lastPage} 页停止（已取 ${all.length} 条），窗口内时间轴可能不完整`
    );
  }
  return { events: all.slice(0, EVENT_MAX), stoppedByLimit };
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

/**
 * 仓库引用是否确认公开。
 * GraphQL 的 visibility 枚举是大写（PUBLIC），REST 是小写（public），故按大小写无关比较。
 * 拿不准（字段缺失 / null / 空串）一律当不公开：宁可少报，不可泄露。
 */
export function isPublicRepoRef(repo) {
  if (!repo) return false;
  if (repo.isPrivate === true) return false;
  return String(repo.visibility || "").toLowerCase() === "public";
}

export function buildData(collection, rawEvents, window, stoppedByLimit = false) {
  // GitHub 的四项权威标量：user-scoped token 下含私有贡献，只用于对账告警，不进产物。
  const scalars = {
    commits: num(collection.totalCommitContributions),
    prs: num(collection.totalPullRequestContributions),
    issues: num(collection.totalIssueContributions),
    reviews: num(collection.totalPullRequestReviewContributions),
  };
  // totals 只由过滤后「实际展示的公开明细」求和 —— 与日报同一条恒等式（恒等于 splits 之和）。
  const totals = { commits: 0, prs: 0, issues: 0, reviews: 0 };
  // 被剔掉的非公开量：仓库名只进 Set 做去重，绝不打印、绝不进产物；对外只暴露计数。
  const hidden = { commits: 0, prs: 0, issues: 0, reviews: 0, repos: new Set() };

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
    const repoRef = row && row.repository;
    const repo = repoRef && repoRef.nameWithOwner;
    if (!repo) continue;
    const count = num(row.contributions && row.contributions.totalCount);
    if (!isPublicRepoRef(repoRef)) {
      hidden.commits += count;
      hidden.repos.add(repo);
      continue;
    }
    const own = isOwnLogin(repoRef.owner && repoRef.owner.login);
    splits.commits[own ? "own" : "others"] += count;
    totals.commits += count;
    details.commits.push({ name: repo, count, own });
    bump(own ? repoOwn : repoOther, repo, count);
  }

  // --- Issue / PR / 评审（逐条归属） ---
  for (const node of collection.issueContributions?.nodes || []) {
    const issue = node && node.issue;
    if (!issue) continue;
    const repoRef = issue.repository;
    const repo = repoRef && repoRef.nameWithOwner;
    if (!isPublicRepoRef(repoRef)) {
      hidden.issues += 1;
      if (repo) hidden.repos.add(repo);
      continue;
    }
    const own = isOwnLogin(repoRef.owner && repoRef.owner.login);
    splits.issues[own ? "own" : "others"] += 1;
    totals.issues += 1;
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
    const repoRef = pr.repository;
    const repo = repoRef && repoRef.nameWithOwner;
    if (!isPublicRepoRef(repoRef)) {
      hidden.prs += 1;
      if (repo) hidden.repos.add(repo);
      continue;
    }
    const own = isOwnLogin(repoRef.owner && repoRef.owner.login);
    splits.prs[own ? "own" : "others"] += 1;
    totals.prs += 1;
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
    const repoRef = node && node.repository;
    const repo = repoRef && repoRef.nameWithOwner;
    if (!pr || !repo) continue;
    if (!isPublicRepoRef(repoRef)) {
      hidden.reviews += 1;
      hidden.repos.add(repo);
      continue;
    }
    const own = isOwnLogin(repoRef.owner && repoRef.owner.login);
    splits.reviews[own ? "own" : "others"] += 1;
    totals.reviews += 1;
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

  // 窗口内最早事件：只算落在窗口里的事件 —— 窗口外的旧事件会污染 truncatedFrom
  // （实测公开事件流会混进远古事件，如 2019 年的 PullRequestEvent，min 会被它带偏）
  let earliestInWindowTs = Infinity;
  for (const event of rawEvents) {
    const ts = tsOf(event.created_at);
    const date = cstDateOf(ts); // +08 自然日分桶（不能用 UTC 日期：00:00–08:00 之间会差一天）
    if (!dailyByDate.has(date)) continue; // 只保留窗口内事件
    if (ts < earliestInWindowTs) earliestInWindowTs = ts;
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
  // reachedCap：取满 EVENT_MAX 条；stoppedByLimit：因分页上限 / 后续页不可用而停（见 decideEventPage）。
  // 两条都只在「窗口内最早事件仍晚于窗口起点 +24h」时才置 truncated —— 那说明窗口前段确实没采到数据。
  const reachedCap = rawEvents.length >= EVENT_MAX;
  const earliestAfterStart =
    Number.isFinite(earliestInWindowTs) && earliestInWindowTs > window.startMs + 24 * 3600 * 1000;
  const truncated = (reachedCap || stoppedByLimit === true) && earliestAfterStart;
  const truncatedFrom = truncated ? cstDateOf(earliestInWindowTs) : null;

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

  // audit 只用于日志与回归断言，不进任何产物（--dump-data 只写 data）。
  const audit = {
    scalars,
    hidden: {
      commits: hidden.commits,
      prs: hidden.prs,
      issues: hidden.issues,
      reviews: hidden.reviews,
      repos: hidden.repos.size,
    },
  };

  return { data, details, audit };
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
      `> 🦥 ${data.quip} — not a single commit all month.`,
    ].join("\n");
  }
  const ownLines = buildOwnLines(details);
  const otherLines = buildOtherLines(details);
  if (ownLines.length === 0) ownLines.push("- (no activity on owned repos lately)");
  return [
    head,
    "",
    "<details><summary>🔨 Owned repos</summary>",
    "",
    ...ownLines,
    "",
    "</details>",
    "",
    "<details><summary>🌐 Contributed to</summary>",
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
  const eventsResult = await fetchPublicEvents(window);
  const rawEvents = eventsResult.events;
  const { data, details, audit } = buildData(
    collection,
    rawEvents,
    window,
    eventsResult.stoppedByLimit
  );
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
  // 对账：公开口径的 totals 必须等于 splits 之和；与 GitHub 标量不等时说明
  // 剔掉了非公开贡献或明细被 API 截断 —— 只告警，不阻断（lead 的是公开口径）。
  for (const { key, label } of [
    { key: "commits", label: "提交" },
    { key: "prs", label: "PR" },
    { key: "issues", label: "Issue" },
    { key: "reviews", label: "评审" },
  ]) {
    const splitSum = num(data.splits[key].own) + num(data.splits[key].others);
    const total = num(data.totals[key]);
    if (splitSum !== total) {
      console.warn(
        `警告: ${label}（${key}）公开明细对不上总数：own ${num(data.splits[key].own)} + others ${num(data.splits[key].others)} = ${splitSum}，但总数为 ${total}`
      );
    }
    const scalar = num(audit.scalars[key]);
    if (total !== scalar) {
      const hiddenN = num(audit.hidden[key]);
      console.warn(
        `警告: ${label}（${key}）公开口径 ${total} ≠ GitHub 标量 ${scalar}` +
          (hiddenN > 0
            ? `（其中 ${hiddenN} 来自未公开仓库，已剔除）`
            : "（明细可能被 API 上限截断）")
      );
    }
  }
  if (audit.hidden.repos > 0) {
    // 只报计数，不打印仓库名（公开口径：不泄露私有仓库名 / 数量）
    console.warn(
      `提示: 已剔除 ${audit.hidden.repos} 个未公开仓库（commits ${audit.hidden.commits} / issues ${audit.hidden.issues} / PRs ${audit.hidden.prs} / reviews ${audit.hidden.reviews}）`
    );
  }
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

// 仅当本文件被直接执行时跑 CLI（被 import 时不跑，供 scripts/test-activity-window.mjs 复用纯函数）
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((err) => {
    fail(err && err.stack ? err.stack : String(err));
  });
}
