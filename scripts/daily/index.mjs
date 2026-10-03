#!/usr/bin/env node
/**
 * scripts/daily/index.mjs
 * ------------------------------------------------------------------
 * 每日活动日报编排器（零依赖 ESM，Node 20+）。
 *
 * 数据流：
 *   collectDailyData()  → 指定自然日（Asia/Shanghai）的公开活动数据
 *   generateNarrative() → 主商汤 / 备 Zen，产出 en+zh 结构化叙述（失败则 null）
 *   renderReportPage()  → docs/report/YYYY-MM-DD.html（中英内联切换）
 *   renderMarkdown()    → docs/report/YYYY-MM-DD.md（仓库内可读）
 *   renderIndexPage()   → docs/index.html（最新一天 + 归档列表，列最近 60 天）
 *   docs/data/YYYY-MM-DD.json 为结构化真相源，含 dataHash 供「无变化跳过」。
 *
 * 用法：
 *   node scripts/daily/index.mjs [--date=YYYY-MM-DD] [--force] [--dry-run] [--no-ai]
 *   --date      只处理指定自然日（默认：同时处理「昨天（定稿）」与「今天（滚动）」）
 *   --force     忽略内容哈希，强制重新生成
 *   --dry-run   只打印摘要，不写任何文件
 *   --no-ai     跳过 AI 调用，直接产出「无叙述」确定版（联调用）
 *
 * 无变化跳过：每次先抓数据、算内容哈希（忽略 generatedAt/ai/aiProvider/dataHash），
 * 与已存 JSON 的 dataHash 相同则不调用 AI、不写文件、不提交，避免浪费 token。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectDailyData } from "./lib/github.mjs";
import { defaultProviders, generateNarrative } from "./lib/ai.mjs";
import { renderIndexPage, renderMarkdown, renderReportPage } from "./render.mjs";

// ---------------------------------------------------------------- 常量与参数

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = path.join(ROOT, "docs", "data");
const REPORT_DIR = path.join(ROOT, "docs", "report");
const INDEX_PATH = path.join(ROOT, "docs", "index.html");

const USERNAME = process.env.GITHUB_REPOSITORY_OWNER || "sogeisetsu";
const TOKEN = process.env.GITHUB_TOKEN || null;
const CST_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const ARCHIVE_LIMIT = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const args = process.argv.slice(2);
const argVal = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const DRY_RUN = args.includes("--dry-run");
const NO_AI = args.includes("--no-ai");
const FORCE = args.includes("--force");
const DATE_ARG = argVal("date");

/** Asia/Shanghai 日历日，往前推 days 天，返回 YYYY-MM-DD。 */
function cstDayMinus(days) {
  const shifted = new Date(Date.now() + CST_OFFSET_MS);
  const t = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - days));
  return t.toISOString().slice(0, 10);
}

/** 把 YYYY-MM-DD 往前推一天。 */
function prevDateOf(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 原子写入：先写临时文件再 rename。 */
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/** 内容哈希：忽略 generatedAt / ai / aiProvider / dataHash，其余参与比较。 */
function contentHash(data) {
  const { generatedAt, ai, aiProvider, dataHash, ...rest } = data;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

/** 扫描 docs/data，返回最近 ARCHIVE_LIMIT 天的索引条目（新→旧）。 */
function listDays() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((f) => DATE_RE.test(f.replace(/\.json$/, "")) && f.endsWith(".json"))
    .map((f) => f.slice(0, 10))
    .sort()
    .reverse()
    .slice(0, ARCHIVE_LIMIT)
    .map((d) => {
      const j = readJsonIfExists(path.join(DATA_DIR, `${d}.json`));
      return {
        date: d,
        url: `./report/${d}.html`,
        headline_en: j?.ai?.en?.headline ?? null,
        headline_zh: j?.ai?.zh?.headline ?? null,
        empty: j?.empty === true,
      };
    });
}

function sectionCount(data) {
  return ["commits", "pullRequests", "reviews", "issues", "releases", "stars", "replies"]
    .map((k) => `${k}=${Array.isArray(data[k]) ? data[k].length : 0}`)
    .join(" ");
}

// ---------------------------------------------------------------- 单日处理

/** 处理一个自然日；返回 { date, changed }。 */
async function processDate(date) {
  if (!DATE_RE.test(date)) {
    console.error(`[daily-report] 错误：日期必须是 YYYY-MM-DD，收到 "${date}"`);
    process.exit(1);
  }
  const prevDate = prevDateOf(date);
  const previousData = readJsonIfExists(path.join(DATA_DIR, `${prevDate}.json`));
  console.log(`[daily-report] 目标日: ${date}（Asia/Shanghai），上一日数据: ${prevDate}（${previousData ? "有" : "无"}）`);

  const data = await collectDailyData({ token: TOKEN, username: USERNAME, date, previousData });
  console.log(`[daily-report] 数据: totals=${JSON.stringify(data.totals)} · ${sectionCount(data)} · empty=${data.empty}`);

  const hash = contentHash(data);
  const existing = readJsonIfExists(path.join(DATA_DIR, `${date}.json`));
  if (!DRY_RUN && !FORCE && existing && existing.dataHash === hash) {
    console.log(`[daily-report] ${date} 内容无变化，跳过 AI 与写入`);
    return { date, changed: false };
  }

  let ai = null;
  let aiProvider = null;
  if (data.empty) {
    // 空白天：不调用 AI、不写假叙述；页面由渲染层空状态卡承担
    console.log("[daily-report] 当天无公开活动，跳过 AI（页面显示空状态）");
  } else if (NO_AI) {
    console.log("[daily-report] 跳过 AI（--no-ai）");
  } else {
    const res = await generateNarrative({ data, providers: defaultProviders() });
    if (res) {
      ai = { en: res.en, zh: res.zh };
      aiProvider = res.provider;
      console.log(`[daily-report] AI 叙述: 成功（provider=${aiProvider}）`);
    } else if (existing && existing.ai && existing.dataHash === hash) {
      // 数据未变、只是 AI 临时失败：保留上一次叙述，避免把已发布页面降级成「无叙述」
      ai = existing.ai;
      aiProvider = existing.aiProvider ?? null;
      console.warn("[daily-report] AI 叙述: 失败，数据未变，保留上一次叙述");
    } else {
      console.warn("[daily-report] AI 叙述: 全部 provider 失败，产出无叙述确定版");
    }
  }
  data.ai = ai;
  data.aiProvider = aiProvider;
  data.dataHash = hash;

  const html = renderReportPage({ data, ai });
  const md = renderMarkdown({ data, ai });

  if (DRY_RUN) {
    console.log(`[daily-report] --dry-run：html=${html.length} 字节 · md=${md.length} 字节 · ai=${ai ? "有" : "无"}（未写入）`);
    return { date, changed: false };
  }

  writeAtomic(path.join(DATA_DIR, `${date}.json`), JSON.stringify(data, null, 2));
  writeAtomic(path.join(REPORT_DIR, `${date}.html`), html);
  writeAtomic(path.join(REPORT_DIR, `${date}.md`), md);
  console.log(`[daily-report] 已写入 docs/data/${date}.json、docs/report/${date}.html、docs/report/${date}.md`);
  return { date, changed: true };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  // 默认：同时处理「昨天（定稿）」与「今天（滚动）」
  const dates = DATE_ARG ? [DATE_ARG] : [cstDayMinus(1), cstDayMinus(0)];

  const results = [];
  for (const d of dates) results.push(await processDate(d));

  if (DRY_RUN) {
    console.log("[daily-report] --dry-run：未写入任何文件");
    return;
  }

  if (!results.some((r) => r.changed)) {
    console.log("[daily-report] 所有日期均无变化，未重写 index");
    return;
  }

  const days = listDays();
  writeAtomic(INDEX_PATH, renderIndexPage({ days, generatedAt: new Date().toISOString(), username: USERNAME }));
  console.log(`[daily-report] 已写入 docs/index.html（归档 ${days.length} 天）`);
}

main().catch((err) => {
  console.error(`[daily-report] 错误: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
});
