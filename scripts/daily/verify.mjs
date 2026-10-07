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
 *     Σ automated 出现（>0 必须有，=0 必须无）、有 AI 叙述时双语 ai-summary 各 ≥1 段
 *   E 打印检查过的数据文件 / 报告数量
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
    check(
      `${label}: 自动提交说明`,
      automated > 0 ? hasNote : !hasNote,
      automated > 0
        ? `Σ automated=${automated} 但报告缺少「不计入总提交数」`
        : `Σ automated=0 但报告含「不计入总提交数」`
    );

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
      const hasSection = html.includes(">Discussions<") || html.includes("Discussions");
      check(
        `${label}: 讨论数据已渲染`,
        hasSection,
        `discussions=${data.discussions.length} 条但报告缺少 Discussions 分区`
      );
    }

    if (data.ai && data.empty !== true) {
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
  console.log(`checked ${dataDates.length} data files, ${reportDates.length} reports`);
  console.log(`${results.length} checks, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
