#!/usr/bin/env node
/**
 * scripts/daily/lib/github.mjs
 * ------------------------------------------------------------------
 * 每日报告 · GitHub 数据采集（零依赖 ESM，Node 20+ 内置 fetch，风格对齐 scripts/generate-activity.mjs）。
 *
 * 数据源与职责：
 *   1. REST /users/:u/events/public      —— 窗口内动作级事件（PR / Issue / 评审 / 自己的评论），
 *                                          以及 PushEvent（用于发现要扫描提交历史的仓库）
 *   2. REST /repos/:o/:r/commits         —— 按提交日期归属：某仓窗口内的提交历史，
 *                                          拆成用户本人（含别名，见 COMMIT_AUTHOR_ALIASES）
 *                                          vs 机器人（[bot]）两类
 *   3. REST /users/:u/repos + releases    —— 自有仓库的 Release（published_at 落在窗口内）
 *   4. GraphQL repository.stargazerCount —— 自有仓库星标总数：全量存入 starInventory 作次日基准，
 *                                          展示的 stars 只列 delta 非 0 的变化项
 *   5. REST /search/issues + 评论列表     —— 定位我最近更新的条目（回复 / 状态变更共用，上限 25；
 *                                          Search 的 updated: 是 UTC 日历日而窗口是 +08 日历日，
 *                                          故查询下界放宽一天、按 updated 倒序取，再由本地 inWindow 精滤），
 *                                          以及他人在我 PR / Issue 下的回复（逐仓校验公开后才收录）
 *   6. REST /repos/:o/:r/issues/:n/events —— 他人对我条目的 closed / merged / reopened
 *                                          （stateChanges 段，不计入 totals）
 *   7. GraphQL search(type: DISCUSSION)   —— 我发起 / 我评论的 Discussions（discussions 段，
 *                                          action: started|commented），他人在我发起的讨论下的
 *                                          窗口内回复并入 replies（kind=discussion_comment）；
 *                                          仅公开仓库，不计入 totals / empty
 *
 * 窗口定义：date 当天 00:00:00+08:00 ≤ ts < 次日 00:00:00+08:00（Asia/Shanghai 固定 UTC+8，无夏令时）。
 *
 * totals 口径（公开日报恒等式）：totals 只由实际展示的公开数据求和得出 ——
 *   commits = Σcommits[].count（按提交日期归属的用户本人提交数，按仓库累计），
 *   prs/issues/reviews = 对应数组长度。
 *   automatedCommits（机器人提交）与条目 state 回填都不进 totals / empty。
 *   弃用 contributionsCollection：同一瞬间窗口用 +08:00 与 Z 表达会得到不同且错误的归因
 *   （提交会同时漏进相邻两天），且 user-scoped token 下含私有贡献 —— 本模块不再发起该查询；
 *   也弃用 PushEvent/compare 归属（推送时间 ≠ 提交时间会漏计），提交一律以提交历史日期为准。
 *
 * 错误策略：
 *   - 任何一段失败（401/403/404/限流/网络/GraphQL）→ 打警告 + 该段返回空数组，绝不抛错
 *   - 5xx / 网络异常重试 2 次（指数退避），所有分页/枚举均有硬上限
 *   - 仅 --date 格式非法时 CLI 报错退出
 *
 * 用法（CLI 冒烟）：
 *   node scripts/daily/lib/github.mjs --date=YYYY-MM-DD [--dump=path.json] [--force]
 *   环境变量 GITHUB_TOKEN 可选；无 token 也能跑公开数据（GraphQL 相关段自动降级）。
 *   CLI 会自动读取 docs/data/前一日.json 作为 stars delta 基准（缺失则按无基准处理），
 *   并读取当天已存的 docs/data/<date>.json 作为评论数快照（窗口已关闭时冻结，见 storedCommentCounts）；
 *   --force 跳过该快照冻结、直接取实时评论数（与 index.mjs 的 --force 语义对齐）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------- 环境与常量

const LOG = "[daily.github]";
const USER_AGENT = "sogeisetsu-daily-report";
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai 固定 +08:00，无夏令时

const EVENT_MAX_PAGES = 5; // 公共事件分页上限（per_page=100）
const EVENT_MAX = 300; // 事件总条数上限
const EVENT_PER_PAGE = 100;
const REPO_LIST_MAX_PAGES = 3; // 自有仓库列表分页上限（per_page=100）
const RELEASES_PER_PAGE = 30; // 每仓库 Release 只取一页
const RELEASE_SCAN_MAX = 100; // 扫描 Release 的仓库数硬上限（防失控）
const SEARCH_PER_PAGE = 50; // Search 每个查询取一页
const TARGET_MAX = 25; // “我发起的条目”检索上限（回复 / 状态变更两段共用）
const NOTES_MAX = 1400; // release notes 规范化后截断长度（保留换行以渲染 Markdown 结构）
const EXCERPT_MAX = 200; // 回复摘录折叠空白后截断长度
const COMMIT_SCAN_REPOS_MAX = 30; // 提交历史扫描的仓库数上限（PushEvent 仓库优先）
const COMMIT_PAGES_MAX = 2; // 每仓 /commits 分页上限（per_page=100）
const COMMIT_MSG_MAX = 160; // 提交标题（message 首行）折叠空白后的截断长度
// 提交归属别名：同一人可能用非 GitHub 账号邮箱提交（如本地配置的 suyue@localhost），
// 此时 REST /commits 的 author.login 为 null、commit.author.name 也不是 GitHub 登录名，
// 于是既匹配不上 username、也过不了 isBot，被当成“其他人类提交”丢弃。
// 这里列出的身份与 username 一并视为“本人”（大小写不敏感），仅用于提交归属判定。
const COMMIT_AUTHOR_ALIASES = ["suyue"];
const DISCUSSION_SEARCH_MAX = 50; // Discussion search 每个别名取的节点上限（GraphQL first ≤100）
const DISCUSSION_COMMENTS_MAX = 100; // 每条讨论拉取的评论节点上限（连接尾部=最新，comments(last: N)）
const REPLIES_PAGE_SIZE = 30; // /issues|pulls/:n/comments 单页大小（显式传 per_page，与截断判定一致）
const STATE_EVENTS_PAGE_SIZE = 100; // /issues/:n/events 单页大小（截断判定用）
const COMMENT_COUNT_MAX = 40; // 回填评论数的条目数上限（去重后的 repo#number）
// --- 历史回填（collectHistoricalData / Search 重建）专用常量 ---
const SEARCH_GAP_MS = 2100; // Search 查询之间的固定间隔：该端点限速约 30 次/分钟，留余量
const RATE_LIMIT_WAIT_MS = 60_000; // Search 403/429 限流后的退避时长
const BACKFILL_SEARCH_PER_PAGE = 100; // 回填的 Search 每查询取一页（单日动作量远小于 100，不做翻页）

// ---------------------------------------------------------------- 小工具

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 时间戳（毫秒）；解析失败回 0。 */
const tsOf = (value) => {
  const t = Date.parse(value ?? "");
  return Number.isFinite(t) ? t : 0;
};

/** 毫秒 → ISO UTC 字符串。 */
const isoOf = (ms) => new Date(ms).toISOString();

/** 折叠全部空白并截断（用于 excerpt 等单行文本）。 */
function collapse(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 规范化 release notes：保留换行与行首结构（Markdown 标题/列表），
 * 只去掉行尾空白、连续空行与零宽字符；行内多余空格折叠但绝不允许把换行并成一行。
 * 这样前端才能正确渲染 `## 标题`、`- 列表` 等结构。
 */
export function normalizeNotes(text, max) {
  let s = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function warn(section, message) {
  console.error(`${LOG} 警告(${section}): ${message}`);
}

function apiHeaders(token, extra = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    ...extra,
  };
  if (token) headers.authorization = `Bearer ${token}`;
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
      warn("http", `${lastError.message}，${backoff}ms 后重试（第 ${attempt + 1}/${retries} 次）`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

/**
 * REST GET：永远不抛错。
 * 成功返回 { data, link }；401/403/404/其它 4xx/重试耗尽/解析失败 → 打警告并返回 null。
 */
async function restGet(url, token, section) {
  try {
    const res = await httpFetch(url, { headers: apiHeaders(token) });
    const text = await res.text();
    if (res.status >= 400) {
      const hint =
        res.status === 401 || res.status === 403 || res.status === 404
          ? "（无权限或不存在，该段返回空）"
          : "";
      warn(section, `HTTP ${res.status}${hint}: ${url}`);
      return null;
    }
    try {
      return { data: JSON.parse(text), link: res.headers.get("link") || "" };
    } catch (err) {
      warn(section, `响应不是合法 JSON: ${err.message} (${url})`);
      return null;
    }
  } catch (err) {
    // httpFetch 重试耗尽（5xx / 网络异常）
    warn(section, `请求失败: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- 窗口计算

/** 解析 "YYYY-MM-DD" → [date, windowStart, windowEnd, startMs, endMs, startISO]（+08:00）。 */
function computeWindow(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  if (!m) throw new Error(`date 必须是 YYYY-MM-DD，收到: ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const startMs = Date.UTC(y, mo - 1, d) - TZ_OFFSET_MS; // 当天 00:00:00+08:00
  const endMs = Date.UTC(y, mo - 1, d + 1) - TZ_OFFSET_MS; // 次日 00:00:00+08:00（Date.UTC 自动进位）
  // 把 UTC 毫秒平移 8 小时后取 ISO，再把 Z 换成 +08:00，即得到带固定偏移的本地表示
  const withOffset = (ms) =>
    new Date(ms + TZ_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, "+08:00");
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    startISO: withOffset(startMs),
    endISO: withOffset(endMs),
    startMs,
    endMs,
  };
}

const inWindow = (ms, win) => ms >= win.startMs && ms < win.endMs;

// ---------------------------------------------------------------- 归属判断

const isOwnLogin = (login, username) =>
  String(login ?? "").toLowerCase() === String(username ?? "").toLowerCase();
const isOwnRepoName = (nameWithOwner, username) =>
  isOwnLogin(String(nameWithOwner ?? "").split("/")[0], username);

// ---------------------------------------------------------------- 1. 公共事件（动作级）

/**
 * 抓取公共事件：跟随 Link rel="next"，上限 5 页 / 300 条；失败返回已取部分（可能为空）。
 * 返回 { events, truncated }：truncated=true 表示“因撞上页数/条数上限而停”，
 * 窗口内事件可能没抓全；读到窗口起点之前而正常停不算截断。
 */
async function fetchPublicEvents(token, username, win) {
  const all = [];
  let hasNext = true;
  let truncated = false;
  for (let page = 1; page <= EVENT_MAX_PAGES && hasNext; page += 1) {
    if (all.length >= EVENT_MAX) {
      if (hasNext) truncated = true; // 已达事件总条数上限且仍有下一页
      break;
    }
    const url =
      `https://api.github.com/users/${encodeURIComponent(username)}` +
      `/events/public?per_page=${EVENT_PER_PAGE}&page=${page}`;
    const got = await restGet(url, token, "events");
    if (!got) return { events: all.slice(0, EVENT_MAX), truncated }; // 失败即止，保留已取部分
    const chunk = got.data;
    if (!Array.isArray(chunk)) {
      warn("events", `响应不是数组 (${url})`);
      return { events: all.slice(0, EVENT_MAX), truncated };
    }
    all.push(...chunk);
    if (chunk.length === 0) {
      hasNext = false;
      break;
    }
    // 跟随 Link header；没有 Link 时按“满页即还有下一页”推断
    hasNext = /rel="next"/.test(got.link) ? true : chunk.length === EVENT_PER_PAGE;
    // 事件按时间倒序：本页最后一条已早于窗口起点，后面不可能再有窗口内事件
    const oldest = tsOf(chunk[chunk.length - 1].created_at);
    if (oldest && oldest < win.startMs) {
      hasNext = false; // 正常读到窗口起点之前，不是截断
      break;
    }
  }
  // 循环因页数用尽而退出且仍有下一页 → 窗口内事件可能被丢
  if (hasNext) truncated = true;
  return { events: all.slice(0, EVENT_MAX), truncated };
}

/**
 * 把窗口内动作级事件映射为 pullRequests / reviews / issues 条目
 * （PushEvent 不在此处理，见 buildCommits）。
 */
function mapEvents(rawEvents, username, win) {
  const pullRequests = [];
  const reviews = [];
  const issues = [];
  const own = (repo) => isOwnRepoName(repo, username);

  for (const ev of rawEvents || []) {
    const ts = tsOf(ev.created_at);
    if (!inWindow(ts, win)) continue; // 只保留窗口内事件
    const repo = ev.repo && ev.repo.name;
    if (!repo) continue;
    const payload = ev.payload || {};

    if (ev.type === "PullRequestEvent") {
      const pr = payload.pull_request || {};
      let action = null;
      if (payload.action === "opened") action = "opened";
      else if (payload.action === "closed") action = pr.merged === true ? "merged" : "closed";
      if (!action) continue; // synchronize / reopened / labeled 等不计
      pullRequests.push({
        repo,
        number: pr.number ?? 0,
        title: pr.title || "",
        url: pr.html_url || `https://github.com/${repo}/pull/${pr.number ?? 0}`,
        action,
        ts: isoOf(ts),
        own: own(repo),
      });
    } else if (ev.type === "IssuesEvent") {
      if (payload.action !== "opened" && payload.action !== "closed") continue;
      const issue = payload.issue || {};
      issues.push({
        repo,
        number: issue.number ?? 0,
        title: issue.title || "",
        url: issue.html_url || `https://github.com/${repo}/issues/${issue.number ?? 0}`,
        action: payload.action,
        ts: isoOf(ts),
        own: own(repo),
      });
    } else if (ev.type === "PullRequestReviewEvent") {
      const pr = payload.pull_request || {};
      const submitted = tsOf(payload.review && payload.review.submitted_at) || ts;
      reviews.push({
        repo,
        number: pr.number ?? 0,
        title: pr.title || "",
        url: pr.html_url || `https://github.com/${repo}/pull/${pr.number ?? 0}`,
        ts: isoOf(submitted),
        own: own(repo),
      });
    } else if (ev.type === "IssueCommentEvent") {
      // 只记“自己评论了别人/自己的条目”（公共事件本就是该用户的，仍按 actor 复核）
      if (!isOwnLogin(ev.actor && ev.actor.login, username)) continue;
      const target = payload.pull_request || payload.issue || {};
      const comment = payload.comment || {};
      const number = target.number ?? 0;
      issues.push({
        repo,
        number,
        title: target.title || "",
        url:
          target.html_url ||
          comment.html_url ||
          `https://github.com/${repo}/issues/${number}`,
        action: "commented",
        ts: isoOf(ts),
        own: own(repo),
      });
    }
  }
  return { pullRequests, reviews, issues };
}

// ---------------------------------------------------------------- 2. 提交（按提交日期扫描仓库历史）

/**
 * 拉取某仓窗口内的提交历史：since / until 用窗口起止的真实 UTC ISO（不是 +08:00 串），
 * 跟随 Link rel="next" 最多 COMMIT_PAGES_MAX 页（per_page=100）；
 * 任何失败都返回 []（restGet 不抛错，已打警告）。
 */
async function fetchRepoCommits(token, owner, repoName, win) {
  const base =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}` +
    `/commits?since=${encodeURIComponent(new Date(win.startMs).toISOString())}` +
    `&until=${encodeURIComponent(new Date(win.endMs).toISOString())}&per_page=100`;
  const all = [];
  let url = base;
  for (let page = 1; page <= COMMIT_PAGES_MAX && url; page += 1) {
    const got = await restGet(url, token, "commits");
    if (!got) break; // 失败即止，已取部分仍可用（restGet 已打警告）
    const chunk = got.data;
    if (!Array.isArray(chunk)) break;
    all.push(...chunk);
    if (chunk.length === 0) break;
    const next = /<([^>]+)>;\s*rel="next"/.exec(got.link);
    url = next ? next[1] : null;
  }
  return all;
}

/**
 * 按提交日期归属统计各仓窗口内的提交（不再走 PushEvent / compare —— 推送时间 ≠ 提交时间会漏计）：
 * 扫描仓库集 = (a) 窗口内 PushEvent 的仓库（优先） + (b) ownRepos 中 pushed_at ≥ 窗口起点的仓库，
 * 按 owner/repo 去重、上限 COMMIT_SCAN_REPOS_MAX。
 * 逐条提交判定（合并提交整体排除：parents 多于 1 个的提交在归属判定与 sha 去重之前即跳过，
 * 既不算用户本人提交、也不算机器人提交，不产生 messages）：
 *   机器人（login / commit.author.name 以 [bot] 结尾，或 author.type === "Bot"）
 *     → automated += 1，身份 login || name 进 bots 集合；
 *   用户本人（login 或 commit.author.name 等于 username 或某别名 COMMIT_AUTHOR_ALIASES，忽略大小写）
 *     → count += 1，messages.push({sha, message 首行, ts})；
 *   其他人类提交 → 忽略。
 * ts = committer.date || author.date，必须落在窗口内（防御）；全局按 sha 去重。
 * count>0 或 automated>0 的仓库才进表；messages 按 ts 倒序，automatedBots 去重后排序。
 */
async function buildCommits(rawEvents, token, username, win, ownRepos) {
  // 本人身份集合（username + 别名，大小写不敏感）：提交归属判定用（见 COMMIT_AUTHOR_ALIASES）
  const me = new Set([username, ...COMMIT_AUTHOR_ALIASES].map((s) => String(s).toLowerCase()));
  // --- 扫描仓库集：(a) PushEvent 仓库优先，再补 (b) 窗口内推送过的自有仓库 ---
  const seenRepos = new Set();
  const queue = [];
  const addRepo = (full) => {
    if (!full || seenRepos.has(full) || queue.length >= COMMIT_SCAN_REPOS_MAX) return;
    const m = /^([^/]+)\/(.+)$/.exec(full);
    if (!m) return;
    seenRepos.add(full);
    queue.push({ owner: m[1], repoName: m[2], full });
  };
  for (const ev of rawEvents || []) {
    if (ev.type !== "PushEvent" || !inWindow(tsOf(ev.created_at), win)) continue;
    addRepo(ev.repo && ev.repo.name); // (a)
  }
  for (const r of ownRepos || []) {
    if (tsOf(r.pushed_at) < win.startMs) continue; // (b)
    addRepo(r.full_name || `${r.owner && r.owner.login}/${r.name}`);
  }

  const seenSha = new Set(); // 全局 sha 去重（fork 会带来同一提交出现在多个扫描仓库的情况）
  const entries = [];
  for (const { owner, repoName, full } of queue) {
    const list = await fetchRepoCommits(token, owner, repoName, win);
    if (list.length === 0) continue;
    const slot = { count: 0, messages: [], automated: 0, bots: new Set() };
    for (const c of list) {
      if (Array.isArray(c.parents) && c.parents.length > 1) continue; // 合并提交：不计用户也不计机器人
      const login = c.author?.login || "";
      const name = c.commit?.author?.name || "";
      const committerName = c.commit?.committer?.name || ""; // 规格要求采集（当前判定规则未用到）
      const isBot =
        /\[bot\]$/i.test(login) || /\[bot\]$/i.test(name) || c.author?.type === "Bot";
      const isUser = me.has(login.toLowerCase()) || me.has(name.toLowerCase());
      const ts = c.commit?.committer?.date || c.commit?.author?.date || "";
      if (!inWindow(tsOf(ts), win)) continue; // 防御：提交时间必须落在窗口内
      const sha = String(c.sha ?? "");
      if (!sha || seenSha.has(sha)) continue;
      seenSha.add(sha);
      if (isBot) {
        slot.automated += 1; // 机器人提交：只进 automated，不进 totals
        const who = login || name;
        if (who) slot.bots.add(who);
      } else if (isUser) {
        slot.count += 1;
        slot.messages.push({
          sha,
          message: collapse(String(c.commit?.message ?? "").split("\n")[0], COMMIT_MSG_MAX),
          ts,
        });
      }
      // 其他人类提交：忽略
    }
    if (slot.count > 0 || slot.automated > 0) {
      slot.messages.sort((a, b) => tsOf(b.ts) - tsOf(a.ts));
      entries.push({
        repo: full,
        count: slot.count,
        own: isOwnRepoName(full, username),
        messages: slot.messages,
        automated: slot.automated,
        automatedBots: [...slot.bots].sort(), // 去重 + 排序
      });
    }
  }
  return entries.sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}

// ---------------------------------------------------------------- 3. 自有仓库 + Release

/** 自有仓库列表：type=owner&sort=pushed，最多 3 页；失败返回 null。 */
async function fetchOwnRepos(token, username) {
  const repos = [];
  let hasNext = true;
  for (let page = 1; page <= REPO_LIST_MAX_PAGES && hasNext; page += 1) {
    const url =
      `https://api.github.com/users/${encodeURIComponent(username)}/repos` +
      `?per_page=100&type=owner&sort=pushed&page=${page}`;
    const got = await restGet(url, token, "repos");
    if (!got) return null; // 失败即止（restGet 已打警告）
    const chunk = got.data;
    if (!Array.isArray(chunk)) {
      warn("repos", `响应不是数组 (${url})`);
      return null;
    }
    repos.push(...chunk);
    if (chunk.length === 0) break;
    hasNext = /rel="next"/.test(got.link) ? true : chunk.length === 100;
  }
  return repos;
}

/** 窗口内的 Release：按 pushed 降序扫描，遇到窗口起点之前推送的仓库即截断 + 硬上限。 */
async function fetchReleases(token, username, repos, win) {
  const releases = [];
  if (!Array.isArray(repos)) return releases;
  let scanned = 0;
  for (const r of repos) {
    if (scanned >= RELEASE_SCAN_MAX) {
      warn("releases", `扫描仓库数达上限 ${RELEASE_SCAN_MAX}，后续仓库未检查`);
      break;
    }
    // 列表按 pushed 降序：发布 release 必然伴随推送，已早于窗口起点的仓库可安全截断
    const pushed = tsOf(r.pushed_at);
    if (pushed && pushed < win.startMs) break;
    scanned += 1;
    const full = r.full_name || `${r.owner && r.owner.login}/${r.name}`;
    const m = /^([^/]+)\/(.+)$/.exec(full);
    if (!m) continue;
    const url =
      `https://api.github.com/repos/${encodeURIComponent(m[1])}` +
      `/${encodeURIComponent(m[2])}/releases?per_page=${RELEASES_PER_PAGE}`;
    const got = await restGet(url, token, "releases");
    if (!got || !Array.isArray(got.data)) continue; // 单仓失败不拖垮整段
    for (const rel of got.data) {
      const publishedMs = tsOf(rel.published_at);
      if (!inWindow(publishedMs, win)) continue; // 草稿 published_at 为 null，自然被滤掉
      const tag = rel.tag_name || rel.name || "release";
      releases.push({
        repo: full,
        tag,
        name: rel.name || "",
        url: rel.html_url || `https://github.com/${full}/releases/tag/${tag}`,
        publishedAt: rel.published_at,
        notes: normalizeNotes(rel.body, NOTES_MAX),
      });
    }
  }
  releases.sort((a, b) => tsOf(b.publishedAt) - tsOf(a.publishedAt));
  return releases;
}

// ---------------------------------------------------------------- 4. 星标

/** 一个 GraphQL 查询、别名逐仓读 stargazerCount；失败返回 null（该段降级为空）。 */
async function fetchStarCounts(token, username, repos) {
  if (!token || !Array.isArray(repos) || repos.length === 0) return null;
  const aliases = [];
  const order = []; // 与别名一一对应，避免正则跳过仓库时下标错位
  for (const r of repos) {
    const full = r.full_name || `${r.owner && r.owner.login}/${r.name}`;
    const m = /^([^/]+)\/(.+)$/.exec(full);
    if (!m) continue;
    aliases.push(
      `repo${aliases.length}: repository(owner: ${JSON.stringify(m[1])}, name: ${JSON.stringify(m[2])}) { stargazerCount }`
    );
    order.push(full);
  }
  if (aliases.length === 0) return null;
  try {
    const res = await httpFetch("https://api.github.com/graphql", {
      method: "POST",
      headers: apiHeaders(token, { "content-type": "application/json" }),
      body: JSON.stringify({ query: `query { ${aliases.join("\n")} }` }),
    });
    const text = await res.text();
    if (res.status >= 400) {
      warn("stars", `GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
      return null;
    }
    const body = JSON.parse(text);
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      warn("stars", `errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
      return null;
    }
    const map = new Map();
    const data = body.data || {};
    order.forEach((full, i) => {
      const node = data[`repo${i}`];
      if (node && Number.isFinite(node.stargazerCount)) map.set(full, node.stargazerCount);
    });
    return map;
  } catch (err) {
    warn("stars", `请求失败: ${err.message}`);
    return null;
  }
}

/**
 * 全量星标清单：{repo, total} —— 不做任何过滤，持久化到日报里，
 * 供次日计算 delta 基准（只存有变化的仓库会让后续基准断档）。
 */
function buildStarInventory(starCounts) {
  const inventory = [];
  if (!starCounts) return inventory;
  for (const [repo, total] of starCounts) inventory.push({ repo, total });
  inventory.sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));
  return inventory;
}

/**
 * 组装展示用 stars：{repo, delta, total}，只保留“有变化”的仓库 ——
 * delta 不是数字（无上一日基准）或 delta === 0（无变化）的一律省略，避免整表噪音。
 * delta 基准优先取 previousData.starInventory（全量新格式），否则回退 previousData.stars（旧文件）。
 */
function buildStars(repos, starCounts, previousData) {
  const stars = [];
  if (!starCounts || !Array.isArray(repos)) return stars;
  let prevRows = [];
  if (Array.isArray(previousData?.starInventory) && previousData.starInventory.length > 0) {
    prevRows = previousData.starInventory;
  } else if (Array.isArray(previousData?.stars)) {
    prevRows = previousData.stars; // 旧格式文件回退
  }
  const prev = new Map(prevRows.map((s) => [s.repo, num(s.total)]));
  for (const r of repos) {
    const full = r.full_name || `${r.owner && r.owner.login}/${r.name}`;
    if (!starCounts.has(full)) continue;
    const total = starCounts.get(full);
    const delta = prev.has(full) ? total - prev.get(full) : null;
    if (typeof delta !== "number" || delta === 0) continue; // 无基准 / 无变化 → 不进表
    stars.push({ repo: full, delta, total });
  }
  stars.sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));
  return stars;
}

// ---------------------------------------------------------------- 5. 我的条目定位 + 他人回复

/**
 * 仓库是否确认公开（每仓只查一次，结果缓存；回复 / 状态变更两段共用同一份缓存）。
 * private === true 或 visibility 存在且非 "public" → 不公开；
 * 404 以及任何拿不到/读不懂响应的情形 → 一律按不公开处理（宁可少报，不可泄露）。
 */
async function isPublicRepo(owner, repoName, token, cache) {
  const key = `${owner}/${repoName}`;
  if (cache.has(key)) return cache.get(key);
  const got = await restGet(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
    token,
    "visibility"
  );
  let isPublic = false;
  if (got && got.data && typeof got.data === "object") {
    const d = got.data;
    const privateFlag = d.private === true;
    const nonPublicVisibility = typeof d.visibility === "string" && d.visibility !== "public";
    isPublic = !privateFlag && !nonPublicVisibility;
  }
  cache.set(key, isPublic);
  return isPublic;
}

/**
 * 「我发起的条目」检索的三个 query（回复与状态变更两段共用）。
 *
 * 日期下界：GitHub Search 的 `updated:` 只接受 UTC 日历日（= 当日 00:00Z = +08 的 08:00），
 * 而日报窗口是 +08 日历日 —— 直接用 win.date 会漏掉「+08 当天 00:00–08:00」被我更新的条目。
 * 故下界必须放宽一天（dayBefore(win.date)），出窗条目再由 filterTargetCandidates / orderTargetCandidates 本地处理。
 *
 * @param {string} username GitHub 用户名
 * @param {{date: string}} win computeWindow() 结果
 * @returns {string[]} [全量 / type:pr / type:issue] 三条 query
 */
export function buildTargetQueries(username, win) {
  const from = dayBefore(win.date); // Search 的 updated: 是 UTC 日历日，下界放宽一天
  return [
    `author:${username} updated:>=${from}`,
    `author:${username} updated:>=${from} type:pr`,
    `author:${username} updated:>=${from} type:issue`,
  ];
}

/**
 * 只剔掉「整体处于窗口起点之前」的条目：`updated_at >= win.startMs` 才保留。
 *
 * 为什么不能按 `inWindow(ms, win)` 过滤（回归原因）：`updated_at` 只是**最后一次**
 * 活动时间，它只证明「窗口之后还动过」，**不证明「窗口内没动过」** ——
 * 一个条目在窗口内收到回复、窗口关闭后又被人碰过一次，`updated_at` 就落在窗口之后，
 * 按 inWindow 过滤会把它整体滤掉，`fetchReplies` / `fetchStateChanges` 根本不去拉它，
 * 该条目在窗口内的回复与状态变更被静默删除。窗口后更新的条目必须保留，
 * 由 fetchReplies / fetchStateChanges 里既有的 `inWindow` 精滤出真正的行。
 *
 * `updated_at` 缺失 / 不可解析（tsOf 得 0）一律保留（宁多勿漏）。
 *
 * @param {object[]} items Search 命中的条目
 * @param {object} win computeWindow() 结果
 * @returns {object[]} 最后一次活动早于窗口起点的条目被剔除，其余保持原顺序
 */
export function filterTargetCandidates(items, win) {
  return (items || []).filter((item) => {
    const ms = tsOf(item && item.updated_at);
    return ms === 0 || ms >= win.startMs; // 只剔「最后一次活动早于窗口起点」的条目
  });
}

/**
 * 候选条目排序 + 切片（纯函数）：**窗口内更新的条目优先**，窗口之后更新的紧随其后，
 * 保证 TARGET_MAX 的 slice 先满足窗口内条目；两条都可能在窗口内有回复，
 * 所以窗口后的条目不是「丢弃」，只是「排后面」。
 * truncated：候选总数超过 max 被砍即为 true（被砍的两类都可能携带窗口内活动）。
 *
 * @param {object[]} items 候选条目（已过去早于窗口起点的条目）
 * @param {object} win computeWindow() 结果
 * @param {number} max 切片上限（TARGET_MAX）
 * @returns {{targets: object[], truncated: boolean}}
 */
export function orderTargetCandidates(items, win, max) {
  const primary = []; // updated_at 落在窗口内 / 不可解析
  const later = []; // updated_at 在窗口结束之后
  for (const item of items || []) {
    const ms = tsOf(item && item.updated_at);
    if (ms === 0 || ms < win.endMs) primary.push(item);
    else later.push(item);
  }
  const ordered = [...primary, ...later];
  return { targets: ordered.slice(0, max), truncated: ordered.length > max };
}

/**
 * Search API 定位“我发起的、可能携带窗口内活动”的 Issue / PR —— 回复与状态变更两段共用的目标列表：
 * 三个查询（全部 / type:pr / type:issue）合并去重后截断到 TARGET_MAX 条；某查询失败只跳过它。
 *
 * 日期下界见 buildTargetQueries；命中的条目先经 filterTargetCandidates 剔掉
 * 「最后一次活动早于窗口起点」的条目（**不再按 inWindow 过滤候选** —— `updated_at` 是最后一次
 * 活动时间，窗口后更新的条目仍可能携带窗口内的回复 / 状态变更，按 inWindow 滤会把它们整体
 * 静默删掉，这是回归原因），再并入去重 Map；结尾由 orderTargetCandidates 排序切片：
 * 窗口内更新的条目优先、窗口之后更新的紧随其后，保证 slice 先满足窗口内条目。
 *
 * 返回 { targets, truncated }：targets = 可能携带窗口内活动的条目（窗口内优先、窗口后次之）；
 * truncated 为真当且仅当：
 *   (a) 某查询整页取满、且该页最旧一条**没有越过窗口起点**（或不可解析，无法证明已越过）→ 后面可能还有窗口内条目；
 *   (b) 候选总数超过 TARGET_MAX 被 orderTargetCandidates 的 slice 砍掉
 *       （被砍的窗口内与窗口后条目都可能携带窗口内活动）。
 * 出窗（早于窗口起点）条目占满一页 / 被剔都不算截断，避免页面与 AI 输出「仅检查了前 25 条」的假提示。
 */
async function searchAuthoredTargets(token, username, win) {
  const queries = buildTargetQueries(username, win);
  const hits = new Map(); // key: repository_url#number 去重
  let truncated = false;
  for (const q of queries) {
    const url =
      `https://api.github.com/search/issues?q=${encodeURIComponent(q)}` +
      `&per_page=${SEARCH_PER_PAGE}&sort=updated&order=desc`;
    const got = await restGet(url, token, "search");
    if (!got) continue; // 无 token 常被限流：restGet 已警告，跳过本查询
    const items = got.data && got.data.items;
    if (!Array.isArray(items)) continue;
    const candidates = filterTargetCandidates(items, win);
    // 整页取满且该页最后一条（按 updated 倒序 = 最旧）没有越过窗口起点（或不可解析，无法证明已越过）
    // → 后面可能还有窗口内条目。注意判据是 `oldestMs >= win.startMs` 而不是 inWindow：
    // 重生成过去日期时整页可能全落在窗口**之后**，此时窗口内条目还在下一页，同样必须置真。
    const oldest = items.length > 0 ? items[items.length - 1] : null;
    const oldestMs = tsOf(oldest && oldest.updated_at);
    if (items.length >= SEARCH_PER_PAGE && (oldestMs === 0 || oldestMs >= win.startMs)) {
      truncated = true;
    }
    for (const item of candidates) {
      const key = `${item.repository_url || ""}#${item.number || 0}`;
      if (!hits.has(key)) hits.set(key, item);
    }
  }
  const ordered = orderTargetCandidates([...hits.values()], win, TARGET_MAX);
  return { targets: ordered.targets, truncated: truncated || ordered.truncated };
}

// ---------------------------------------------------------------- 5.5 历史回填：Search 重建动作段

/**
 * 一次 issues Search 查询（单页，不翻页）：403/429 限流时退避 60s 重试，最多 2 次；
 * 重试耗尽 / 任何失败 → 警告 + 返回 []，绝不抛错。
 * 为什么不直接用 restGet：限流重试要读响应头 x-ratelimit-remaining，而 restGet 把
 * 一切 4xx 归并成 null、拿不到状态细节，故这里自建一次轻量 fetch（5xx / 网络异常
 * 仍复用 httpFetch 的既有重试）。
 */
async function searchIssuesBackfill(q, token, section) {
  const url =
    `https://api.github.com/search/issues?q=${encodeURIComponent(q)}` +
    `&per_page=${BACKFILL_SEARCH_PER_PAGE}&sort=updated&order=desc`;
  const retries = 2;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await httpFetch(url, { headers: apiHeaders(token) });
    } catch (err) {
      warn(section, `请求失败: ${err.message}`); // httpFetch 重试耗尽（5xx / 网络异常）
      return [];
    }
    if (res.status === 403 || res.status === 429) {
      if (attempt < retries) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        warn(
          section,
          `HTTP ${res.status} 限流（x-ratelimit-remaining=${remaining ?? "?"}），` +
            `${RATE_LIMIT_WAIT_MS}ms 后重试（第 ${attempt + 1}/${retries} 次）`
        );
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      warn(section, `HTTP ${res.status} 限流重试耗尽，本查询返回空: ${q}`);
      return [];
    }
    const text = await res.text();
    if (res.status >= 400) {
      warn(section, `HTTP ${res.status}: ${url}`);
      return [];
    }
    try {
      const items = JSON.parse(text).items;
      return Array.isArray(items) ? items : [];
    } catch (err) {
      warn(section, `响应不是合法 JSON: ${err.message} (${url})`);
      return [];
    }
  }
  return [];
}

/** Search 结果条目 → "owner/repo"（从 repository_url 解析）；解析失败回空串。 */
function repoOfSearchItem(item) {
  const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(String(item && item.repository_url));
  return m ? `${m[1]}/${m[2]}` : "";
}

/**
 * 用 Search API 重建历史窗口内的动作段（PR / Issue 的开与关、我发的评论、我提交的评审）
 * —— 回填专用：公共事件流只保留最近 300 条 / 短窗口，离线日期已拿不到动作级事件
 * （2026-09-17 ~ 10-01 即撞上该限制），只能按日期区间用 issues Search 反查。
 *
 * 口径要点（与 mapEvents 逐条对齐）：
 *   - Search 的 created:/closed:/updated: 是 UTC 日历日，而窗口是 +08 日历日
 *     （= UTC [前一日 16:00, 当日 16:00)）——查询下界一律放宽一天，落库前逐条 inWindow 校时；
 *   - 带 token 的 Search 会返回私有仓库结果：每条都过 isPublicRepo 公开性闸门（共享缓存），
 *     非公开直接丢弃（宁可少报，不可泄露）；
 *   - 评论 / 评审段 Search 只能定位目标，动作时间要逐条 REST 拉评论 / 评审列表本地过滤；
 *     评论只走 issue comments（不处理 review comments），与 IssueCommentEvent 口径一致；
 *   - Search 查询之间 sleep(SEARCH_GAP_MS) 压限速；403/429 退避重试见 searchIssuesBackfill；
 *   - 同一 (repo, number, action, ts) 只保留一条（多个查询的结果会互相重叠）。
 *
 * @param {string|null} token GitHub token
 * @param {string} username GitHub 用户名
 * @param {object} win computeWindow() 结果
 * @param {Map<string, boolean>} repoVisibility 共享的仓库公开性缓存
 * @returns {Promise<{pullRequests: object[], reviews: object[], issues: object[]}>}
 */
async function rebuildActionsBySearch(token, username, win, repoVisibility) {
  const pullRequests = [];
  const reviews = [];
  const issues = [];
  const seen = new Set(); // repo#number+action+ts 去重（跨查询共享）
  const from = dayBefore(win.date); // 日期下界放宽一天（Search 是 UTC 日历日）
  const key = (repo, number, action, ms) => `${repo}#${number}+${action}+${ms}`;
  // 公开性闸门：非公开仓库整条丢弃（宁可少报，不可泄露）
  const isPublic = async (repo) => {
    const m = /^([^/]+)\/(.+)$/.exec(repo);
    return Boolean(m) && (await isPublicRepo(m[1], m[2], token, repoVisibility));
  };

  // --- 开 / 关四段：author: created: / author: closed: 反查，动作时间取 created_at / closed_at ---
  const actionQueries = [
    { q: `author:${username} created:${from}..${win.date} type:pr`, section: "search-pr", kind: "pr-opened" },
    {
      q: `author:${username} created:${from}..${win.date} type:issue`,
      section: "search-issue",
      kind: "issue-opened",
    },
    { q: `author:${username} closed:${from}..${win.date} type:pr`, section: "search-pr", kind: "pr-closed" },
    {
      q: `author:${username} closed:${from}..${win.date} type:issue`,
      section: "search-issue",
      kind: "issue-closed",
    },
  ];
  for (const { q, section, kind } of actionQueries) {
    const items = await searchIssuesBackfill(q, token, section);
    for (const item of items) {
      const repo = repoOfSearchItem(item);
      if (!repo || !(await isPublic(repo))) continue;
      const isPr = kind.startsWith("pr");
      let action;
      let tsStr;
      if (kind === "pr-opened" || kind === "issue-opened") {
        action = "opened";
        tsStr = item.created_at;
      } else if (kind === "pr-closed") {
        // merged_at 非空 ⇒ 这条 closed 实为合并（与 PullRequestEvent 的判定同源）
        action = item.pull_request && item.pull_request.merged_at ? "merged" : "closed";
        tsStr = item.closed_at;
      } else {
        action = "closed";
        tsStr = item.closed_at;
      }
      const ms = tsOf(tsStr);
      if (!ms || !inWindow(ms, win)) continue; // Search 日期限定是 UTC 天，逐条校时兜底
      const k = key(repo, item.number ?? 0, action, ms);
      if (seen.has(k)) continue;
      seen.add(k);
      const entry = {
        repo,
        number: item.number ?? 0,
        title: item.title || "",
        url: item.html_url || `https://github.com/${repo}/${isPr ? "pull" : "issues"}/${item.number ?? 0}`,
        action,
        ts: isoOf(ms),
        own: isOwnRepoName(repo, username),
      };
      if (isPr) pullRequests.push(entry);
      else issues.push(entry);
    }
    await sleep(SEARCH_GAP_MS); // 查询之间限速（Search 端点约 30 次/分钟）
  }

  // --- 评论段：commenter: 定位目标 → 逐条 REST 拉 issue comments，只留我窗口内的 ---
  {
    const items = await searchIssuesBackfill(
      `commenter:${username} updated:${from}..${win.date}`,
      token,
      "search-comments"
    );
    for (const item of items) {
      const repo = repoOfSearchItem(item);
      if (!repo || !(await isPublic(repo))) continue;
      const got = await restGet(
        `https://api.github.com/repos/${repo}` +
          `/issues/${item.number}/comments?since=${encodeURIComponent(win.startISO)}&per_page=100`,
        token,
        "search-comments"
      );
      if (!got || !Array.isArray(got.data)) continue;
      for (const c of got.data) {
        // 与 IssueCommentEvent 同口径：只认“我本人”的会话评论
        if (!isOwnLogin(c.user && c.user.login, username)) continue;
        const ms = tsOf(c.created_at);
        if (!ms || !inWindow(ms, win)) continue; // since 只是服务端预过滤，本地再兜一层
        const k = key(repo, item.number ?? 0, "commented", ms);
        if (seen.has(k)) continue;
        seen.add(k);
        issues.push({
          repo,
          number: item.number ?? 0,
          title: item.title || "",
          url: item.html_url || c.html_url || `https://github.com/${repo}/issues/${item.number ?? 0}`,
          action: "commented",
          ts: isoOf(ms),
          own: isOwnRepoName(repo, username),
        });
      }
    }
    await sleep(SEARCH_GAP_MS);
  }

  // --- 评审段：reviewed-by: 定位 PR → 逐条 REST 拉 reviews，只留我窗口内提交的（拉不到就空，不报错）---
  {
    const items = await searchIssuesBackfill(
      `reviewed-by:${username} updated:${from}..${win.date}`,
      token,
      "search-reviews"
    );
    for (const item of items) {
      const repo = repoOfSearchItem(item);
      if (!repo || !(await isPublic(repo))) continue;
      const got = await restGet(
        `https://api.github.com/repos/${repo}/pulls/${item.number}/reviews?per_page=100`,
        token,
        "search-reviews"
      );
      if (!got || !Array.isArray(got.data)) continue;
      for (const r of got.data) {
        if (!isOwnLogin(r.user && r.user.login, username)) continue; // 只要我提交的评审
        const ms = tsOf(r.submitted_at);
        if (!ms || !inWindow(ms, win)) continue;
        const k = key(repo, item.number ?? 0, "reviewed", ms);
        if (seen.has(k)) continue;
        seen.add(k);
        reviews.push({
          repo,
          number: item.number ?? 0,
          title: item.title || "",
          url: item.html_url || `https://github.com/${repo}/pull/${item.number ?? 0}`,
          ts: isoOf(ms),
          own: isOwnRepoName(repo, username),
        });
      }
    }
  }

  pullRequests.sort(byTsDesc);
  reviews.sort(byTsDesc);
  issues.sort(byTsDesc);
  return { pullRequests, reviews, issues };
}

/**
 * 他人的 PR / Issue 评论（回复我发的条目）：
 * 基于目标列表逐个拉评论 → 只保留非本人、且 created_at 落在窗口内的评论。
 * 任何 kind 的回复都必须先确认目标所在仓库公开（走共享缓存）。
 */
async function fetchReplies(token, username, win, targets, repoVisibility) {
  const replies = [];
  let truncated = false; // 任一 target 的评论超过一页（有下一页）→ 该段被截

  for (const t of targets) {
    const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(String(t.repository_url || ""));
    if (!m) continue;
    const owner = m[1];
    const repoName = m[2];
    const repo = `${owner}/${repoName}`;
    // 先过公开性闸门（对 issue_comment / review_comment 一律生效），非公开仓库整条跳过
    if (!(await isPublicRepo(owner, repoName, token, repoVisibility))) continue;
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
    const isPr = Boolean(t.pull_request);
    // Issue 只有会话评论；PR 同时拉会话评论 + 行内评审评论
    const endpoints = isPr
      ? [
          [`issues/${t.number}/comments`, "issue_comment"],
          [`pulls/${t.number}/comments`, "review_comment"],
        ]
      : [[`issues/${t.number}/comments`, "issue_comment"]];

    for (const [suffix, kind] of endpoints) {
      const url =
        `${base}/${suffix}?since=${encodeURIComponent(win.startISO)}` +
        `&per_page=${REPLIES_PAGE_SIZE}`;
      const got = await restGet(url, token, "replies");
      if (!got || !Array.isArray(got.data)) continue;
      if (/rel="next"/.test(got.link || "")) truncated = true; // 还有下一页，本页被截
      for (const c of got.data) {
        const author = (c.user && c.user.login) || "";
        if (isOwnLogin(author, username)) continue; // 只要别人说的
        const ms = tsOf(c.created_at);
        if (!inWindow(ms, win)) continue; // since 只是服务端预过滤，本地再兜一层
        replies.push({
          repo,
          number: t.number ?? 0,
          title: t.title || "",
          url: t.html_url || `${base}/issues/${t.number ?? 0}`,
          author,
          excerpt: collapse(c.body, EXCERPT_MAX),
          kind,
          ts: isoOf(ms),
          own: isOwnLogin(owner, username),
        });
      }
    }
  }
  replies.sort((a, b) => tsOf(b.ts) - tsOf(a.ts));
  return { replies, truncated };
}

// ---------------------------------------------------------------- 6. 他人状态变更

/**
 * 他人对我发起的 Issue / PR 做出的状态变更（closed / merged / reopened）：
 * 对每个目标拉 /issues/:n/events（每目标 1 次调用，≤ TARGET_MAX 次/轮），
 * 只保留窗口内、actor 非本人、且仓库通过公开性闸门的事件；按 repo+number+action+ts 去重。
 * 不计入 totals（totals 仍只有 commits / prs / issues / reviews 四项）。
 */
async function fetchStateChanges(token, username, win, targets, repoVisibility) {
  const changes = [];
  const seen = new Set(); // repo+number+action+ts 去重
  let truncated = false; // 任一 target 的事件超过一页（有下一页）→ 该段被截
  for (const t of targets) {
    const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(String(t.repository_url || ""));
    if (!m) continue;
    const owner = m[1];
    const repoName = m[2];
    const repo = `${owner}/${repoName}`;
    // 与回复同一道公开性闸门（共享缓存，正常情况下不再发额外请求）
    if (!(await isPublicRepo(owner, repoName, token, repoVisibility))) continue;
    const isPr = Boolean(t.pull_request);
    const url =
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}` +
      `/issues/${t.number}/events?per_page=${STATE_EVENTS_PAGE_SIZE}`;
    const got = await restGet(url, token, "state");
    if (!got || !Array.isArray(got.data)) continue;
    if (/rel="next"/.test(got.link || "")) truncated = true; // 还有下一页，本页被截
    for (const ev of got.data) {
      const type = String(ev.event || "");
      let action = null;
      if (type === "merged") {
        action = "merged"; // 显式 merged 事件类型
      } else if (type === "closed") {
        // PR 的 closed 带 commit_id ⇒ 实为合并；Issue 的 closed 就是关闭
        action = isPr && ev.commit_id != null ? "merged" : "closed";
      } else if (type === "reopened") {
        action = "reopened";
      } else {
        continue; // assigned / labeled / commented 等不计
      }
      const ms = tsOf(ev.created_at);
      if (!inWindow(ms, win)) continue;
      const actor = (ev.actor && ev.actor.login) || "";
      if (!actor || isOwnLogin(actor, username)) continue; // 只要他人的操作
      const key = `${repo}#${t.number}+${action}+${ms}`;
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push({
        repo,
        number: t.number ?? 0,
        title: t.title || "",
        url: t.html_url || `https://github.com/${repo}/issues/${t.number ?? 0}`,
        action,
        actor,
        ts: isoOf(ms),
        own: isOwnLogin(owner, username),
      });
    }
  }
  changes.sort((a, b) => tsOf(b.ts) - tsOf(a.ts));
  return { changes, truncated };
}

/**
 * 把 items 按 `${repo}#${number}` 分组（评论数回填的去重 + 上限逻辑，纯函数）：
 * 非法行（非对象 / 缺 repo / number 非正整数）直接跳过；
 * 同一 key 的所有条目（如「开启」与「评论」两行）合成一个 group，共享同一计数。
 * key 数超过 max 时只保留前 max 个并置 capped=true（打不打警告由调用方决定）。
 *
 * @param {object[]} items [...issues, ...pullRequests]（可含重复 repo#number）
 * @param {number} max key 数上限（COMMENT_COUNT_MAX）
 * @returns {{groups: Map<string, {repo: string, number: number, items: object[]}>,
 *           keys: string[], capped: boolean}}
 */
export function groupCommentCountTargets(items, max) {
  const groups = new Map(); // key → {repo, number, items[]}
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const repo = typeof item.repo === "string" ? item.repo : "";
    const number = Number(item.number);
    if (!repo || !Number.isInteger(number) || number <= 0) continue;
    const key = `${repo}#${number}`;
    if (!groups.has(key)) groups.set(key, { repo, number, items: [] });
    groups.get(key).items.push(item);
  }
  const all = [...groups.keys()];
  const capped = all.length > max;
  return { groups, keys: capped ? all.slice(0, max) : all, capped };
}

/**
 * 该行是否 PR：issues 数组里可能混入 PR 行 —— IssueCommentEvent 命中 PR 时带
 * payload.pull_request，条目 url 指向 `.../pull/<n>` 而非 `.../issues/<n>`。
 */
export function isPullRow(item) {
  const url = item && typeof item.url === "string" ? item.url : "";
  return /\/pull\/\d+/.test(url);
}

/**
 * 评论总数：Issue = 会话评论；PR = 会话评论 + 行内评审评论
 * （与 fetchReplies 对 PR 同时收 issue_comment + review_comment 的口径对齐）。
 * 两项都取不到有限数字 → null；**不用 0 兜底**，否则「取不到」会被伪装成「0 条评论」。
 *
 * @param {object|null} payload `/issues/:n` 或 `/pulls/:n` 的响应体
 * @param {boolean} pull 该行是否 PR（true 时才把 review_comments 计入）
 * @returns {number|null}
 */
export function commentTotalOf(payload, pull) {
  const p = payload && typeof payload === "object" ? payload : {};
  const issueCount = Number.isFinite(p.comments) ? p.comments : null;
  const reviewCount = pull && Number.isFinite(p.review_comments) ? p.review_comments : null;
  if (issueCount === null && reviewCount === null) return null;
  return (issueCount ?? 0) + (reviewCount ?? 0);
}

/**
 * 已存日报里的评论数快照：`repo#number` → 计数（只收有限数字）。
 *
 * 用途（与 stars 用 previousData 做 delta 基准同一模式）：窗口已关闭的定稿日
 * 重采集时（cron 会把「昨天」再跑一轮、`workflow_dispatch --date=` 可跑任意日期）
 * 直接复用磁盘上已存的计数，不再打实时接口 —— 否则评论数会随采集时刻漂移，
 * 改写已定稿页面、击穿「无变化跳过 AI 与写入」的不变量，还会跨天重复计数。
 * 首次生成（该日期无已存数据）或旧数据无 comments 字段时快照为空 → 该 key 自然实时取一次。
 *
 * @param {object|null} existingData 该日期磁盘上已存的 docs/data/<date>.json 解析结果
 * @returns {Map<string, number>}
 */
export function storedCommentCounts(existingData) {
  const map = new Map();
  if (!existingData || typeof existingData !== "object") return map;
  for (const k of ["issues", "pullRequests"]) {
    for (const row of Array.isArray(existingData[k]) ? existingData[k] : []) {
      if (!row || typeof row !== "object") continue;
      const repo = typeof row.repo === "string" ? row.repo : "";
      const number = Number(row.number);
      if (!repo || !Number.isInteger(number) || number <= 0) continue;
      const c = row.comments;
      if (typeof c !== "number" || !Number.isFinite(c)) continue;
      map.set(`${repo}#${number}`, c);
    }
  }
  return map;
}

/**
 * 回填 Issue / PR 行的评论总数（就地修改 items，返回写入条数）：
 * 公共事件 payload 里的 comments 是事件发生时刻的旧值（新开的 issue 恒为 0），不能直接用，
 * 这里按 `${repo}#${number}` 去重后逐条读取，同 key 的所有条目（如「开启」与「评论」两行）共享同一计数：
 *   - Issue 行 → `GET /repos/:o/:r/issues/:n` 的 `comments`（会话评论）；
 *   - PR 行（同 key 任一条目是 PR 即按 PR 口径）→ `GET /repos/:o/:r/pulls/:n`，
 *     计数 = `comments + review_comments`（与 Replies 段 issue_comment + review_comment 对齐）。
 * 契约：
 *   - options.frozen（Map|null）命中 key → 直接写该快照值并跳过，**不发任何网络请求**
 *     （包括不调 isPublicRepo）—— 定稿日冻结，见 storedCommentCounts；
 *   - 其余每个 key 先过公开性闸门（isPublicRepo，复用同一份 repoVisibility 缓存），非公开直接跳过且不设字段；
 *   - 任何失败（restGet 返回 null、评论总数取不到有限数字）→ 不设置该字段（属性保持不存在，
 *     不写 null/undefined），restGet 已打警告、不重复 warn，也绝不抛错；
 *   - 去重后超过 COMMENT_COUNT_MAX 个 key 时只处理前 N 个并打一行警告（不新增 truncated 键）；
 *   - 只用于展示：不调 applyEndStates、不动 totals。
 * @param {string|null} token GitHub token
 * @param {object[]} items [...issues, ...pullRequests]（可含重复 repo#number）
 * @param {Map<string, boolean>} repoVisibility 共享的仓库公开性缓存
 * @param {{frozen?: Map<string, number>|null}} [options] frozen：已存日报的评论数快照
 *   （storedCommentCounts() 结果），命中的 key 用快照值而非实时值
 * @returns {Promise<number>} 写入 comments 字段的条目数
 */
export async function attachCommentCounts(token, items, repoVisibility, options = {}) {
  const frozen = (options && options.frozen) || null;
  const { groups, keys, capped } = groupCommentCountTargets(items, COMMENT_COUNT_MAX);
  if (capped) {
    warn(
      "commentCounts",
      `去重后 ${groups.size} 个条目超过上限 ${COMMENT_COUNT_MAX}，只回填前 ${COMMENT_COUNT_MAX} 个`
    );
  }

  let written = 0;
  for (const key of keys) {
    const g = groups.get(key);
    // 快照冻结：命中即写、立即 continue，全程不碰网络（含公开性查询）
    if (frozen && frozen.has(key)) {
      for (const item of g.items) {
        item.comments = frozen.get(key);
        written += 1;
      }
      continue;
    }
    const m = /^([^/]+)\/(.+)$/.exec(g.repo);
    if (!m) continue;
    const owner = m[1];
    const repoName = m[2];
    // 与回复 / 状态变更同一道公开性闸门（共享缓存，正常情况下不再发额外请求）
    if (!(await isPublicRepo(owner, repoName, token, repoVisibility))) continue;
    const isPull = g.items.some(isPullRow); // 任一行是 PR → 按 PR 口径
    const got = await restGet(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}` +
        `/${isPull ? "pulls" : "issues"}/${g.number}`,
      token,
      "commentCounts"
    );
    const n = commentTotalOf(got && got.data, isPull);
    if (n === null) continue; // restGet 已警告，不重复 warn
    for (const item of g.items) {
      item.comments = n;
      written += 1;
    }
  }
  return written;
}

/**
 * 把“他人在窗口内的状态变更”回填为条目在窗口结束时刻的状态（原地修改，action 不动）：
 * - stateByKey：按 `${repo}#${number}` 取 ts 最新的一条状态变更；
 * - 有他人变更：reopened → "open"，否则用变更动作本身（"closed" / "merged"）；
 * - 无变更：按条目自身事件动作推导 opened → "open"、closed → "closed"、merged → "merged"；
 * - commented 等无法确定的动作不设置 state（属性保持不存在，而不是 undefined）。
 */
function applyEndStates(issues, pullRequests, stateChanges) {
  const stateByKey = new Map();
  for (const c of stateChanges || []) {
    const key = `${c.repo}#${c.number}`;
    const prev = stateByKey.get(key);
    if (!prev || tsOf(c.ts) > tsOf(prev.ts)) stateByKey.set(key, c);
  }
  const resolve = (item) => {
    const change = stateByKey.get(`${item.repo}#${item.number}`);
    if (change) return change.action === "reopened" ? "open" : change.action;
    if (item.action === "opened") return "open";
    if (item.action === "closed") return "closed";
    if (item.action === "merged") return "merged";
    return null; // commented / 未知动作 → 不设置 state
  };
  for (const item of [...(pullRequests || []), ...(issues || [])]) {
    const state = resolve(item);
    if (state === "open" || state === "closed" || state === "merged") item.state = state;
  }
}

// ---------------------------------------------------------------- 排序与汇总

const byTsDesc = (a, b) => tsOf(b.ts) - tsOf(a.ts);

// ---------------------------------------------------------------- 7.5 Discussions

/**
 * 我参与的 Discussions：一个 GraphQL 请求、两个 search 别名（节点内嵌评论）。
 *   started   — author:<me> created:<UTC日期范围>：窗口内我发起的讨论（action:"started"）
 *   commented — commenter:<me> updated:>=<前一天>：我评论过的讨论，取我窗口内的评论时间
 *               （action:"commented"；已按“发起”收录的同一讨论不重复收录）
 * 同时把他人在我发起的讨论下的窗口内评论转成 replies 条目（kind=discussion_comment）——
 * 与 issue/PR 回复的既有语义一致：只收“别人在我发起的条目下说的话”。
 *
 * 口径与降级：仅公开仓库（repository.isPrivate 直接过滤，不发额外请求）；
 * created:/updated: 是 UTC 日期，查询范围放宽一天后由 inWindow 按 +08 窗口精滤；
 * 无 token 或任何失败 → 警告 + 空，绝不抛错（与 GraphQL 星标段同一契约）；
 * 评论节点按连接尾部取最后 DISCUSSION_COMMENTS_MAX 条（最新在内），超长讨论可能截断（可接受降级）。
 *
 * @param {string|null} token GitHub token（null → 直接空）
 * @param {string} username GitHub 用户名
 * @param {object} win computeWindow() 结果
 * @returns {Promise<{list: object[], replies: object[]}>}
 *   list:    [{repo,number,title,url,category,comments,action,ts,own}]（action: started|commented，ts 倒序）
 *   replies: [{repo,number,title,url,author,excerpt,kind:"discussion_comment",ts,own}]（ts 倒序）
 */
async function fetchDiscussions(token, username, win) {
  const empty = { list: [], replies: [] };
  if (!token) return empty;

  // +08 窗口 = UTC [前一日 16:00, 当日 16:00)：查询日期下界放宽到前一天，本地再精滤
  const from = dayBefore(win.date);
  const query = `
    query ($qs: String!, $qc: String!) {
      started: search(query: $qs, type: DISCUSSION, first: ${DISCUSSION_SEARCH_MAX}) {
        nodes { ...D }
      }
      commented: search(query: $qc, type: DISCUSSION, first: ${DISCUSSION_SEARCH_MAX}) {
        nodes { ...D }
      }
    }
    fragment D on Discussion {
      number
      title
      url
      createdAt
      category { name }
      repository { nameWithOwner isPrivate }
      comments(last: ${DISCUSSION_COMMENTS_MAX}) {
        totalCount
        nodes { author { login } createdAt body }
      }
    }`;
  const variables = {
    qs: `author:${username} created:${from}..${win.date}`,
    qc: `commenter:${username} updated:>=${from}`,
  };

  let body;
  try {
    const res = await httpFetch("https://api.github.com/graphql", {
      method: "POST",
      headers: apiHeaders(token, { "content-type": "application/json" }),
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (res.status >= 400) {
      warn("discussions", `GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
      return empty;
    }
    body = JSON.parse(text);
  } catch (err) {
    warn("discussions", `请求失败: ${err.message}`);
    return empty;
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    // 部分数据仍可用：有 data 就继续，没有则降级为空
    warn("discussions", `errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
    if (!body.data) return empty;
  }

  const nodesOf = (alias) =>
    (((body.data || {})[alias] || {}).nodes || []).filter(
      (n) => n && n.number != null && n.repository && n.repository.nameWithOwner
    );

  const list = new Map(); // repo#number → 条目（发起优先，评论去重）
  const replies = [];
  const entryOf = (node, repo, action, tsMs) => ({
    repo,
    number: node.number,
    title: String(node.title || ""),
    url: node.url || `https://github.com/${repo}/discussions/${node.number}`,
    category: String((node.category && node.category.name) || ""),
    comments: num(node.comments && node.comments.totalCount),
    action,
    ts: isoOf(tsMs),
    own: isOwnRepoName(repo, username),
  });

  // --- started：我发起的讨论 + 他人的窗口内回复（并入 replies）---
  for (const node of nodesOf("started")) {
    const repo = node.repository.nameWithOwner;
    if (node.repository.isPrivate) continue; // 公开口径：私有仓库讨论整条跳过
    const created = tsOf(node.createdAt);
    if (!inWindow(created, win)) continue; // search 日期是 UTC 天，本地精滤 +08 窗口
    list.set(`${repo}#${node.number}`, entryOf(node, repo, "started", created));
    for (const c of (node.comments && node.comments.nodes) || []) {
      const author = (c && c.author && c.author.login) || "";
      if (isOwnLogin(author, username)) continue; // 只要别人说的
      const ms = tsOf(c && c.createdAt);
      if (!inWindow(ms, win)) continue;
      replies.push({
        repo,
        number: node.number,
        title: String(node.title || ""),
        url: node.url || `https://github.com/${repo}/discussions/${node.number}`,
        author,
        excerpt: collapse(c.body, EXCERPT_MAX),
        kind: "discussion_comment",
        ts: isoOf(ms),
        own: isOwnRepoName(repo, username),
      });
    }
  }

  // --- commented：我评论过的别人讨论（取我窗口内最新一条评论的时间）---
  for (const node of nodesOf("commented")) {
    const repo = node.repository.nameWithOwner;
    if (node.repository.isPrivate) continue;
    const key = `${repo}#${node.number}`;
    if (list.has(key)) continue; // 已按“发起”收录（自己讨论下自己回复不重复计）
    let myTs = 0;
    for (const c of (node.comments && node.comments.nodes) || []) {
      if (!isOwnLogin(c && c.author && c.author.login, username)) continue;
      const ms = tsOf(c && c.createdAt);
      if (inWindow(ms, win) && ms > myTs) myTs = ms;
    }
    if (!myTs) continue; // updated 命中但我的评论不在窗口内
    list.set(key, entryOf(node, repo, "commented", myTs));
  }

  const listArr = [...list.values()].sort(byTsDesc);
  replies.sort(byTsDesc);
  return { list: listArr, replies };
}

/**
 * 采集指定日（Asia/Shanghai）的 GitHub 活动数据。
 *
 * 窗口 = [date 00:00:00+08:00, 次日 00:00:00+08:00)。
 * 数据为公开口径：totals 恒等于实际展示的各段之和；提交数由公共 PushEvent 汇总
 * （contributionsCollection 对 +08:00 / Z 窗口归因不一致且含私有贡献，已彻底弃用）。
 * 任何一段失败都只打警告并返回空数组，绝不抛错。
 *
 * @param {object} opts 采集参数
 * @param {string|null} opts.token GitHub token（可为 null：GraphQL 星标段降级为空）
 * @param {string} opts.username GitHub 用户名（如 "sogeisetsu"）
 * @param {string} opts.date 报告日，格式 "YYYY-MM-DD"（Asia/Shanghai 日历日）
 * @param {object|null} opts.previousData 前一日 docs/data/YYYY-MM-DD.json 解析结果（星标 delta 基准：
 *   优先用其 starInventory，缺失时回退 stars），可为 null
 * @param {object|null} opts.existingData 该日期**磁盘上已存**的 docs/data/<date>.json 解析结果（可为 null）。
 *   仅用于评论数快照冻结：`win.endMs <= Date.now()`（窗口已关闭的定稿日）时按
 *   storedCommentCounts(existingData) 冻结，重采集不再打实时接口，避免评论数随采集时刻漂移
 *   改写定稿页面 / 击穿「无变化跳过」不变量 / 跨天重复计数；「今天」滚动报窗口未关，仍取实时值；
 *   首次生成或旧数据无 comments 字段时快照为空 → 自然实时取一次。
 * @returns {Promise<object>} 固定 shape 的日报数据，每个 key 恒存在、数组可为空：
 *   { date, windowStart, windowEnd, username, generatedAt, empty,
 *     totals:{commits,prs,issues,reviews},   // = Σcommits[].count（仅用户提交）及各数组长度
 *     commits:[{repo,count,own,messages:[{sha,message,ts}],automated,automatedBots:[login]}],
 *                                             // 按提交日期扫描仓库历史（REST commits since/until，
 *                                             // 真实 UTC ISO）；messages 为用户提交标题（ts 倒序），
 *                                             // 全局 sha 去重；automated = 机器人提交数，
 *                                             // automatedBots = 机器人身份（去重排序）
 *     automatedCommits:number,                // = Σcommits[].automated（不进 totals / empty）
 *     pullRequests:[{repo,number,title,url,action,ts,own,state?,comments?}],
 *                                             // comments: 该条目的评论总数（窗口已关闭的定稿日=已存 JSON 快照，
 *                                             // 否则 REST 实时值；PR＝会话评论+行内评审评论，Issue＝会话评论；
 *                                             // 含机器人与本人，仅展示、不进 totals；仓库非公开或读取失败时不设该字段）
 *     reviews:[{repo,number,title,url,ts,own}],
 *     issues:[{repo,number,title,url,action,ts,own,state?,comments?}],   // state: open|closed|merged，窗口末时刻；
 *                                                              // 由他人的状态变更或自身动作推导，可缺省；
 *                                                              // comments 同 pullRequests（可缺省）
 *     releases:[{repo,tag,name,url,publishedAt,notes}],   // notes: 规范化 Markdown（保留换行，≤1400 字符）
 *     stars:[{repo,delta,total}],            // 展示用：仅 delta 为数字且非 0 的仓库
 *     starInventory:[{repo,total}],          // 全量自有仓库星标清单（供次日 delta 基准，不过滤）
 *     replies:[{repo,number,title,url,author,excerpt,kind,ts,own}],   // 仅公开仓库；kind 含
 *                                                                     // issue_comment/review_comment/
 *                                                                     // discussion_comment
 *     stateChanges:[{repo,number,title,url,action,actor,ts,own}],     // action: closed|merged|reopened
 *                                                                     // 他人操作，actor 恒非本人；不计入 totals
 *     truncated:{events,targets,replies,stateChanges},  // 每项 {cap:number,hits:boolean}；hits=true 表示
 *                                                        // 该段因人工上限只采集/展示了部分数据（恒存在）
 *     discussions:[{repo,number,title,url,category,comments,action,ts,own}] }
 *                                                                     // action: started|commented（我的动作，
 *                                                                     // ts 为动作时间）；comments=评论总数；
 *                                                                     // 仅公开仓库；不计入 totals / empty
 */
export async function collectDailyData({ token, username, date, previousData, existingData }) {
  const win = computeWindow(date);

  // --- 1. 公共事件（窗口过滤；事件流本身就是公开数据）---
  const { events: rawEvents, truncated: eventsTruncated } = await fetchPublicEvents(
    token,
    username,
    win
  );
  const { pullRequests, reviews, issues } = mapEvents(rawEvents, username, win);
  pullRequests.sort(byTsDesc);
  reviews.sort(byTsDesc);
  issues.sort(byTsDesc);

  // --- 2. 自有仓库（提交扫描 / Release / 星标三段共用）---
  const ownRepos = await fetchOwnRepos(token, username);

  // --- 3. 提交：按提交日期扫描仓库历史，拆分用户本人 vs 机器人 ---
  const commits = await buildCommits(rawEvents, token, username, win, ownRepos);

  // --- 4. 自有仓库 → Release ---
  const releases = await fetchReleases(token, username, ownRepos, win);

  // --- 5. 星标：全量清单持久化 + 展示仅列有变化的 ---
  const starCounts = await fetchStarCounts(token, username, ownRepos);
  const starInventory = buildStarInventory(starCounts);
  const stars = buildStars(ownRepos, starCounts, previousData);

  // --- 6. 我发起的条目（Search 定位，回复与状态变更共用同一目标列表与公开性缓存）---
  const { targets, truncated: targetsTruncated } = await searchAuthoredTargets(token, username, win);
  const repoVisibility = new Map(); // 仓库公开性缓存（每仓只查一次，两段共用）
  const { replies, truncated: repliesTruncated } = await fetchReplies(
    token,
    username,
    win,
    targets,
    repoVisibility
  );

  // --- 7. 他人对我 Issue/PR 的状态变更（closed / merged / reopened，不计入 totals）---
  const { changes: stateChanges, truncated: stateChangesTruncated } = await fetchStateChanges(
    token,
    username,
    win,
    targets,
    repoVisibility
  );

  // --- 8. Discussions：我发起 / 我评论的讨论；他人对我讨论的回复并入 replies（不进 totals）---
  const { list: discussions, replies: discussionReplies } = await fetchDiscussions(
    token,
    username,
    win
  );
  if (discussionReplies.length) {
    replies.push(...discussionReplies);
    replies.sort(byTsDesc);
  }

  // --- 9. 端点状态回填：以窗口结束时刻为准，原地写入 issues / pullRequests 的 state ---
  applyEndStates(issues, pullRequests, stateChanges);

  // --- 10. 评论数回填：issues / PR 行的评论总数（仅展示，不进 totals；非公开或读失败则不设字段）---
  // 定稿日冻结：窗口已关闭才用已存 JSON 的评论数快照（否则重采集会漂移改写定稿页面）；
  // 「今天」滚动报窗口未关，仍取实时值。见 storedCommentCounts。
  const frozenComments = win.endMs <= Date.now() ? storedCommentCounts(existingData) : null;
  const written = await attachCommentCounts(token, [...issues, ...pullRequests], repoVisibility, {
    frozen: frozenComments,
  });
  if (written > 0) console.log(`${LOG} 评论数回填: ${written} 行`);

  // --- 合计：只由实际展示的公开数据求和，保证 totals 与各段恒等 ---
  const totals = {
    commits: commits.reduce((sum, c) => sum + c.count, 0),
    prs: pullRequests.length,
    issues: issues.length,
    reviews: reviews.length,
  };
  const empty = totals.commits + totals.prs + totals.issues + totals.reviews === 0;
  // 机器人提交单列，不进 totals / empty
  const automatedCommits = commits.reduce((sum, c) => sum + num(c.automated), 0);

  return {
    date: win.date,
    windowStart: win.startISO,
    windowEnd: win.endISO,
    username,
    generatedAt: new Date().toISOString(),
    empty,
    totals,
    commits,
    automatedCommits,
    pullRequests,
    reviews,
    issues,
    releases,
    stars,
    starInventory,
    replies,
    stateChanges,
    // 截断提示：各段是否因人工上限只采集/展示了部分数据（恒存在；hits=true 才需在页面与 AI 摘要里说明）
    truncated: {
      events: { cap: EVENT_MAX, hits: eventsTruncated },
      targets: { cap: TARGET_MAX, hits: targetsTruncated },
      replies: { cap: REPLIES_PAGE_SIZE, hits: repliesTruncated },
      stateChanges: { cap: STATE_EVENTS_PAGE_SIZE, hits: stateChangesTruncated },
    },
    discussions,
  };
}

// ---------------------------------------------------------------- 历史回填（Search 重建通道）

/**
 * 各段的如实标注（字符串枚举，供 30 天总结页标注数据口径）：
 *   stars         — 事件流 / GraphQL 历史快照均无解（star 历史不可按天重建），恒为空
 *   releases      — 只扫自有仓库（fetchOwnRepos 口径），他仓 Release 不在日报口径内
 *   issues/reviews/discussions — Search 近似重建（日期限定是 UTC 日历日、命中集受 Search 覆盖影响）
 *   comments      — 评论数（comments 字段）不回填；他人回复 / 状态变更对历史日期只能近似定位目标
 *   commits       — 仓库提交历史扫描（REST since/until），按提交日期归属，准确
 */
const BACKFILL_LIMITS = {
  stars: "unavailable",
  releases: "own-repos-only",
  issues: "search-approx",
  reviews: "search-approx",
  discussions: "search-approx",
  comments: "unavailable",
  commits: "repo-scan-accurate",
};

/**
 * 采集指定日（Asia/Shanghai）的 GitHub 活动数据 —— 历史回填（Search 重建）通道。
 *
 * 为什么存在这条通道：/users/:u/events/public 只保留最近 300 条 / 短窗口，
 * 2026-09-17 ~ 10-01 的动作级事件已拿不到，30 天总结需要这一段，故用 Search API
 * 按日期区间重建；返回结构与 collectDailyData 完全一致，额外带 source / backfillLimits。
 *
 * 各段来源与局限（详见 BACKFILL_LIMITS）：
 *   - commits：仓库提交历史扫描（REST since/until），与事件流无关，准确；
 *   - releases：自有仓库扫描，口径与日报一致；
 *   - pullRequests / reviews / issues：Search 重建（rebuildActionsBySearch），近似；
 *   - stars / starInventory：恒为空（无历史快照可重建，previousData 因此不参与计算，
 *     保留参数仅为与 collectDailyData 签名对齐）；
 *   - replies / stateChanges / discussions：沿用日报实现；
 *     searchAuthoredTargets 的 updated:>= 对历史日期只能近似定位目标。
 * 任何一段失败都只打警告并返回空数组；仅 date 非法（computeWindow）会抛错。
 *
 * @param {object} opts 采集参数（与 collectDailyData 同签名）
 * @param {string|null} opts.token GitHub token
 * @param {string} opts.username GitHub 用户名
 * @param {string} opts.date 报告日 "YYYY-MM-DD"（Asia/Shanghai 日历日）
 * @param {object|null} opts.previousData 回填日恒传 null（stars 段无来源，不参与计算）
 * @returns {Promise<object>} collectDailyData 同结构 + source + backfillLimits
 */
export async function collectHistoricalData({ token, username, date, previousData }) {
  const win = computeWindow(date); // date 非法时抛错（唯一允许抛错的入口校验）

  // --- 1. 动作段：事件流已过期，改用 Search 按日期区间重建（公开性缓存与 6/7 段共享）---
  const repoVisibility = new Map();
  const { pullRequests, reviews, issues } = await rebuildActionsBySearch(
    token,
    username,
    win,
    repoVisibility
  );

  // --- 2. 自有仓库（提交扫描 / Release 共用；按 pushed 降序，与事件流无关）---
  const ownRepos = await fetchOwnRepos(token, username);

  // --- 3. 提交：仓库历史扫描是准确的（不传事件流，扫描集只剩窗口内推送过的自有仓库）---
  const commits = await buildCommits([], token, username, win, ownRepos);

  // --- 4. Release：自有仓库扫描，口径与日报一致 ---
  const releases = await fetchReleases(token, username, ownRepos, win);

  // --- 5. 星标：无历史快照可重建，恒为空（见 BACKFILL_LIMITS.stars）---
  const stars = [];
  const starInventory = [];

  // --- 6~7. 我发起的条目定位 + 他人的回复 / 状态变更：沿用日报实现；
  //         注意 searchAuthoredTargets 的 updated:>= 是“从那天至今”，对历史日期只能近似 ---
  const { targets, truncated: targetsTruncated } = await searchAuthoredTargets(token, username, win);
  const { replies, truncated: repliesTruncated } = await fetchReplies(
    token,
    username,
    win,
    targets,
    repoVisibility
  );
  const { changes: stateChanges, truncated: stateChangesTruncated } = await fetchStateChanges(
    token,
    username,
    win,
    targets,
    repoVisibility
  );

  // --- 8. Discussions：本来就是 GraphQL search，不依赖事件流，口径与日报一致 ---
  const { list: discussions, replies: discussionReplies } = await fetchDiscussions(
    token,
    username,
    win
  );
  if (discussionReplies.length) {
    replies.push(...discussionReplies);
    replies.sort(byTsDesc);
  }

  // --- 9. 端点状态回填：与日报同一函数、同一口径 ---
  applyEndStates(issues, pullRequests, stateChanges);

  // --- 合计：与 collectDailyData 逐字一致（totals 只含四项；empty = 四项之和 === 0）---
  const totals = {
    commits: commits.reduce((sum, c) => sum + c.count, 0),
    prs: pullRequests.length,
    issues: issues.length,
    reviews: reviews.length,
  };
  const empty = totals.commits + totals.prs + totals.issues + totals.reviews === 0;
  const automatedCommits = commits.reduce((sum, c) => sum + num(c.automated), 0);

  return {
    date: win.date,
    windowStart: win.startISO,
    windowEnd: win.endISO,
    username,
    generatedAt: new Date().toISOString(),
    empty,
    totals,
    commits,
    automatedCommits,
    pullRequests,
    reviews,
    issues,
    releases,
    stars,
    starInventory,
    replies,
    stateChanges,
    truncated: {
      events: { cap: EVENT_MAX, hits: false }, // 回填没有事件流来源，无“事件截断”可言
      targets: { cap: TARGET_MAX, hits: targetsTruncated },
      replies: { cap: REPLIES_PAGE_SIZE, hits: repliesTruncated },
      stateChanges: { cap: STATE_EVENTS_PAGE_SIZE, hits: stateChangesTruncated },
    },
    discussions,
    source: "search-backfill",
    backfillLimits: { ...BACKFILL_LIMITS },
  };
}

// ---------------------------------------------------------------- CLI 冒烟

/** Asia/Shanghai 的“昨天”（固定 +08:00）。 */
function previousShanghaiDate() {
  const shifted = new Date(Date.now() + TZ_OFFSET_MS - 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** date 的前一天（YYYY-MM-DD，纯 UTC 日历运算，无夏令时问题）。 */
function dayBefore(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/** 读取指定日 docs/data/YYYY-MM-DD.json；文件缺失或损坏 → null（不打日志）。 */
function loadDataFile(date) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const file = path.join(root, "docs", "data", `${date}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 读取前一日 docs/data/YYYY-MM-DD.json 作为 stars delta 基准；不存在或损坏 → null。 */
function loadPreviousData(date) {
  const prev = dayBefore(date);
  const data = loadDataFile(prev);
  if (data) {
    const inv = Array.isArray(data.starInventory) ? data.starInventory.length : 0;
    const legacy = Array.isArray(data.stars) ? data.stars.length : 0;
    const label = inv > 0 ? `starInventory ${inv} 条` : `stars ${legacy} 条（旧格式回退）`;
    console.log(`${LOG} 上一日基准: docs/data/${prev}.json（${label}）`);
    return data;
  }
  console.log(`${LOG} 上一日基准: docs/data/${prev}.json 不可用（stars delta 按无基准处理）`);
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const dateArg = argv.find((a) => a.startsWith("--date="));
  const dumpArg = argv.find((a) => a.startsWith("--dump="));
  const force = argv.includes("--force"); // 跳过评论数快照冻结，取实时值（对齐 index.mjs 的 --force）
  const token = process.env.GITHUB_TOKEN || null;
  const date = dateArg ? dateArg.slice("--date=".length) : previousShanghaiDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`${LOG} 用法: node scripts/daily/lib/github.mjs --date=YYYY-MM-DD [--dump=path.json] [--force]`);
    console.error(`${LOG} 收到的 --date 非法: ${date}`);
    process.exit(1);
  }

  console.log(`${LOG} 开始采集: date=${date} username=sogeisetsu token=${token ? "有" : "无"}`);
  const data = await collectDailyData({
    token,
    username: "sogeisetsu",
    date,
    previousData: loadPreviousData(date),
    existingData: force ? null : loadDataFile(date), // 当天已存 JSON：窗口已关闭时冻结评论数快照（--force 取实时值）
  });

  // 人工可读摘要
  console.log(`${LOG} 窗口: ${data.windowStart} → ${data.windowEnd}`);
  console.log(
    `${LOG} totals: commits=${data.totals.commits} prs=${data.totals.prs}` +
      ` issues=${data.totals.issues} reviews=${data.totals.reviews}`
  );
  console.log(
    `${LOG} 明细: commits ${data.commits.length} 仓 · pullRequests ${data.pullRequests.length}` +
      ` · reviews ${data.reviews.length} · issues ${data.issues.length}`
  );
  console.log(`${LOG} automatedCommits: ${data.automatedCommits}（不计入 totals）`);
  for (const c of data.commits) {
    console.log(
      `${LOG}   · ${c.repo} ×${c.count}（自动 ${c.automated}` +
        `${c.automatedBots.length ? `：${c.automatedBots.join(", ")}` : ""}）` +
        (c.messages.length ? "" : "（无用户提交）")
    );
    for (const m of c.messages) console.log(`${LOG}     - ${String(m.sha).slice(0, 7)} ${m.message}`);
  }
  if (data.issues.length || data.pullRequests.length) {
    const rows = [...data.issues, ...data.pullRequests].map(
      (i) => `${i.repo}#${i.number} ${i.action}${i.state ? ` → ${i.state}` : ""}`
    );
    console.log(`${LOG} 端点状态: ${rows.join(" · ")}`);
  }
  console.log(
    `${LOG} 附加: releases ${data.releases.length} · stars ${data.stars.length}` +
      `（仅列较上一日有变化的仓库） · starInventory ${data.starInventory.length} 条` +
      ` · replies ${data.replies.length}`
  );
  console.log(`${LOG} empty: ${data.empty} · generatedAt: ${data.generatedAt}`);
  console.log(
    `${LOG} stateChanges: ${data.stateChanges.length} 条` +
      (data.stateChanges.length
        ? `（${data.stateChanges
            .map((s) => `${s.repo}#${s.number} ${s.action} by ${s.actor} @ ${s.ts}`)
            .join("; ")}）`
        : "")
  );

  if (dumpArg) {
    const p = path.resolve(dumpArg.slice("--dump=".length));
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
    console.log(`${LOG} 已导出: ${p}`);
  }
}

// 仅当本文件被直接执行时跑 CLI（被 import 时不跑）
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((err) => {
    console.error(`${LOG} 错误: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
  });
}
