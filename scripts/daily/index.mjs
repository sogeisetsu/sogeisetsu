#!/usr/bin/env node
/**
 * scripts/daily/index.mjs
 * ------------------------------------------------------------------
 * 每日活动日报编排器（零依赖 ESM，Node 20+）。
 *
 * 数据流：
 *   collectDailyData()  → 指定自然日（Asia/Shanghai）的公开活动数据
 *   generateNarrative() → 主商汤 / 备 OpenCode Go（longcat → deepseek），产出 en+zh 结构化叙述（失败则 null）
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
 * 无变化跳过：每次先抓数据、算内容哈希（忽略 generatedAt/ai/aiProvider/aiModel/aiFailure/dataHash），
 * 与已存 JSON 的 dataHash 相同则不调用 AI、不写文件、不提交，避免浪费 token。
 *
 * AI 全失败：脚本仍以 0 退出（失败不是脚本错误），但会把本次 AI 结果写进 run 级记录
 * data/ai-failure.json（state=failed/ok，gitignore 的运行状态，不发布）+ 逐日 aiFailure 字段，
 * 失败时另打 ::warning:: / 追加 GITHUB_STEP_SUMMARY，由 scripts/notify-ai-failure.mjs
 * 开/追加常驻 issue（state=ok 时改为关闭已恢复的 issue）；--dry-run 不写该记录。
 */

import path from "node:path";
import { appendFileSync } from "node:fs";

import { collectDailyData } from "./lib/github.mjs";
import { defaultProviders, generateNarrative, narrativeWordingOk } from "./lib/ai.mjs";
import { renderIndexPage, renderMarkdown, renderReportPage, hasVisibleActivity } from "./render.mjs";
import {
  AI_FAILURE_PATH,
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
  runUrlFromEnv,
  workflowFromEnv,
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

/**
 * 写 run 级 AI 结果记录 data/ai-failure.json（gitignore 的运行状态，不发布、不提交），
 * 供 scripts/notify-ai-failure.mjs 读取后开/追加常驻 issue（state=failed）或关闭已恢复的
 * issue（state=ok），并把 issue 号回写进 targets 文件。
 *
 * 为什么记录里必须带 state：CI 每次都是全新 checkout，这个文件在运行开始时必然不存在，
 * 所以「文件不存在」不能当作「AI 已恢复」——一次「没做 AI 尝试」的运行（数据无变化跳过）
 * 会因此误关掉仍然有效的失败 issue。恢复的唯一依据是本次运行明确写下 state:"ok"。
 *
 * state=failed 时同时打一行 ::warning::（Actions 日志可见）并向 GITHUB_STEP_SUMMARY 追加一行
 * —— 该 env 指向「本步追加写」的 markdown 文件，只能 append、绝不覆盖。
 * 只在确实做过 AI 尝试时调用（--dry-run 在 main() 里先 return）。
 */
function writeAiRunRecord(record) {
  writeAtomic(AI_FAILURE_PATH, JSON.stringify(record, null, 2));
  if (record.state !== "failed") return; // 成功记录只作恢复信号，不打警告
  const label = record.dates.length > 0 ? record.dates.join(", ") : "近 30 天窗口";
  console.log(
    `::warning::AI 叙述生成失败（${record.scope} ${label}，pageState=${record.pageState}），已写 data/ai-failure.json 待开 issue`
  );
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    appendFileSync(
      stepSummary,
      `- ⚠️ AI 叙述失败（${record.scope} ${label}，pageState=${record.pageState}）：详见 \`data/ai-failure.json\`\n`,
      "utf8"
    );
  }
}

// ---------------------------------------------------------------- 单日处理

/**
 * 处理一个自然日；返回 { date, changed, failed, attempted, pageState, attempts }。
 * changed 是既有语义（是否写盘，消费方不变）；attempted / failed / pageState / attempts 供
 * main() 汇总 run 级 AI 结果记录（attempted=true 表示本次真的调了 AI；failed=true 表示调了且全失败）。
 */
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
    return { date, changed: false, attempted: false, failed: false, pageState: null, attempts: [] };
  }
  if (!DRY_RUN && !FORCE && existing && existing.dataHash === hash && missingAi) {
    console.log(`[daily-report] ${date} 内容无变化但缺少 AI 叙述，重试生成`);
  }

  let ai = null;
  let aiProvider = null;
  let aiModel = null;
  let aiFailure = null; // 只在「AI 真调了且返回 null」时非 null（写进 docs/data/<date>.json）
  let attempted = false; // 本次是否真的调了 AI（run 级记录要不要写的唯一依据）
  // 本次 AI 调用里逐个失败的 provider（onProviderFailure 填充）——失败记录的唯一权威来源
  const attempts = [];
  if (!hasVisibleActivity(data)) {
    // 空白天（连 discussion / release / star / 回复都没有）：不调用 AI、不写假叙述；
    // 页面由渲染层空状态卡承担。注意这里必须用可见段口径，不能只看 totals 的 empty。
    console.log("[daily-report] 当天无任何可展示活动，跳过 AI（页面显示空状态）");
  } else if (NO_AI) {
    console.log("[daily-report] 跳过 AI（--no-ai）");
  } else {
    attempted = true;
    const res = await generateNarrative({
      data,
      providers: defaultProviders(),
      onProviderFailure: (a) => attempts.push(a),
    });
    if (res) {
      ai = { en: res.en, zh: res.zh };
      aiProvider = res.provider;
      aiModel = res.model ?? null;
      console.log(`[daily-report] AI 叙述: 成功（provider=${aiProvider}${aiModel ? `, model=${aiModel}` : ""}）`);
    } else if (existing && existing.ai && existing.dataHash === hash && narrativeWordingOk(existing.ai)) {
      // 数据未变、只是 AI 临时失败：保留上一次叙述，避免把已发布页面降级成「无叙述」。
      // 但旧叙述要先过措辞规则（`narrativeWordingOk`）：旧规则下写出的「其中…自动提交」
      // 不能借这次失败被原样带回页面 —— 宁可出失败卡。
      ai = existing.ai;
      aiProvider = existing.aiProvider ?? null;
      aiModel = existing.aiModel ?? null;
      aiFailure = { generatedAt: new Date().toISOString(), pageState: "kept-previous", attempts, issue: null };
      console.warn("[daily-report] AI 叙述: 失败，数据未变，保留上一次叙述");
    } else {
      aiFailure = { generatedAt: new Date().toISOString(), pageState: "no-narrative", attempts, issue: null };
      console.warn("[daily-report] AI 叙述: 全部 provider 失败，产出无叙述确定版");
    }
  }
  data.ai = ai;
  data.aiProvider = aiProvider;
  data.aiModel = aiModel; // 成功才有值（渲染层 AI 徽章旁注 provider / model）
  data.aiFailure = aiFailure; // 成功 / --no-ai / 空白天一律 null —— 成功必须清掉失败标记
  data.dataHash = hash;

  const html = renderReportPage({ data, ai });
  const md = renderMarkdown({ data, ai });

  if (DRY_RUN) {
    console.log(`[daily-report] --dry-run：html=${html.length} 字节 · md=${md.length} 字节 · ai=${ai ? "有" : "无"}（未写入）`);
    return {
      date,
      changed: false,
      attempted,
      failed: Boolean(aiFailure),
      pageState: aiFailure ? aiFailure.pageState : null,
      attempts,
    };
  }

  writeAtomic(path.join(DATA_DIR, `${date}.json`), JSON.stringify(data, null, 2));
  writeAtomic(path.join(REPORT_DIR, `${date}.html`), html);
  writeAtomic(path.join(REPORT_DIR, `${date}.md`), md);
  console.log(`[daily-report] 已写入 docs/data/${date}.json、docs/report/${date}.html、docs/report/${date}.md`);
  return {
    date,
    changed: true,
    attempted,
    failed: Boolean(aiFailure),
    pageState: aiFailure ? aiFailure.pageState : null,
    attempts,
  };
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

  // run 级 AI 结果记录：本次做过 AI 尝试才写（state=failed 供 notify 开/追加 issue，
  // state=ok 供 notify 关闭已恢复的 issue）；一次 AI 都没调时不动这个文件
  // ——「没尝试」不等于「已恢复」，不能拿它当关闭信号（见 writeAiRunRecord 的注释）。
  // --dry-run 已在上面先 return（不写任何文件）。
  {
    const attemptedDates = results.filter((r) => r.attempted);
    const failed = attemptedDates.filter((r) => r.failed); // 按处理顺序即升序（昨天 → 今天）
    if (attemptedDates.length === 0) {
      console.log("[daily-report] 本次未做 AI 尝试，不写 data/ai-failure.json（也不动旧文件）");
    } else if (failed.length > 0) {
      // 多日同时失败时 attempts 取「最后一个失败日」的：各日 provider 链相同，差异只在 reason，
      // 记录保留最近一次的逐条原因即可。
      const last = failed[failed.length - 1];
      writeAiRunRecord({
        scope: "daily",
        state: "failed",
        dates: failed.map((r) => r.date),
        windowStart: null,
        windowEnd: null,
        username: USERNAME,
        generatedAt: new Date().toISOString(),
        workflow: workflowFromEnv(),
        runUrl: runUrlFromEnv(),
        // 任一失败日保留了上一版叙述 → kept-previous；否则 no-narrative
        pageState: failed.some((r) => r.pageState === "kept-previous") ? "kept-previous" : "no-narrative",
        attempts: last.attempts,
        issue: null,
        targets: failed.map((r) => `docs/data/${r.date}.json`),
      });
    } else {
      writeAiRunRecord({
        scope: "daily",
        state: "ok",
        dates: attemptedDates.map((r) => r.date),
        windowStart: null,
        windowEnd: null,
        username: USERNAME,
        generatedAt: new Date().toISOString(),
        workflow: workflowFromEnv(),
        runUrl: runUrlFromEnv(),
        pageState: null,
        attempts: [],
        issue: null,
        targets: [],
      });
    }
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
