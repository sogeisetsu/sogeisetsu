#!/usr/bin/env node
/**
 * scripts/summary/collect.mjs
 * ------------------------------------------------------------------
 * 30 天 GitHub 活动总结 · 数据聚合（零依赖 ESM，Node 20+）。
 *
 * 口径（为什么这么写）：
 *   · 窗口 = [cstDayMinus(30), cstDayMinus(1)] 闭区间，30 个已定稿 +08 自然日（今天不含）。
 *   · 数据源 = docs/data/ ∪ data/backfill/；同一天两份都有时以 docs/data 为准
 *     （docs/data 是定稿真相源，回填只是 Search 近似重建）。
 *   · 确定数字条（totals / automatedCommits）在这里逐日求和，绝不经 AI；
 *     AI 只拿压缩后的 aiPayload（聚合条目 + 由代码统计的每仓库数字，无原始事件、无 comments）。
 *   · dataHash = sha256(windowStart|windowEnd|各存在日 "date:dataHash:source" 升序 "|" 连接)，
 *     只掺数据本身、不掺 generatedAt —— 同一批数据必须稳定复现。
 *   · daily 保留原始单日对象，buildItemIndex 用它建 repo/条目集合（校验器的唯一事实口径）。
 *
 * 导出：
 *   summaryWindow()                          → { start, end }
 *   collectSummaryData({ username, start, end }) → 聚合结果（结构见 collectSummaryData 注释）
 *   buildItemIndex(daily)                    → { repos, items, releases }（validate-summary 的 ctx 主体）
 *
 * 用法：const collected = collectSummaryData();
 *       const ctx = { ...buildItemIndex(collected.daily), missing: collected.missing };
 */

import { createHash } from "node:crypto";
import path from "node:path";

import { BACKFILL_DIR, DATA_DIR, cstDayMinus, dateRange, readJsonIfExists } from "../daily/lib/days.mjs";

// ---------------------------------------------------------------- 常量

const SUMMARY_COMMIT_MSG_CAP = 10; // 每仓库最多喂 10 条 commit message（总结口径；与日报同名上限只是巧合同值，不是同一口径）
const COMMIT_MSG_LEN = 160; // 每条 commit message 截断到 160 字符
const RELEASE_NOTES_LEN = 800; // 每条 release notes 最多 800 字符

/** 参与聚合的数组段；单日数据缺失这些段时按空数组处理（老数据 / 回填数据结构不全）。 */
const ARRAY_SECTIONS = [
  "commits",
  "pullRequests",
  "reviews",
  "issues",
  "discussions",
  "releases",
  "replies",
  "stateChanges",
];

// ---------------------------------------------------------------- 窗口

/**
 * 30 天窗口：起 = 今天往前 30 个 +08 自然日，止 = 昨天（今天未定稿不进窗口）。
 * 闭区间正好 30 天，与日报的 cstDayMinus 口径完全一致。
 */
export function summaryWindow() {
  return { start: cstDayMinus(30), end: cstDayMinus(1) };
}

// ---------------------------------------------------------------- 单日归一化

/** 把一份单日 JSON 归一化成聚合所需的段：totals 缺项补 0，数组段缺失补 []。 */
function normalizeDay(data) {
  const src = data && typeof data === "object" ? data : {};
  const t = src.totals && typeof src.totals === "object" ? src.totals : {};
  const out = {
    totals: {
      commits: Number(t.commits) || 0,
      prs: Number(t.prs) || 0,
      issues: Number(t.issues) || 0,
      reviews: Number(t.reviews) || 0,
    },
    automatedCommits: Number(src.automatedCommits) || 0,
  };
  for (const key of ARRAY_SECTIONS) out[key] = Array.isArray(src[key]) ? src[key] : [];
  return out;
}

/**
 * 喂给 AI 的 pr/issue/review 条目：只挑契约字段。
 * 刻意不带 comments —— AI 不许提评论数，从源头掐掉。
 */
function pickItem(e) {
  const out = {
    repo: e?.repo,
    number: e?.number,
    title: e?.title,
    action: e?.action,
    ts: e?.ts,
    own: e?.own,
  };
  if (e && e.state !== undefined) out.state = e.state; // 单日数据里有 state 就带上
  return out;
}

/** 按 ts 降序（最新在前）；ts 缺失排最后，同 ts 保持稳定顺序。 */
const byTsDesc = (a, b) => String(b?.ts || "").localeCompare(String(a?.ts || ""));

/** 每仓库条目计数（byRepo 段落引用的确定数字之一）；repo 为空的条目不计。 */
function bump(map, e) {
  const repo = String(e?.repo || "").trim();
  if (!repo) return;
  map.set(repo, (map.get(repo) || 0) + 1);
}

// ---------------------------------------------------------------- 聚合

/**
 * 聚合窗口内数据，返回：
 *   { windowStart, windowEnd, days, username, generatedAt, missing, totals, automatedCommits,
 *     sources, backfilled, backfillLimits, daily: [ { date, source, data } ], aiPayload, dataHash }
 *
 * totals / automatedCommits 是确定数字条（逐项 Number(...)||0 累加，绝不经 AI）；
 * aiPayload 只喂聚合条目（commits 按 repo 合并，其余段 30 天全量合并、按 ts 降序）
 * 外加由代码统计的每仓库数字 repos[]（byRepo 段落必须引用它，不许模型自己数）。
 *
 * dataDir / backfillDir 可覆盖：默认仓库里的 docs/data 与 data/backfill；
 * 确定性回归测试（scripts/summary/test-summary.mjs）指向临时假数据目录时用得上。
 */
export function collectSummaryData({ username, start, end, dataDir, backfillDir } = {}) {
  const win = summaryWindow();
  const windowStart = start || win.start;
  const windowEnd = end || win.end;
  const dates = dateRange(windowStart, windowEnd);
  const dailyDir = dataDir || DATA_DIR;
  const backfillSourceDir = backfillDir || BACKFILL_DIR;

  const daily = [];
  const sources = {};
  const backfilled = [];
  const backfillLimits = {};
  const missing = { days: 0, dates: [] };
  const totals = { commits: 0, prs: 0, issues: 0, reviews: 0 };
  const hashParts = []; // 每个存在日 "date:dataHash:source"（按窗口升序）
  const commitByRepo = new Map();
  const repoPrs = new Map();
  const repoIssues = new Map();
  const repoReviews = new Map();
  const repoReleases = new Map();
  const prItems = [];
  const issueItems = [];
  const reviewItems = [];
  const discussionItems = [];
  const replyItems = [];
  const stateItems = [];
  const releaseItems = [];
  let automatedCommits = 0;
  let dataUsername = "";

  for (const date of dates) {
    // docs/data 优先；两份都有时回填那份完全不读（定稿是真相源）
    const dailyJson = readJsonIfExists(path.join(dailyDir, `${date}.json`));
    const backfillJson = dailyJson
      ? null
      : readJsonIfExists(path.join(backfillSourceDir, `${date}.json`));
    const source = dailyJson ? "daily" : backfillJson ? "backfill" : null;
    if (!source) {
      missing.dates.push(date); // 窗口内没有数据文件的日期
      continue;
    }
    const data = source === "daily" ? dailyJson : backfillJson;
    const norm = normalizeDay(data);

    daily.push({ date, source, data });
    sources[date] = source;
    if (source === "backfill") backfilled.push(date);
    if (data.backfillLimits && typeof data.backfillLimits === "object") {
      backfillLimits[date] = data.backfillLimits;
    }
    hashParts.push(`${date}:${data.dataHash || ""}:${source}`);

    // 确定数字条：只在这里逐日求和，绝不经 AI
    totals.commits += norm.totals.commits;
    totals.prs += norm.totals.prs;
    totals.issues += norm.totals.issues;
    totals.reviews += norm.totals.reviews;
    automatedCommits += norm.automatedCommits;
    if (!dataUsername && data.username) dataUsername = String(data.username);

    // commits：按 repo 跨日合并（count / automated 累加，message 收集后统一截断）
    for (const c of norm.commits) {
      const repo = String(c?.repo || "").trim();
      if (!repo) continue;
      let cur = commitByRepo.get(repo);
      if (!cur) {
        cur = { repo, count: 0, automated: 0, messages: [] };
        commitByRepo.set(repo, cur);
      }
      cur.count += Number(c.count) || 0;
      cur.automated += Number(c.automated) || 0;
      for (const m of Array.isArray(c.messages) ? c.messages : []) {
        const text = String((m && typeof m === "object" ? m.message : m) ?? "")
          .trim()
          .slice(0, COMMIT_MSG_LEN);
        if (text) cur.messages.push(text);
      }
    }

    for (const pr of norm.pullRequests) {
      prItems.push(pickItem(pr));
      bump(repoPrs, pr);
    }
    for (const is of norm.issues) {
      issueItems.push(pickItem(is));
      bump(repoIssues, is);
    }
    for (const rv of norm.reviews) {
      reviewItems.push(pickItem(rv));
      bump(repoReviews, rv);
    }
    for (const dsc of norm.discussions) {
      discussionItems.push({
        repo: dsc?.repo,
        number: dsc?.number,
        title: dsc?.title,
        category: dsc?.category,
        action: dsc?.action,
        ts: dsc?.ts,
      });
    }
    for (const rp of norm.replies) {
      replyItems.push({
        repo: rp?.repo,
        number: rp?.number,
        author: rp?.author,
        kind: rp?.kind,
        ts: rp?.ts,
      });
    }
    for (const sc of norm.stateChanges) {
      stateItems.push({
        repo: sc?.repo,
        number: sc?.number,
        action: sc?.action,
        actor: sc?.actor,
        ts: sc?.ts,
      });
    }
    for (const rel of norm.releases) {
      releaseItems.push({
        repo: rel?.repo,
        tag: rel?.tag,
        name: rel?.name,
        notes: String(rel?.notes || "").slice(0, RELEASE_NOTES_LEN),
        publishedAt: rel?.publishedAt,
      });
      bump(repoReleases, rel);
    }
  }
  missing.days = missing.dates.length;

  // commits 聚合：按 count 降序，同数按仓库名升序（保证稳定复现）
  const commits = [...commitByRepo.values()]
    .map((c) => ({
      repo: c.repo,
      count: c.count,
      automated: c.automated,
      messages: c.messages.slice(0, SUMMARY_COMMIT_MSG_CAP),
    }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));

  const finalUsername = username || dataUsername;

  // 每仓库确定数字（全部由代码统计；AI 只许引用、不许自己数）。
  // 收录范围：commits / PR / issue / review / release 段里出现过的仓库（discussion / reply /
  // stateChange 不进 —— 这里只列有确定数字的仓库）。
  // 排序：活跃度（本人提交 + 条目数）降序，同分按仓库名升序（保证稳定复现）。
  const repoActivity = new Set([
    ...commitByRepo.keys(),
    ...repoPrs.keys(),
    ...repoIssues.keys(),
    ...repoReviews.keys(),
    ...repoReleases.keys(),
  ]);
  const repos = [...repoActivity]
    .map((repo) => {
      const c = commitByRepo.get(repo);
      return {
        repo,
        commits: c ? c.count : 0,
        automated: c ? c.automated : 0,
        prs: repoPrs.get(repo) || 0,
        issues: repoIssues.get(repo) || 0,
        reviews: repoReviews.get(repo) || 0,
        releases: repoReleases.get(repo) || 0,
      };
    })
    .sort((a, b) => {
      const wa = a.commits + a.prs + a.issues + a.reviews + a.releases;
      const wb = b.commits + b.prs + b.issues + b.reviews + b.releases;
      return wb - wa || a.repo.localeCompare(b.repo);
    });

  const aiPayload = {
    windowStart,
    windowEnd,
    username: finalUsername,
    days: dates.length,
    missing,
    totals,
    automatedCommits,
    repos,
    commits,
    pullRequests: prItems.sort(byTsDesc),
    issues: issueItems.sort(byTsDesc),
    reviews: reviewItems.sort(byTsDesc),
    discussions: discussionItems.sort(byTsDesc),
    replies: replyItems.sort(byTsDesc),
    stateChanges: stateItems.sort(byTsDesc),
    releases: releaseItems,
    backfillLimits,
  };

  // dataHash：窗口 + 各存在日的 date:dataHash:source（升序，| 连接）→ sha256，稳定复现
  const hashInput = `${windowStart}|${windowEnd}|${hashParts.join("|")}`;
  const dataHash = createHash("sha256").update(hashInput).digest("hex");

  return {
    windowStart,
    windowEnd,
    days: dates.length,
    username: finalUsername,
    generatedAt: new Date().toISOString(),
    missing,
    totals,
    automatedCommits,
    sources,
    backfilled,
    backfillLimits,
    daily,
    aiPayload,
    dataHash,
  };
}

// ---------------------------------------------------------------- 校验辅助

/**
 * 从真实单日数据（daily）建 repo / 条目 / release 集合 —— 校验器的唯一事实口径，
 * 绝不来自 AI 输出。items 的 key 是 `${repo}#${number}`，releases 的 key 是 `${repo}@@${tag}`。
 * 同 key 多条（不同 action）合并成一条，url 取第一条非空的。
 */
export function buildItemIndex(daily) {
  const repos = new Set();
  const items = new Map();
  const releases = new Map();
  const arr = (v) => (Array.isArray(v) ? v : []);

  const addItem = (e, kind) => {
    const repo = String(e?.repo ?? "").trim();
    const number = e?.number;
    if (!repo || number === undefined || number === null || number === "") return;
    const key = `${repo}#${number}`;
    const url = String(e?.url ?? "");
    const title = String(e?.title ?? "");
    const cur = items.get(key);
    if (!cur) {
      items.set(key, { repo, number, kind, title, url });
      return;
    }
    if (!cur.url && url) cur.url = url; // 合并：url 用第一条非空的
    if (!cur.title && title) cur.title = title;
  };

  for (const entry of Array.isArray(daily) ? daily : []) {
    const d = entry?.data;
    if (!d || typeof d !== "object") continue;

    // repos：所有喂给 AI 的段里出现过的真实仓库
    for (const key of ARRAY_SECTIONS) {
      for (const e of arr(d[key])) {
        const repo = String(e?.repo ?? "").trim();
        if (repo) repos.add(repo);
      }
    }

    // items：pr / issue / discussion 条目（url 取自单日数据里的真实 url）
    for (const e of arr(d.pullRequests)) addItem(e, "pr");
    for (const e of arr(d.issues)) addItem(e, "issue");
    for (const e of arr(d.discussions)) addItem(e, "discussion");

    // releases：repo+tag 精确键
    for (const r of arr(d.releases)) {
      const repo = String(r?.repo ?? "").trim();
      const tag = String(r?.tag ?? "").trim();
      if (!repo || !tag) continue;
      const key = `${repo}@@${tag}`;
      if (!releases.has(key)) releases.set(key, { url: String(r?.url ?? ""), repo, tag });
    }
  }

  return { repos, items, releases };
}
