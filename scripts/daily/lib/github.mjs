#!/usr/bin/env node
/**
 * scripts/daily/lib/github.mjs
 * ------------------------------------------------------------------
 * 每日报告 · GitHub 数据采集（零依赖 ESM，Node 20+ 内置 fetch，风格对齐 scripts/generate-activity.mjs）。
 *
 * 数据源与职责：
 *   1. REST /users/:u/events/public      —— 窗口内动作级事件（PR / Issue / 评审 / 自己的评论），
 *                                          以及 PushEvent（发现被推过的仓库 + before/head）
 *   2. REST /repos/:o/:r/compare         —— 对每个窗口内 PushEvent 复核“用户本人提交数”
 *                                          （该端点 payload 不含 size/commits，无法直接加权）
 *   3. REST /users/:u/repos + releases    —— 自有仓库的 Release（published_at 落在窗口内）
 *   4. GraphQL repository.stargazerCount —— 自有仓库星标总数：全量存入 starInventory 作次日基准，
 *                                          展示的 stars 只列 delta 非 0 的变化项
 *   5. REST /search/issues + 评论列表     —— 定位我最近更新的条目（回复 / 状态变更共用，上限 25），
 *                                          以及他人在我 PR / Issue 下的回复（逐仓校验公开后才收录）
 *   6. REST /repos/:o/:r/issues/:n/events —— 他人对我条目的 closed / merged / reopened
 *                                          （stateChanges 段，不计入 totals）
 *
 * 窗口定义：date 当天 00:00:00+08:00 ≤ ts < 次日 00:00:00+08:00（Asia/Shanghai 固定 UTC+8，无夏令时）。
 *
 * totals 口径（公开日报恒等式）：totals 只由实际展示的公开数据求和得出 ——
 *   commits = Σcommits[].count（PushEvent 逐次复核的用户本人提交数，按仓库累计），
 *   prs/issues/reviews = 对应数组长度。
 *   automatedCommits（机器人提交）与条目 state 回填都不进 totals / empty。
 *   弃用 contributionsCollection：同一瞬间窗口用 +08:00 与 Z 表达会得到不同且错误的归因
 *   （提交会同时漏进相邻两天），且 user-scoped token 下含私有贡献 —— 本模块不再发起该查询。
 *
 * 错误策略：
 *   - 任何一段失败（401/403/404/限流/网络/GraphQL）→ 打警告 + 该段返回空数组，绝不抛错
 *   - 5xx / 网络异常重试 2 次（指数退避），所有分页/枚举均有硬上限
 *   - 仅 --date 格式非法时 CLI 报错退出
 *
 * 用法（CLI 冒烟）：
 *   node scripts/daily/lib/github.mjs --date=YYYY-MM-DD [--dump=path.json]
 *   环境变量 GITHUB_TOKEN 可选；无 token 也能跑公开数据（GraphQL 相关段自动降级）。
 *   CLI 会自动读取 docs/data/前一日.json 作为 stars delta 基准（缺失则按无基准处理）。
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
const NOTES_MAX = 800; // release notes 折叠空白后截断长度
const EXCERPT_MAX = 200; // 回复摘录折叠空白后截断长度
const PUSH_COMPARE_MAX = 20; // 单次运行最多对多少个 PushEvent 走 compare 复核（防失控）
const COMMIT_MSG_MAX = 160; // 提交标题（message 首行）折叠空白后的截断长度

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

/** 折叠全部空白并截断（用于 notes / excerpt）。 */
function collapse(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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

/** 抓取公共事件：跟随 Link rel="next"，上限 5 页 / 300 条；失败返回已取部分（可能为空）。 */
async function fetchPublicEvents(token, username, win) {
  const all = [];
  let hasNext = true;
  for (let page = 1; page <= EVENT_MAX_PAGES && all.length < EVENT_MAX && hasNext; page += 1) {
    const url =
      `https://api.github.com/users/${encodeURIComponent(username)}` +
      `/events/public?per_page=${EVENT_PER_PAGE}&page=${page}`;
    const got = await restGet(url, token, "events");
    if (!got) return all; // 失败即止，保留已取部分
    const chunk = got.data;
    if (!Array.isArray(chunk)) {
      warn("events", `响应不是数组 (${url})`);
      return all;
    }
    all.push(...chunk);
    if (chunk.length === 0) break;
    // 跟随 Link header；没有 Link 时按“满页即还有下一页”推断
    hasNext = /rel="next"/.test(got.link) ? true : chunk.length === EVENT_PER_PAGE;
    // 事件按时间倒序：本页最后一条已早于窗口起点，后面不可能再有窗口内事件
    const oldest = tsOf(chunk[chunk.length - 1].created_at);
    if (oldest && oldest < win.startMs) break;
  }
  return all.slice(0, EVENT_MAX);
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

// ---------------------------------------------------------------- 2. 提交（PushEvent → REST 复核）

/**
 * 一次 PushEvent 的提交检视（compare before...head，单次调用）：
 *   count     = 用户本人提交数（totals.commits 的唯一来源）
 *   messages  = 用户本人提交的 {sha, message, ts}（message 取首行、折叠空白截断 COMMIT_MSG_MAX）
 *   automated = 机器人提交数（author.login / commit.author.name 以 [bot] 结尾，或 author.type === "Bot"）
 *   bots      = 这些机器人提交的发起者身份（author.login || commit.author.name，空值跳过，去重数组）
 * 公共事件端点的 PushEvent.payload 只有 repository_id / push_id / ref / head / before，
 * 不含 size / commits —— 因此按 before...head 走 compare 复核（与 REST /repos/:o/:r/commits 的
 * user-authored 真值口径一致）。seenSha 为跨 push 的全局去重集合（compare 区间可能重叠），
 * 见过的 sha 直接跳过，保证“先去重后计数”（bot 与用户提交同样受此去重约束）。
 * 返回 null 表示无法复核（compare 失败 / before 缺失或为全零），由调用方回退到规格默认权重 1。
 */
async function inspectPush(token, repoName, before, head, username, seenSha) {
  if (!repoName || !before || !head || /^0+$/.test(before)) return null;
  const m = /^([^/]+)\/(.+)$/.exec(repoName);
  if (!m) return null;
  const url =
    `https://api.github.com/repos/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}` +
    `/compare/${encodeURIComponent(before)}...${encodeURIComponent(head)}`;
  const got = await restGet(url, token, "commits");
  const list = got && got.data && got.data.commits;
  if (!Array.isArray(list)) return null;
  const me = String(username ?? "").toLowerCase();
  const isBotName = (name) => String(name ?? "").toLowerCase().endsWith("[bot]");
  const result = { count: 0, messages: [], automated: 0, bots: new Set() };
  for (const c of list) {
    const sha = String(c.sha ?? "");
    if (sha && seenSha.has(sha)) continue; // 跨 push 重叠区间：已计过的 sha 不再计
    const bot =
      c.author?.type === "Bot" || isBotName(c.author?.login) || isBotName(c.commit?.author?.name);
    const mine = [c.author?.login, c.author?.name, c.commit?.author?.name].some(
      (n) => String(n ?? "").toLowerCase() === me
    );
    if (bot) {
      if (sha) seenSha.add(sha);
      result.automated += 1; // 机器人提交：只进 automated，不进 totals
      const who = c.author?.login || c.commit?.author?.name || "";
      if (who) result.bots.add(who); // 记录是谁触发的（空身份跳过）
    } else if (mine) {
      if (sha) seenSha.add(sha);
      result.count += 1;
      result.messages.push({
        sha,
        message: collapse(String(c.commit?.message ?? "").split("\n")[0], COMMIT_MSG_MAX),
        ts: c.commit?.committer?.date || c.commit?.author?.date || "",
      });
    }
    // 他人提交：不计数（其 sha 也无需登记，重复出现时同样不计）
  }
  return {
    count: result.count,
    messages: result.messages,
    automated: result.automated,
    bots: [...result.bots],
  };
}

/**
 * 从窗口内 PushEvent 汇总逐仓提交：
 *   weight = payload.size ?? payload.commits?.length ??（compare 检视的用户提交数）?? 1
 * 前两项是规格口径（该端点实测不返回，保留分支以防上游补齐）；compare 复核失败才落回 1（无明细）。
 * 同仓多次 push 累计；用户提交经全局 sha 去重后计入；count>0 或 automated>0 的仓库进表
 * （纯机器人提交的仓库也保留 automated 行，并计入顶层 automatedCommits；
 * automatedBots 为该仓触发 automated 的机器人身份，去重后排序）。
 */
async function buildCommits(rawEvents, token, username, win) {
  const byRepo = new Map(); // repo → { count, messages, automated, bots }
  const seenSha = new Set(); // 全轮跨 push 的 sha 去重（compare 区间可能重叠，bot 同样受约束）
  const pushes = (rawEvents || []).filter(
    (ev) => ev.type === "PushEvent" && inWindow(tsOf(ev.created_at), win) && ev.repo && ev.repo.name
  );
  let compared = 0;
  let capWarned = false;
  for (const ev of pushes) {
    const repo = ev.repo.name;
    const p = ev.payload || {};
    const slot = byRepo.get(repo) || { count: 0, messages: [], automated: 0, bots: new Set() };
    byRepo.set(repo, slot);

    const payloadWeight = p.size ?? p.commits?.length ?? null;
    if (payloadWeight !== null) {
      // 规格口径分支：payload 明细存在时直接用（该端点实测不返回，保留以防上游补齐）
      const n = num(payloadWeight);
      if (n > 0) slot.count += n;
      continue;
    }

    let inspected = null;
    if (compared >= PUSH_COMPARE_MAX) {
      if (!capWarned) {
        warn("commits", `窗口内 PushEvent 超过 ${PUSH_COMPARE_MAX} 次，超出部分按每次 1 计`);
        capWarned = true;
      }
    } else {
      compared += 1;
      inspected = await inspectPush(token, repo, p.before, p.head, username, seenSha);
    }
    if (inspected) {
      slot.count += inspected.count;
      slot.automated += inspected.automated;
      slot.messages.push(...inspected.messages);
      for (const bot of inspected.bots) slot.bots.add(bot);
    } else {
      slot.count += 1; // 规格默认权重，无消息明细
    }
  }
  return [...byRepo.entries()]
    .map(([repo, s]) => ({
      repo,
      count: s.count,
      own: isOwnRepoName(repo, username),
      messages: s.messages,
      automated: s.automated,
      automatedBots: [...s.bots].sort(), // 去重 + 排序
    }))
    .filter((x) => x.count > 0 || x.automated > 0)
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
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
        notes: collapse(rel.body, NOTES_MAX),
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
 * Search API 定位“我发起且窗口内更新过”的 Issue / PR —— 回复与状态变更两段共用的目标列表：
 * 三个查询（全部 / type:pr / type:issue）合并去重后截断到 TARGET_MAX 条；某查询失败只跳过它。
 */
async function searchAuthoredTargets(token, username, win) {
  const queries = [
    `author:${username} updated:>=${win.date}`,
    `author:${username} updated:>=${win.date} type:pr`,
    `author:${username} updated:>=${win.date} type:issue`,
  ];
  const hits = new Map(); // key: repository_url#number 去重
  for (const q of queries) {
    const url =
      `https://api.github.com/search/issues?q=${encodeURIComponent(q)}` +
      `&per_page=${SEARCH_PER_PAGE}`;
    const got = await restGet(url, token, "search");
    if (!got) continue; // 无 token 常被限流：restGet 已警告，跳过本查询
    const items = got.data && got.data.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const key = `${item.repository_url || ""}#${item.number || 0}`;
      if (!hits.has(key)) hits.set(key, item);
    }
  }
  return [...hits.values()].slice(0, TARGET_MAX);
}

/**
 * 他人的 PR / Issue 评论（回复我发的条目）：
 * 基于目标列表逐个拉评论 → 只保留非本人、且 created_at 落在窗口内的评论。
 * 任何 kind 的回复都必须先确认目标所在仓库公开（走共享缓存）。
 */
async function fetchReplies(token, username, win, targets, repoVisibility) {
  const replies = [];

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
      const url = `${base}/${suffix}?since=${encodeURIComponent(win.startISO)}`;
      const got = await restGet(url, token, "replies");
      if (!got || !Array.isArray(got.data)) continue;
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
  return replies;
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
      `/issues/${t.number}/events?per_page=100`;
    const got = await restGet(url, token, "state");
    if (!got || !Array.isArray(got.data)) continue;
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
  return changes;
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
 * @returns {Promise<object>} 固定 shape 的日报数据，每个 key 恒存在、数组可为空：
 *   { date, windowStart, windowEnd, username, generatedAt, empty,
 *     totals:{commits,prs,issues,reviews},   // = Σcommits[].count（仅用户提交）及各数组长度
 *     commits:[{repo,count,own,messages:[{sha,message,ts}],automated,automatedBots:[login]}],
 *                                             // PushEvent × compare 复核；messages 为用户提交标题，
 *                                             // sha 跨 push 去重；automated = 机器人提交数，
 *                                             // automatedBots = 触发它们的机器人身份（去重排序）
 *     automatedCommits:number,                // = Σcommits[].automated（不进 totals / empty）
 *     pullRequests:[{repo,number,title,url,action,ts,own,state?}],
 *     reviews:[{repo,number,title,url,ts,own}],
 *     issues:[{repo,number,title,url,action,ts,own,state?}],   // state: open|closed|merged，窗口末时刻；
 *                                                              // 由他人的状态变更或自身动作推导，可缺省
 *     releases:[{repo,tag,name,url,publishedAt,notes}],
 *     stars:[{repo,delta,total}],            // 展示用：仅 delta 为数字且非 0 的仓库
 *     starInventory:[{repo,total}],          // 全量自有仓库星标清单（供次日 delta 基准，不过滤）
 *     replies:[{repo,number,title,url,author,excerpt,kind,ts,own}],   // 仅公开仓库
 *     stateChanges:[{repo,number,title,url,action,actor,ts,own}] }    // action: closed|merged|reopened
 *                                                                     // 他人操作，actor 恒非本人；不计入 totals
 */
export async function collectDailyData({ token, username, date, previousData }) {
  const win = computeWindow(date);

  // --- 1. 公共事件（窗口过滤；事件流本身就是公开数据）---
  const rawEvents = await fetchPublicEvents(token, username, win);
  const { pullRequests, reviews, issues } = mapEvents(rawEvents, username, win);
  // --- 2. 提交：PushEvent 发现活跃仓库，REST compare 复核用户本人提交数 ---
  const commits = await buildCommits(rawEvents, token, username, win);
  pullRequests.sort(byTsDesc);
  reviews.sort(byTsDesc);
  issues.sort(byTsDesc);

  // --- 3. 自有仓库 → Release ---
  const ownRepos = await fetchOwnRepos(token, username);
  const releases = await fetchReleases(token, username, ownRepos, win);

  // --- 4. 星标：全量清单持久化 + 展示仅列有变化的 ---
  const starCounts = await fetchStarCounts(token, username, ownRepos);
  const starInventory = buildStarInventory(starCounts);
  const stars = buildStars(ownRepos, starCounts, previousData);

  // --- 5. 我发起的条目（Search 定位，回复与状态变更共用同一目标列表与公开性缓存）---
  const targets = await searchAuthoredTargets(token, username, win);
  const repoVisibility = new Map(); // 仓库公开性缓存（每仓只查一次，两段共用）
  const replies = await fetchReplies(token, username, win, targets, repoVisibility);

  // --- 6. 他人对我 Issue/PR 的状态变更（closed / merged / reopened，不计入 totals）---
  const stateChanges = await fetchStateChanges(token, username, win, targets, repoVisibility);

  // --- 7. 端点状态回填：以窗口结束时刻为准，原地写入 issues / pullRequests 的 state ---
  applyEndStates(issues, pullRequests, stateChanges);

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

/** 读取前一日 docs/data/YYYY-MM-DD.json 作为 stars delta 基准；不存在或损坏 → null。 */
function loadPreviousData(date) {
  const prev = dayBefore(date);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const file = path.join(root, "docs", "data", `${prev}.json`);
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const inv = Array.isArray(data.starInventory) ? data.starInventory.length : 0;
    const legacy = Array.isArray(data.stars) ? data.stars.length : 0;
    const label = inv > 0 ? `starInventory ${inv} 条` : `stars ${legacy} 条（旧格式回退）`;
    console.log(`${LOG} 上一日基准: docs/data/${prev}.json（${label}）`);
    return data;
  } catch {
    console.log(`${LOG} 上一日基准: docs/data/${prev}.json 不可用（stars delta 按无基准处理）`);
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dateArg = argv.find((a) => a.startsWith("--date="));
  const dumpArg = argv.find((a) => a.startsWith("--dump="));
  const token = process.env.GITHUB_TOKEN || null;
  const date = dateArg ? dateArg.slice("--date=".length) : previousShanghaiDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`${LOG} 用法: node scripts/daily/lib/github.mjs --date=YYYY-MM-DD [--dump=path.json]`);
    console.error(`${LOG} 收到的 --date 非法: ${date}`);
    process.exit(1);
  }

  console.log(`${LOG} 开始采集: date=${date} username=sogeisetsu token=${token ? "有" : "无"}`);
  const data = await collectDailyData({
    token,
    username: "sogeisetsu",
    date,
    previousData: loadPreviousData(date),
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
        (c.messages.length ? "" : "（无 compare 明细）")
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
