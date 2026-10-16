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
 *   node scripts/daily/index.mjs [--date=YYYY-MM-DD] [--rerender] [--force] [--dry-run] [--no-ai]
 *   --date      只处理指定自然日（默认：同时处理「昨天（定稿）」与「今天（滚动）」）
 *   --rerender  只用已存 JSON 重新渲染 HTML/MD 与 index，不抓数据、不调 AI（改渲染代码后用）
 *   --force     忽略内容哈希，强制重新生成（并重取定稿日的评论数快照，见 existingData）
 *   --dry-run   只打印摘要，不写任何文件
 *   --no-ai     跳过 AI 调用，直接产出「无叙述」确定版（联调用）
 *
 * 无变化跳过：每次先抓数据、算内容哈希（忽略 generatedAt/ai/aiProvider/dataHash），
 * 与已存 JSON 的 dataHash 相同则不调用 AI、不写文件、不提交，避免浪费 token。
 */

import path from "node:path";

import { collectDailyData } from "./lib/github.mjs";
import { defaultProviders, generateNarrative } from "./lib/ai.mjs";
import { renderIndexPage, renderMarkdown, renderReportPage, hasVisibleActivity } from "./render.mjs";
import {
  DATA_DIR,
  DATE_RE,
  INDEX_PATH,
  REPORT_DIR,
  SUMMARY_JSON_PATH,
  contentHash,
  cstDayMinus,
  listDateStrings,
  listDays,
  prevDateOf,
  readJsonIfExists,
  writeAtomic,
} from "./lib/days.mjs";
import { summaryCard } from "../summary/render.mjs";

// ---------------------------------------------------------------- 常量与参数

const USERNAME = process.env.GITHUB_REPOSITORY_OWNER || "sogeisetsu";
const TOKEN = process.env.GITHUB_TOKEN || null;

const args = process.argv.slice(2);
const argVal = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const DRY_RUN = args.includes("--dry-run");
const NO_AI = args.includes("--no-ai");
const FORCE = args.includes("--force");
const DATE_ARG = argVal("date");
const RERENDER = args.includes("--rerender");

/** Asia/Shanghai 日历日推算、JSON 读写、docs/data 扫描：见 lib/days.mjs（与 30 天总结共用）。 */

function sectionCount(data) {
  return ["commits", "pullRequests", "reviews", "issues", "discussions", "releases", "stars", "replies"]
    .map((k) => `${k}=${Array.isArray(data[k]) ? data[k].length : 0}`)
    .join(" ");
}

/**
 * 首页顶部总结卡片片段：读 docs/summary.json，交给 scripts/summary 的渲染层出卡片。
 * 没有总结文件（或读不出来）时返回 null —— 归档页照常渲染，不报错。
 */
function summaryCardHtml() {
  const summary = readJsonIfExists(SUMMARY_JSON_PATH);
  return summary ? summaryCard({ summary }) : null;
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

  // 当天已存数据先读：既作为评论数快照冻结的来源传给 collect，也复用于后面的 dataHash 比较。
  // --force（改了提示词 / 数据口径后用）连快照一起重取：否则定稿日的评论数会被旧口径永久冻结。
  const existing = readJsonIfExists(path.join(DATA_DIR, `${date}.json`));
  const data = await collectDailyData({
    token: TOKEN,
    username: USERNAME,
    date,
    previousData,
    existingData: FORCE ? null : existing,
  });
  console.log(`[daily-report] 数据: totals=${JSON.stringify(data.totals)} · ${sectionCount(data)} · empty=${data.empty}`);

  const hash = contentHash(data);
  const missingAi = hasVisibleActivity(data) && !NO_AI && !(existing && existing.ai);
  if (!DRY_RUN && !FORCE && existing && existing.dataHash === hash && !missingAi) {
    console.log(`[daily-report] ${date} 内容无变化，跳过 AI 与写入`);
    return { date, changed: false };
  }
  if (!DRY_RUN && !FORCE && existing && existing.dataHash === hash && missingAi) {
    console.log(`[daily-report] ${date} 内容无变化但缺少 AI 叙述，重试生成`);
  }

  let ai = null;
  let aiProvider = null;
  if (!hasVisibleActivity(data)) {
    // 空白天（连 discussion / release / star / 回复都没有）：不调用 AI、不写假叙述；
    // 页面由渲染层空状态卡承担。注意这里必须用可见段口径，不能只看 totals 的 empty。
    console.log("[daily-report] 当天无任何可展示活动，跳过 AI（页面显示空状态）");
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
  if (RERENDER) {
    const dates = DATE_ARG ? [DATE_ARG] : listDateStrings();
    for (const d of dates) {
      const j = readJsonIfExists(path.join(DATA_DIR, `${d}.json`));
      if (!j) {
        console.warn(`[daily-report] ${d} 无数据文件，跳过`);
        continue;
      }
      const ai = j.ai || null;
      writeAtomic(path.join(REPORT_DIR, `${d}.html`), renderReportPage({ data: j, ai }));
      writeAtomic(path.join(REPORT_DIR, `${d}.md`), renderMarkdown({ data: j, ai }));
      console.log(`[daily-report] 重新渲染 docs/report/${d}.html/.md`);
    }
    const days = listDays();
    writeAtomic(INDEX_PATH, renderIndexPage({ days, generatedAt: new Date().toISOString(), username: USERNAME, summaryCardHtml: summaryCardHtml() }));
    console.log(`[daily-report] 已重写 docs/index.html（归档 ${days.length} 天）`);
    return;
  }

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
  writeAtomic(INDEX_PATH, renderIndexPage({ days, generatedAt: new Date().toISOString(), username: USERNAME, summaryCardHtml: summaryCardHtml() }));
  console.log(`[daily-report] 已写入 docs/index.html（归档 ${days.length} 天）`);
}

main().catch((err) => {
  console.error(`[daily-report] 错误: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
});
