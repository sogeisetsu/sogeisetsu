#!/usr/bin/env node
/**
 * scripts/daily/verify.mjs
 * ------------------------------------------------------------------
 * docs/ 生成物不变式自检（零依赖 ESM，Node 20+），一次跑完全部检查。
 *
 * 检查项：
 *   A 每日数据 docs/data/<date>.json：JSON/结构、totals 求和、empty 标记、automated 字段
 *   B 交叉一致：data ↔ report 一一对应；index 里每个报告链接都能落到真实文件
 *   C head + 字体（index 与每份报告）：favicon 路径、Chomsky @font-face、--headline 值、
 *     中文 h1 规则、禁用字体名（只看 <head>，正文叙述提到字体名不算）；
 *     以及 favicon.svg / chomsky.woff2 实体与 wOF2 魔数
 *   D 报告正文：无 "merge:" 提交标题、页脚「不含合并提交」、自动提交说明按
 *     Σ automated 出现（>0 必须有，=0 必须无）、有 AI 叙述时双语 ai-summary 各 ≥1 段、
 *     AI 全失败（ai=null 且 aiFailure 有原因）且有可见段时必须有失败卡
 *   F 回填数据 data/backfill（仓库根固定，与 --dir 无关）：文件数 >0、逐文件
 *     schema（date 与文件名一致 / source=search-backfill / backfillLimits / totals /
 *     明细数组 / dataHash / totals = Σ）
 *   G 30 天总结 docs/summary.json：JSON/schema、ai 结构（ai 非 null 时）
 *   H 数字一致：窗口 = cstDayMinus(30)~cstDayMinus(1)、totals 与 automatedCommits
 *     等于逐日（docs/data ∪ data/backfill，daily 优先）求和、missing 与实际缺日集合相等
 *   I docs/summary.html：文档结构 + head + 确定数字条与 totals 一致、自动提交相加表述、
 *     缺日标注、有 AI 叙述时双语 ai-summary 块与 headline 逐字、
 *     hero 标题必须含 "windowStart – windowEnd" 区间、ai=null 且有失败记录时有失败卡
 *   J 首页卡片一致性：index 是否含 href="./summary.html"（有 ai 叙述或有可渲染的失败明细）、
 *     双语 headline 逐字、卡片标题含窗口区间、降级时的失败卡
 *   E 打印检查过的数据文件 / 报告 / 回填数量
 *
 * 用法：
 *   node scripts/daily/verify.mjs [--dir=docs] [--quiet]
 *   --dir    站点目录（相对路径按仓库根解析，也可给绝对路径；默认 docs）
 *   --quiet  只打印 FAIL 行（省略 OK 行），结尾统计照常输出
 *
 * 输出：每项一行 `OK  <label>` 或 `FAIL <label>: <detail>`，随后是数据/报告数量，
 * 最后一行 `N checks, M failed`；M>0 时退出码 1。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BACKFILL_DIR, cstDayMinus, dateRange, readJsonIfExists } from "./lib/days.mjs";
import { hasVisibleActivity } from "./render.mjs";

// ---------------------------------------------------------------- 常量与参数

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = process.argv.slice(2);
const argVal = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const QUIET = args.includes("--quiet");
const DIR_ARG = argVal("dir") || "docs";
const SITE = path.isAbsolute(DIR_ARG) ? DIR_ARG : path.resolve(ROOT, DIR_ARG);

const DATA_DIR = path.join(SITE, "data");
const REPORT_DIR = path.join(SITE, "report");
const INDEX_PATH = path.join(SITE, "index.html");
const SUMMARY_JSON_PATH = path.join(SITE, "summary.json");
const SUMMARY_HTML_PATH = path.join(SITE, "summary.html");
const FAVICON_PATH = path.join(SITE, "favicon.svg");
const FONT_PATH = path.join(SITE, "assets", "fonts", "chomsky.woff2");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 禁用字体名（历史遗留：Newsreader + 霞鹜文楷 / lxgw）。只作用于 <head>。
const BANNED_FONTS = /Newsreader|newsreader|lxgw|LXGW|霞鹜文楷/;
const COMMIT_MSG_RE = /<li class="commit-msg">([\s\S]*?)<\/li>/g;
const REPORT_HREF_RE = /href="\.\/report\/(\d{4}-\d{2}-\d{2})\.html[^"]*"/g;

// ---------------------------------------------------------------- 记录与工具

const results = [];

/** 记录一项检查：ok 为真打 OK，为假打 FAIL。 */
function check(label, ok, detail) {
  results.push({ label, ok: Boolean(ok), detail: String(detail == null ? "" : detail) });
}

/** 仓库根相对路径，统一正斜杠，便于输出。 */
function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

/** 与 render.mjs 的 esc 同口径的轻量转义（headline / 文本逐字比对用）。 */
function htmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 列出 dir 下日期命名的 `<YYYY-MM-DD><ext>` 文件（升序）。 */
function listDates(dir, ext) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.length === 10 + ext.length && f.endsWith(ext) && DATE_RE.test(f.slice(0, 10)))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

/** 只取 <head> 段（缺 </head> 时退回整篇），字体名检查限定在这里。 */
function headOf(html) {
  const i = html.toLowerCase().indexOf("</head>");
  return i === -1 ? html : html.slice(0, i + "</head>".length);
}

/** 取 <link rel="icon"> 的 href，没有则 null。 */
function iconHref(head) {
  const tag = /<link\b[^>]*\brel="icon"[^>]*>/i.exec(head);
  if (!tag) return null;
  const href = /\bhref="([^"]*)"/i.exec(tag[0]);
  return href ? href[1] : null;
}

/** 解析某天的数据 JSON；缺失 / 坏 JSON 返回 null（A 检查已单独报 FAIL）。 */
function readData(date) {
  const raw = readText(path.join(DATA_DIR, `${date}.json`));
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const sumOf = (list, key) =>
  (Array.isArray(list) ? list : []).reduce((s, x) => s + (Number(x && x[key]) || 0), 0);

/** 可见段摘要（用于 FAIL 详情）。 */
function sectionSummary(data) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  return [
    "commits", "pullRequests", "reviews", "issues",
    "stateChanges", "discussions", "releases", "stars", "replies",
  ]
    .map((k) => `${k}=${arr(data[k]).length}`)
    .join(" ");
}

// ---------------------------------------------------------------- C：head + 字体

/** index 与报告共用的 5 项 head 检查；assetPrefix 为 '' 或 '../'。 */
function headChecks(label, html, assetPrefix) {
  const head = headOf(html);

  const wantIcon = `${assetPrefix}favicon.svg`;
  const gotIcon = iconHref(head);
  check(
    `${label}: favicon href`,
    gotIcon === wantIcon,
    `期望 "${wantIcon}"，实际 ${gotIcon === null ? "无" : `"${gotIcon}"`}`
  );

  const fontUrl = `${assetPrefix}assets/fonts/chomsky.woff2`;
  const faceOk =
    /@font-face\s*\{[^}]*font-family:\s*'Chomsky'/i.test(head) &&
    head.includes(`url('${fontUrl}')`);
  check(`${label}: Chomsky @font-face`, faceOk, `缺少 url('${fontUrl}') 的 Chomsky @font-face`);

  check(
    `${label}: --headline 以 "Chomsky" 开头`,
    /--headline\s*:\s*"Chomsky"/.test(head),
    "--headline 的值不以 \"Chomsky\" 开头"
  );

  check(
    `${label}: zh h1 使用 var(--headline-zh)`,
    /html\[data-lang="zh"\]\s*h1\s*\{[^}]*var\(--headline-zh\)/.test(head),
    `html[data-lang="zh"] h1 规则未用 var(--headline-zh)`
  );

  const banned = BANNED_FONTS.exec(head);
  check(
    `${label}: head 无禁用字体`,
    banned === null,
    banned === null ? "" : `head 含禁用字体名 ${JSON.stringify(banned[0])}`
  );
}

// ---------------------------------------------------------------- 主流程

function main() {
  check("site dir exists", existsSync(SITE), `目录不存在: ${rel(SITE)}`);

  const dataDates = listDates(DATA_DIR, ".json");
  const reportDates = listDates(REPORT_DIR, ".html");

  // ---------------- A 每日数据 ----------------
  for (const date of dataDates) {
    const label = `data/${date}`;
    const raw = readText(path.join(DATA_DIR, `${date}.json`));
    if (raw === null) {
      check(`${label}: json`, false, "读取失败");
      continue;
    }
    let j;
    try {
      j = JSON.parse(raw);
    } catch (e) {
      check(`${label}: json`, false, `JSON.parse 失败: ${e && e.message ? e.message : e}`);
      continue;
    }
    if (j === null || typeof j !== "object" || Array.isArray(j)) {
      check(`${label}: json`, false, "顶层不是对象");
      continue;
    }

    // 结构：必需键 + 类型
    const bad = [];
    if (typeof j.date !== "string" || j.date !== date) bad.push(`date=${JSON.stringify(j.date)}`);
    if (!j.totals || typeof j.totals !== "object") bad.push("totals{} 缺失");
    else {
      for (const k of ["commits", "prs", "issues", "reviews"]) {
        if (typeof j.totals[k] !== "number") bad.push(`totals.${k} 非数字`);
      }
    }
    for (const k of ["commits", "pullRequests", "reviews", "issues"]) {
      if (!Array.isArray(j[k])) bad.push(`${k}[] 缺失`);
    }
    if (typeof j.dataHash !== "string" || j.dataHash === "") bad.push("dataHash 缺失");
    check(`${label}: schema`, bad.length === 0, bad.join("; "));

    // Discussions（可选段：新增字段，历史数据允许缺失；存在则校验结构与窗口）
    if (j.discussions !== undefined) {
      const badD = [];
      if (!Array.isArray(j.discussions)) {
        badD.push("discussions 非数组");
      } else {
        const ws = Date.parse(j.windowStart ?? "");
        const we = Date.parse(j.windowEnd ?? "");
        j.discussions.forEach((d, i) => {
          if (!d || typeof d !== "object") {
            badD.push(`discussions[${i}] 非对象`);
            return;
          }
          if (typeof d.repo !== "string" || !d.repo.includes("/")) {
            badD.push(`discussions[${i}].repo=${JSON.stringify(d.repo)}`);
          }
          if (!Number.isFinite(Number(d.number)) || Number(d.number) <= 0) {
            badD.push(`discussions[${i}].number=${JSON.stringify(d.number)}`);
          }
          if (d.action !== "started" && d.action !== "commented") {
            badD.push(`discussions[${i}].action=${JSON.stringify(d.action)}`);
          }
          if (typeof d.url !== "string" || !/github\.com\/[^/]+\/[^/]+\/discussions\/\d+/.test(d.url)) {
            badD.push(`discussions[${i}].url=${JSON.stringify(d.url)}`);
          }
          const ms = Date.parse(d.ts ?? "");
          if (Number.isFinite(ws) && Number.isFinite(we)) {
            if (!Number.isFinite(ms) || ms < ws || ms >= we) {
              badD.push(`discussions[${i}].ts=${JSON.stringify(d.ts)} 不在窗口 [${j.windowStart}, ${j.windowEnd}) 内`);
            }
          }
        });
      }
      check(`${label}: discussions 结构`, badD.length === 0, badD.join("; "));
    }

    // totals 与明细求和一致
    const totalsReady =
      j.totals && typeof j.totals === "object" &&
      ["commits", "pullRequests", "reviews", "issues"].every((k) => Array.isArray(j[k]));
    if (totalsReady) {
      const diffs = [];
      const sumCommits = sumOf(j.commits, "count");
      if (j.totals.commits !== sumCommits) diffs.push(`commits ${j.totals.commits}≠Σ${sumCommits}`);
      if (j.totals.prs !== j.pullRequests.length) diffs.push(`prs ${j.totals.prs}≠len ${j.pullRequests.length}`);
      if (j.totals.issues !== j.issues.length) diffs.push(`issues ${j.totals.issues}≠len ${j.issues.length}`);
      if (j.totals.reviews !== j.reviews.length) diffs.push(`reviews ${j.totals.reviews}≠len ${j.reviews.length}`);
      check(`${label}: totals = Σ`, diffs.length === 0, diffs.join("; "));
    } else {
      check(`${label}: totals = Σ`, false, "totals 或明细数组缺失");
    }

    // empty 与 totals 总和互斥
    const totals = j.totals && typeof j.totals === "object" ? j.totals : null;
    if (totals && typeof j.empty === "boolean") {
      const sum = ["commits", "prs", "issues", "reviews"].reduce(
        (s, k) => s + (Number(totals[k]) || 0),
        0
      );
      check(`${label}: empty 标记`, j.empty === (sum === 0), `empty=${j.empty} 但 totals 总和=${sum}`);
    } else {
      check(
        `${label}: empty 标记`,
        false,
        totals ? `empty 缺失或非布尔: ${JSON.stringify(j.empty)}` : "totals 缺失"
      );
    }

    // 自动提交字段
    const autoBad = [];
    (Array.isArray(j.commits) ? j.commits : []).forEach((c, i) => {
      if (!c || typeof c !== "object") {
        autoBad.push(`commits[${i}] 非对象`);
        return;
      }
      if (typeof c.automated !== "number" || !Number.isFinite(c.automated) || c.automated < 0) {
        autoBad.push(`commits[${i}].automated=${JSON.stringify(c.automated)}`);
      }
      if (!Array.isArray(c.automatedBots)) {
        autoBad.push(`commits[${i}].automatedBots 非数组`);
      }
    });
    check(`${label}: automated 字段`, autoBad.length === 0, autoBad.join("; "));

    // 评论数（新字段：历史数据允许缺失；存在则必须是 >= 0 的有限整数）
    const badC = [];
    for (const k of ["issues", "pullRequests"]) {
      (Array.isArray(j[k]) ? j[k] : []).forEach((row, i) => {
        if (!row || typeof row !== "object" || row.comments === undefined) return;
        const c = row.comments;
        if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || !Number.isInteger(c)) {
          badC.push(`${k}[${i}].comments=${JSON.stringify(c)}`);
        }
      });
    }
    check(`${label}: comments 字段`, badC.length === 0, badC.join("; "));

    // 截断提示字段（新字段：历史数据允许缺失；存在则校验结构）
    if (j.truncated !== undefined) {
      const badT = [];
      if (j.truncated === null || typeof j.truncated !== "object" || Array.isArray(j.truncated)) {
        badT.push("truncated 非对象");
      } else {
        for (const k of ["events", "targets", "replies", "stateChanges"]) {
          const s = j.truncated[k];
          if (s === undefined) badT.push(`truncated.${k} 缺失`);
          else if (s === null || typeof s !== "object" || Array.isArray(s)) {
            badT.push(`truncated.${k} 非对象`);
          } else {
            if (typeof s.cap !== "number" || !Number.isFinite(s.cap)) {
              badT.push(`truncated.${k}.cap 非数字`);
            }
            if (typeof s.hits !== "boolean") badT.push(`truncated.${k}.hits 非布尔`);
          }
        }
      }
      check(`${label}: truncated 结构`, badT.length === 0, badT.join("; "));
    }
  }

  // ---------------- B 交叉一致 ----------------
  const dataOnly = dataDates.filter((d) => !reportDates.includes(d));
  const reportOnly = reportDates.filter((d) => !dataDates.includes(d));
  check(
    "data ↔ report 一一对应",
    dataOnly.length + reportOnly.length === 0,
    [
      ...dataOnly.map((d) => `${d}.json 无对应 ${d}.html`),
      ...reportOnly.map((d) => `${d}.html 无对应 ${d}.json`),
    ].join("; ")
  );

  const indexHtml = readText(INDEX_PATH);
  check("index.html 可读", indexHtml !== null, `缺失或不可读: ${rel(INDEX_PATH)}`);

  const deadLinks = [];
  if (indexHtml === null) {
    deadLinks.push("index.html 缺失，无法核对链接");
  } else {
    const seen = new Set();
    for (const m of indexHtml.matchAll(REPORT_HREF_RE)) {
      const d = m[1];
      if (seen.has(d)) continue;
      seen.add(d);
      if (!existsSync(path.join(REPORT_DIR, `${d}.html`))) deadLinks.push(`./report/${d}.html`);
    }
  }
  check("index 报告链接均可解析", deadLinks.length === 0, `链接到不存在的文件: ${deadLinks.join(", ")}`);

  // ---------------- C head + 字体 ----------------
  check("favicon.svg 存在", existsSync(FAVICON_PATH), `缺失: ${rel(FAVICON_PATH)}`);

  let fontMagic = null;
  if (existsSync(FONT_PATH)) {
    try {
      fontMagic = readFileSync(FONT_PATH).subarray(0, 4).toString("latin1");
    } catch {
      fontMagic = null;
    }
  }
  check(
    "chomsky.woff2 魔数 wOF2",
    fontMagic === "wOF2",
    fontMagic === null ? `缺失: ${rel(FONT_PATH)}` : `前 4 字节 = ${JSON.stringify(fontMagic)}`
  );

  if (indexHtml !== null) headChecks("index", indexHtml, "");

  const reportHtml = new Map();
  for (const date of reportDates) {
    const file = path.join(REPORT_DIR, `${date}.html`);
    const html = readText(file);
    reportHtml.set(date, html);
    if (html === null) check(`report/${date}: 可读`, false, `缺失或不可读: ${rel(file)}`);
    else headChecks(`report/${date}`, html, "../");
  }

  // ---------------- D 报告正文 ----------------
  for (const date of reportDates) {
    const html = reportHtml.get(date);
    if (html === null) continue; // 可读性已 FAIL

    const label = `report/${date}`;

    // 不允许 merge: 开头的提交标题（去标签、去空白）
    const merges = [];
    for (const m of html.matchAll(COMMIT_MSG_RE)) {
      const text = m[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      if (/^merge:/i.test(text)) merges.push(text);
    }
    check(
      `${label}: 无 merge: 提交标题`,
      merges.length === 0,
      `发现 ${merges.length} 条: ${merges.slice(0, 3).map((s) => JSON.stringify(s)).join(", ")}`
    );

    check(`${label}: 页脚「不含合并提交」`, html.includes("不含合并提交"), "页脚缺少「不含合并提交」");

    const data = readData(date);
    if (!data) continue; // 数据坏了由 A 检查报，正文口径无法判定

    const automated = sumOf(data.commits, "automated");
    const hasNote = html.includes("不计入总提交数");
    // 只有「可见日」才会渲染 Commits 分区与自动提交说明；空白天用空状态卡、按设计不提自动提交
    if (hasVisibleActivity(data)) {
      check(
        `${label}: 自动提交说明`,
        automated > 0 ? hasNote : !hasNote,
        automated > 0
          ? `Σ automated=${automated} 但报告缺少「不计入总提交数」`
          : `Σ automated=0 但报告含「不计入总提交数」`
      );
    }

    // 卡片角标必须与 totals 口径一致：0 也要显示 0，不得回退成条目行数
    const totals = data.totals && typeof data.totals === "object" ? data.totals : {};
    const pillPairs = [
      ["Commits", "commits"],
      ["Pull requests", "prs"],
      ["Issues", "issues"],
      ["Reviews", "reviews"],
    ];
    const pillBad = [];
    for (const m of html.matchAll(
      /<h2 class="sec-title">([\s\S]*?)<\/h2><span class="pill">(\d+)<\/span>/g
    )) {
      const hit = pillPairs.find(([token]) => m[1].includes(token));
      if (!hit) continue; // Status changes / Releases / Stars / Replies 不绑定 totals
      const expected = String(Number(totals[hit[1]]) || 0);
      if (m[2] !== expected) {
        pillBad.push(`${hit[0]} 角标=${m[2]} 但 totals.${hit[1]}=${expected}`);
      }
    }
    check(`${label}: 卡片角标与 totals 一致`, pillBad.length === 0, pillBad.join("; "));

    // 有讨论数据时，报告正文必须渲染 Discussions 分区（双语标题都在 HTML 里）
    if (Array.isArray(data.discussions) && data.discussions.length > 0) {
      check(
        `${label}: 讨论数据已渲染`,
        html.includes(">Discussions<"),
        `discussions=${data.discussions.length} 条但报告缺少 Discussions 分区`
      );
    }

    // issue/PR 行的评论数已回填（数字且 >0）时必须逐行渲染在自己的 <li> 片段里：
    // 按行校验（片段里同时含 repo、#number 与「N 条评论」），同 repo#number 出现 N 行就要求
    // 命中片段数 >= N —— 避免同值多行漏渲染时靠最大计数 + 全文档 includes 蒙混过关，
    // 也挡住 Discussions 行或 AI 叙述里的同数字。历史数据无 comments 字段 → 自然跳过。
    const liParts = html.split("<li");
    const want = new Map(); // key → {repo, number, comments, need}
    for (const k of ["issues", "pullRequests"]) {
      for (const row of Array.isArray(data[k]) ? data[k] : []) {
        if (!row || typeof row !== "object") continue;
        const c = row.comments;
        if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) continue;
        if (typeof row.repo !== "string" || !row.repo || row.number === undefined || row.number === null) {
          continue; // 无 repo/number 无法定位行，A 检查的 schema 已另管
        }
        const key = `${row.repo}#${row.number}`;
        const prev = want.get(key);
        if (prev) prev.need += 1;
        else want.set(key, { repo: row.repo, number: row.number, comments: c, need: 1 });
      }
    }
    if (want.size > 0) {
      const missing = [];
      for (const [key, exp] of want) {
        const hits = liParts.filter(
          (p) =>
            p.includes(exp.repo) &&
            p.includes(`#${exp.number}`) &&
            p.includes(`${exp.comments} 条评论`)
        ).length;
        if (hits < exp.need) {
          missing.push(`${key} 期望 ${exp.need} 处，实际 ${hits} 处（comments=${exp.comments}）`);
        }
      }
      check(`${label}: 评论数已渲染`, missing.length === 0, missing.join("; "));
    }

    // 空状态卡与内容分区互斥：有可展示活动就不得出现「安静的一天」，反之必须出现。
    // 口径 = 可见段（含 discussions/releases/stars/replies/stateChanges），不是 totals 的 empty。
    const visible = hasVisibleActivity(data);
    const hasEmptyCard = html.includes('class="card empty-card"');
    const hasSection = /<h2 class="sec-title">/.test(html);
    check(
      `${label}: 空状态与可见段互斥`,
      visible ? !hasEmptyCard && hasSection : hasEmptyCard && !hasSection,
      visible
        ? `有可展示活动（${sectionSummary(data)}）却渲染成空状态`
        : `无任何可展示活动却未渲染空状态`
    );

    if (data.ai && hasVisibleActivity(data)) {
      for (const lang of ["en", "zh"]) {
        const re = new RegExp(`<div class="ai-summary i18n" data-lang="${lang}">([\\s\\S]*?)</div>`);
        const block = re.exec(html);
        const paras = block ? (block[1].match(/<p[\s>]/g) || []).length : 0;
        check(
          `${label}: ai-summary ${lang} 有段落`,
          paras >= 1,
          block ? `${lang} 块内没有 <p>` : `${lang} 的 ai-summary 块缺失`
        );
      }
    }

    // AI 全失败可见性：有可见段、无叙述、且当天记了失败 → 报告必须渲染失败卡（原因 + issue 链接）；
    // notifier 没跑成（拿不到 issue）时必须退化成「未取到 issue 链接」，不许静默只剩「暂不可用」
    const failAttempts =
      data.aiFailure && Array.isArray(data.aiFailure.attempts) ? data.aiFailure.attempts : [];
    if (!data.ai && failAttempts.length > 0 && hasVisibleActivity(data)) {
      check(
        `${label}: AI 失败卡`,
        html.includes('class="ai-failure"'),
        `aiFailure 有 ${failAttempts.length} 条原因但报告缺少失败卡`
      );
    }
    const failIssue =
      data.aiFailure && data.aiFailure.issue && typeof data.aiFailure.issue === "object"
        ? Number(data.aiFailure.issue.number)
        : NaN;
    if (!data.ai && data.aiFailure && !(Number.isFinite(failIssue) && failIssue > 0) && hasVisibleActivity(data)) {
      check(
        `${label}: AI 失败卡降级提示`,
        html.includes("ai-failure-note"),
        "拿不到 issue 链接时报告未给出「未取到 issue 链接」降级提示"
      );
    }

    // 截断提示：data 声明某段 hits=true 且该段有渲染 → 报告必须出现截断提示。
    // targets 命中会级联影响 replies / stateChanges（两者只覆盖前 N 个 target）。
    if (data.truncated && typeof data.truncated === "object") {
      const tr = data.truncated;
      const hit = (k) => Boolean(tr[k] && tr[k].hits === true);
      const targetsHit = hit("targets");
      const len = (k) => (Array.isArray(data[k]) ? data[k].length : 0);
      const needEvents = hit("events") && (len("issues") > 0 || len("pullRequests") > 0);
      const needReplies = (hit("replies") || targetsHit) && len("replies") > 0;
      const needState = (hit("stateChanges") || targetsHit) && len("stateChanges") > 0;
      const need = needEvents || needReplies || needState;
      const has = html.includes('class="trunc-notice"');
      check(
        `${label}: 截断提示`,
        !need || has,
        need && !has ? `命中上限（${sectionSummary(data)}）但报告缺少截断提示` : ""
      );
    }
  }

  // ---------------- F 回填数据 data/backfill（仓库根固定，与 --dir 无关） ----------------
  let backfillFiles = [];
  if (existsSync(BACKFILL_DIR)) {
    try {
      backfillFiles = readdirSync(BACKFILL_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      backfillFiles = [];
    }
  }
  check(
    "backfill: 文件数 > 0",
    backfillFiles.length > 0,
    `${rel(BACKFILL_DIR)} 下没有 .json 回填文件（30 天总结依赖回填数据）`
  );

  for (const file of backfillFiles) {
    const label = `backfill/${file.slice(0, -".json".length)}`;
    const raw = readText(path.join(BACKFILL_DIR, file));
    if (raw === null) {
      check(`${label}: schema`, false, "读取失败");
      continue;
    }
    let j;
    try {
      j = JSON.parse(raw);
    } catch (e) {
      check(`${label}: schema`, false, `JSON.parse 失败: ${e && e.message ? e.message : e}`);
      continue;
    }
    if (j === null || typeof j !== "object" || Array.isArray(j)) {
      check(`${label}: schema`, false, "顶层不是对象");
      continue;
    }

    const bad = [];
    const base = file.slice(0, -".json".length);
    if (typeof j.date !== "string" || !DATE_RE.test(j.date)) {
      bad.push(`date=${JSON.stringify(j.date)}`);
    } else if (j.date !== base) {
      bad.push(`date=${j.date} 与文件名 ${base} 不一致`);
    }
    if (j.source !== "search-backfill") bad.push(`source=${JSON.stringify(j.source)}`);
    if (
      !j.backfillLimits ||
      typeof j.backfillLimits !== "object" ||
      Array.isArray(j.backfillLimits) ||
      Object.keys(j.backfillLimits).length === 0
    ) {
      bad.push("backfillLimits 缺失或不是非空对象");
    }
    const t =
      j.totals && typeof j.totals === "object" && !Array.isArray(j.totals) ? j.totals : null;
    if (!t) bad.push("totals{} 缺失");
    else {
      for (const k of ["commits", "prs", "issues", "reviews"]) {
        if (typeof t[k] !== "number" || !Number.isFinite(t[k])) bad.push(`totals.${k} 非数字`);
      }
    }
    const arraysOk = ["commits", "pullRequests", "reviews", "issues"].every((k) =>
      Array.isArray(j[k])
    );
    if (!arraysOk) {
      for (const k of ["commits", "pullRequests", "reviews", "issues"]) {
        if (!Array.isArray(j[k])) bad.push(`${k}[] 缺失`);
      }
    }
    if (typeof j.dataHash !== "string" || j.dataHash === "") bad.push("dataHash 缺失");
    if (t && arraysOk) {
      const sumCommits = sumOf(j.commits, "count");
      if (t.commits !== sumCommits) bad.push(`totals.commits ${t.commits}≠Σ${sumCommits}`);
      if (t.prs !== j.pullRequests.length) {
        bad.push(`totals.prs ${t.prs}≠len ${j.pullRequests.length}`);
      }
      if (t.issues !== j.issues.length) {
        bad.push(`totals.issues ${t.issues}≠len ${j.issues.length}`);
      }
      if (t.reviews !== j.reviews.length) {
        bad.push(`totals.reviews ${t.reviews}≠len ${j.reviews.length}`);
      }
    }
    check(`${label}: schema`, bad.length === 0, bad.join("; "));
  }

  // ---------------- G/H 30 天总结 docs/summary.json ----------------
  const summaryRaw = readText(SUMMARY_JSON_PATH);
  let summary = null;
  if (summaryRaw === null) {
    check("summary.json: JSON 合法", false, `缺失或不可读: ${rel(SUMMARY_JSON_PATH)}`);
  } else {
    let parsed;
    let parseErr = null;
    try {
      parsed = JSON.parse(summaryRaw);
    } catch (e) {
      parseErr = e && e.message ? e.message : e;
    }
    if (parseErr !== null) {
      check("summary.json: JSON 合法", false, `JSON.parse 失败: ${parseErr}`);
    } else if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      check("summary.json: JSON 合法", false, "顶层不是对象");
    } else {
      check("summary.json: JSON 合法", true, "");
      summary = parsed;
    }
  }

  if (summary) {
    const badS = [];
    const ws = summary.windowStart;
    const we = summary.windowEnd;
    if (typeof ws !== "string" || !DATE_RE.test(ws)) badS.push(`windowStart=${JSON.stringify(ws)}`);
    if (typeof we !== "string" || !DATE_RE.test(we)) badS.push(`windowEnd=${JSON.stringify(we)}`);
    if (typeof summary.days !== "number" || !Number.isFinite(summary.days) || summary.days <= 0) {
      badS.push(`days=${JSON.stringify(summary.days)}`);
    }
    const m = summary.missing;
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      badS.push("missing 非对象");
    } else {
      if (typeof m.days !== "number" || !Number.isFinite(m.days)) {
        badS.push(`missing.days=${JSON.stringify(m.days)}`);
      }
      if (!Array.isArray(m.dates)) badS.push("missing.dates 非数组");
    }
    const t = summary.totals;
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      badS.push("totals{} 缺失");
    } else {
      for (const k of ["commits", "prs", "issues", "reviews"]) {
        if (typeof t[k] !== "number" || !Number.isFinite(t[k])) badS.push(`totals.${k} 非数字`);
      }
    }
    if (
      typeof summary.automatedCommits !== "number" ||
      !Number.isFinite(summary.automatedCommits)
    ) {
      badS.push(`automatedCommits=${JSON.stringify(summary.automatedCommits)}`);
    }
    if (typeof summary.dataHash !== "string" || summary.dataHash === "") badS.push("dataHash 缺失");
    const aiOk =
      summary.ai === null ||
      (summary.ai !== undefined &&
        typeof summary.ai === "object" &&
        !Array.isArray(summary.ai));
    if (!aiOk) badS.push(`ai 非 null 也非对象（${typeof summary.ai}）`);
    check("summary.json: schema", badS.length === 0, badS.join("; "));

    // ai 非 null 时的叙述结构（en/zh 各需非空纯文本 headline、overview、数组段）
    if (summary.ai !== null && summary.ai !== undefined) {
      const badAi = [];
      const ai = summary.ai;
      if (typeof ai !== "object" || Array.isArray(ai)) {
        badAi.push(`ai 非对象（${typeof ai}）`);
      } else {
        for (const lang of ["en", "zh"]) {
          const sec = ai[lang];
          if (!sec || typeof sec !== "object" || Array.isArray(sec)) {
            badAi.push(`ai.${lang} 缺失或非对象`);
            continue;
          }
          const h = sec.headline;
          if (typeof h !== "string" || !h.trim()) badAi.push(`ai.${lang}.headline 为空`);
          else if (/[*`]/.test(h)) badAi.push(`ai.${lang}.headline 含反引号或星号`);
          if (typeof sec.overview !== "string" || !sec.overview.trim()) {
            badAi.push(`ai.${lang}.overview 为空`);
          }
          if (!Array.isArray(sec.highlights)) badAi.push(`ai.${lang}.highlights 非数组`);
          if (!Array.isArray(sec.byRepo)) badAi.push(`ai.${lang}.byRepo 非数组`);
        }
      }
      check("summary.json: ai 结构", badAi.length === 0, badAi.join("; "));
    }

    // 窗口重算（闭区间 30 天，今天不含）
    const wantStart = cstDayMinus(30);
    const wantEnd = cstDayMinus(1);
    check(
      "summary: 窗口 = cstDayMinus(30)~cstDayMinus(1)",
      ws === wantStart && we === wantEnd,
      `summary.json=${ws}..${we}，按今天重算=${wantStart}..${wantEnd}`
    );

    const winOk =
      typeof ws === "string" &&
      DATE_RE.test(ws) &&
      typeof we === "string" &&
      DATE_RE.test(we) &&
      ws <= we;
    if (winOk) {
      // 逐日求和：docs/data ∪ data/backfill，同一天以 docs/data 为准（与 collect.mjs 同口径）
      const dates = dateRange(ws, we);
      const sums = { commits: 0, prs: 0, issues: 0, reviews: 0 };
      let autoSum = 0;
      const present = new Set();
      for (const d of dates) {
        const j =
          readJsonIfExists(path.join(DATA_DIR, `${d}.json`)) ??
          readJsonIfExists(path.join(BACKFILL_DIR, `${d}.json`));
        if (!j) continue;
        present.add(d);
        const t = j.totals && typeof j.totals === "object" ? j.totals : {};
        for (const k of ["commits", "prs", "issues", "reviews"]) sums[k] += Number(t[k]) || 0;
        autoSum += Number(j.automatedCommits) || 0;
      }

      const t = summary.totals && typeof summary.totals === "object" ? summary.totals : {};
      const diffs = ["commits", "prs", "issues", "reviews"]
        .filter((k) => Number(t[k]) !== sums[k])
        .map((k) => `${k} ${JSON.stringify(t[k])}≠Σ${sums[k]}`);
      check("summary: totals = 逐日 Σ", diffs.length === 0, diffs.join("; "));

      check(
        "summary: automatedCommits = 逐日 Σ",
        Number(summary.automatedCommits) === autoSum,
        `summary.json=${JSON.stringify(summary.automatedCommits)} 逐日Σ=${autoSum}`
      );

      const wantMissing = dates.filter((d) => !present.has(d));
      const gotDates =
        summary.missing && typeof summary.missing === "object" && Array.isArray(summary.missing.dates)
          ? [...summary.missing.dates].sort()
          : null;
      const setEqual =
        gotDates !== null &&
        gotDates.length === wantMissing.length &&
        gotDates.every((d, i) => d === wantMissing[i]);
      const daysEqual =
        summary.missing &&
        typeof summary.missing === "object" &&
        Number(summary.missing.days) === wantMissing.length &&
        gotDates !== null &&
        gotDates.length === Number(summary.missing.days);
      check(
        "summary: missing 与实际缺日一致",
        Boolean(setEqual && daysEqual),
        `missing=${JSON.stringify(summary.missing)} 实际缺日=${JSON.stringify(wantMissing)}`
      );
    } else {
      check("summary: totals = 逐日 Σ", false, "windowStart/windowEnd 不是合法 YYYY-MM-DD 闭区间");
      check(
        "summary: automatedCommits = 逐日 Σ",
        false,
        "windowStart/windowEnd 不是合法 YYYY-MM-DD 闭区间"
      );
      check(
        "summary: missing 与实际缺日一致",
        false,
        "windowStart/windowEnd 不是合法 YYYY-MM-DD 闭区间"
      );
    }
  }

  // ---------------- I docs/summary.html ----------------
  const summaryHtml = readText(SUMMARY_HTML_PATH);
  check("summary.html 可读", summaryHtml !== null, `缺失或不可读: ${rel(SUMMARY_HTML_PATH)}`);

  if (summaryHtml !== null) {
    const badH = [];
    if (!/^<!doctype html>/i.test(summaryHtml)) {
      badH.push(`开头=${JSON.stringify(summaryHtml.slice(0, 30))}`);
    }
    if (!summaryHtml.includes('<html lang="en" data-lang="en"')) badH.push('缺 <html lang="en" data-lang="en"');
    if (!summaryHtml.includes("</html>")) badH.push("缺 </html>");
    check("summary.html: 文档结构", badH.length === 0, badH.join("; "));

    headChecks("summary", summaryHtml, "");

    if (summary) {
      const t = summary.totals && typeof summary.totals === "object" ? summary.totals : {};
      const gotNums = [...summaryHtml.matchAll(/<div class="stat-num">([^<]*)<\/div>/g)].map(
        (mm) => mm[1]
      );
      const wantNums = ["commits", "prs", "issues", "reviews"].map((k) => String(t[k]));
      check(
        "summary.html: 数字条与 totals 一致",
        gotNums.length === 4 && wantNums.every((n, i) => gotNums[i] === n),
        `页面=${JSON.stringify(gotNums)} 期望=${JSON.stringify(wantNums)}`
      );

      // 自动提交与 totals 是「相加」关系：>0 时机器生成的 stats-note 必须有相加表述；
      // 包含式误用只在「提交数紧邻 其中/of which」时才算违规 —— 泛用「其中」（如
      // "若干 issue 已关闭，其中…"）是正常中文，扫全文档会把好叙述误判成违规。
      if (Number(summary.automatedCommits) > 0) {
        const noteText = [...summaryHtml.matchAll(/<p class="stats-note">([\s\S]*?)<\/p>/g)]
          .map((mm) => mm[1].replace(/<[^>]*>/g, " "))
          .join(" ");
        const aiText = [
          ...summaryHtml.matchAll(/<div class="ai-summary[^"]*"[^>]*>([\s\S]*?)<\/div>/g),
        ]
          .map((mm) => mm[1].replace(/<[^>]*>/g, " "))
          .join(" ");
        const additive = /另有|\bplus\b/i.test(noteText);
        const overlapRe =
          /(\d[\d,]*\s*(?:own\s+)?(?:commits?|次提交)[^。.!\n]{0,24}(?:其中|\bof which\b))|(?:(?:其中|\bof which\b)[^。.!\n]{0,24}(?:automated\s+commits?|自动提交))/i;
        const overlap = overlapRe.test(noteText) || overlapRe.test(aiText);
        check(
          "summary.html: 自动提交为相加表述",
          additive && !overlap,
          !additive
            ? `automatedCommits=${summary.automatedCommits} 但页面缺少「另有/plus」相加表述`
            : "页面出现「提交数…其中/of which」包含式表述"
        );
      }

      const mDays =
        summary.missing && typeof summary.missing === "object" ? Number(summary.missing.days) : 0;
      const mDates =
        summary.missing && typeof summary.missing === "object" && Array.isArray(summary.missing.dates)
          ? summary.missing.dates
          : [];
      if (mDays > 0) {
        const notices = [...summaryHtml.matchAll(/<p class="trunc-notice">([\s\S]*?)<\/p>/g)]
          .map((mm) => mm[1].replace(/<[^>]*>/g, ""))
          .filter((txt) => /Data missing for|缺数据/.test(txt));
        const hit = notices.some(
          (txt) =>
            txt.includes(String(mDays)) &&
            (mDates.length === 0 || mDates.some((d) => txt.includes(String(d))))
        );
        check(
          "summary.html: 缺日标注",
          hit,
          `missing.days=${mDays}、dates=${JSON.stringify(mDates)} 未在页面缺日提示中出现`
        );
      }

      // 有 AI 叙述时：双语 ai-summary 块各 ≥1 段，headline 双语逐字出现在页面
      if (summary.ai !== null && summary.ai !== undefined) {
        const badBlock = [];
        for (const lang of ["en", "zh"]) {
          const re = new RegExp(`<div class="ai-summary i18n" data-lang="${lang}">([\\s\\S]*?)</div>`);
          const block = re.exec(summaryHtml);
          const paras = block ? (block[1].match(/<p[\s>]/g) || []).length : 0;
          if (!block) badBlock.push(`${lang} 块缺失`);
          else if (paras < 1) badBlock.push(`${lang} 块内没有 <p>`);
        }
        check("summary.html: ai-summary 双语块", badBlock.length === 0, badBlock.join("; "));

        const ai = summary.ai && typeof summary.ai === "object" ? summary.ai : {};
        const heads = [ai.en && ai.en.headline, ai.zh && ai.zh.headline].map((h) =>
          String(h ?? "")
        );
        const missHead = heads.filter(
          (h) => h !== "" && !(summaryHtml.includes(h) || summaryHtml.includes(htmlEsc(h)))
        );
        check(
          "summary.html: ai headline 双语逐字",
          missHead.length === 0,
          `页面未逐字出现: ${missHead.map((h) => JSON.stringify(h)).join(", ")}`
        );
      }

      // 30 天标题必须由代码写死窗口区间（不来自 AI）：hero h1 里必须出现 "WS – WE"
      if (typeof summary.windowStart === "string" && typeof summary.windowEnd === "string") {
        const winLabel = `${summary.windowStart} – ${summary.windowEnd}`;
        check(
          "summary.html: 标题含窗口区间",
          summaryHtml.includes(winLabel),
          `页面未出现 ${JSON.stringify(winLabel)}`
        );
      }

      // 总结页降级（ai=null 且记录了失败）时必须渲染失败卡；拿不到 issue 时必须给出降级提示
      const sumFailAttempts =
        summary.aiFailure && Array.isArray(summary.aiFailure.attempts) ? summary.aiFailure.attempts : [];
      if ((summary.ai === null || summary.ai === undefined) && sumFailAttempts.length > 0) {
        check(
          "summary.html: AI 失败卡",
          summaryHtml.includes('class="ai-failure"'),
          `summary.aiFailure 有 ${sumFailAttempts.length} 条原因但页面缺少失败卡`
        );
      }
      const sumIssue =
        summary.aiFailure && summary.aiFailure.issue && typeof summary.aiFailure.issue === "object"
          ? Number(summary.aiFailure.issue.number)
          : NaN;
      if (
        (summary.ai === null || summary.ai === undefined) &&
        summary.aiFailure &&
        !(Number.isFinite(sumIssue) && sumIssue > 0)
      ) {
        check(
          "summary.html: AI 失败卡降级提示",
          summaryHtml.includes("ai-failure-note"),
          "拿不到 issue 链接时页面未给出「未取到 issue 链接」降级提示"
        );
      }
    }
  }

  // ---------------- J 首页卡片一致性 ----------------
  if (summary && indexHtml !== null) {
    const ai = summary.ai && typeof summary.ai === "object" ? summary.ai : null;
    const heads = ai
      ? [String(ai.en && ai.en.headline ? ai.en.headline : "").trim(),
         String(ai.zh && ai.zh.headline ? ai.zh.headline : "").trim()]
      : ["", ""];
    const hasHeadline = heads.some((h) => h !== "");
    // 卡片的渲染契约（summaryCard）：summary 是对象 &&（有 ai，或有可渲染的失败明细）
    // —— ai 缺失但 aiFailure 有原因/issue 时也要摆出「暂不可用 + 失败卡」，链接同样在
    const fail = summary.aiFailure && typeof summary.aiFailure === "object" ? summary.aiFailure : {};
    const failRenderable =
      (Array.isArray(fail.attempts) && fail.attempts.length > 0) ||
      Boolean(fail.issue && Number(fail.issue.number) > 0);
    const cardRenders = Boolean(ai) || failRenderable;
    const hasLink = indexHtml.includes('href="./summary.html"');
    check(
      "index: summary.html 链接",
      hasLink === cardRenders,
      cardRenders
        ? 'index 应渲染总结卡片（AI 叙述或缺叙述时的失败明细）却缺少 href="./summary.html"'
        : 'ai 为空且无失败明细但 index 含 href="./summary.html"（卡片与页面都不出叙述）'
    );
    if (hasHeadline) {
      const miss = heads.filter(
        (h) => h !== "" && !(indexHtml.includes(h) || indexHtml.includes(htmlEsc(h)))
      );
      check(
        "index: 卡片 headline 双语逐字",
        miss.length === 0,
        `index 未逐字出现: ${miss.map((h) => JSON.stringify(h)).join(", ")}`
      );
      // 卡片标题同样必须写死窗口区间
      if (typeof summary.windowStart === "string" && typeof summary.windowEnd === "string") {
        const winLabel = `${summary.windowStart} – ${summary.windowEnd}`;
        check(
          "index: 卡片标题含窗口区间",
          indexHtml.includes(winLabel),
          `index 卡片未出现 ${JSON.stringify(winLabel)}`
        );
      }
    }
    // 卡片降级（ai=null 且有失败明细）时必须渲染失败卡
    if (!ai && failRenderable) {
      check(
        "index: AI 失败卡",
        indexHtml.includes('class="ai-failure"'),
        "summary.aiFailure 可渲染但首页卡片缺少失败卡"
      );
    }
  }

  // ---------------- 输出 ----------------
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      if (!QUIET) console.log(`OK  ${r.label}`);
    } else {
      failed += 1;
      console.log(`FAIL ${r.label}: ${r.detail}`);
    }
  }
  // E：检查覆盖量
  console.log(
    `checked ${dataDates.length} data files, ${reportDates.length} reports, ${backfillFiles.length} backfill files`
  );
  console.log(`${results.length} checks, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
