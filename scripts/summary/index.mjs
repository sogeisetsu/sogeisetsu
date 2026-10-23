#!/usr/bin/env node
/**
 * scripts/summary/index.mjs
 * ------------------------------------------------------------------
 * 「近 30 天 GitHub 活动 AI 总结」编排器（零依赖 ESM，Node 20+）。
 *
 * 数据流：
 *   collectSummaryData()  → 最近 30 个已定稿 +08 自然日的聚合（docs/data ∪ data/backfill）
 *                           数字条全部由代码逐日求和，不经 AI
 *   generateStructured()  → 按 `config/providers.json` 的 `lanes.summary`（deepseek → sensenova）
 *                           产出 en+zh 结构化叙述（失败则 null）
 *   renderSummaryPage()   → docs/summary.html（独立页，中英内联切换）
 *   summaryCard()         → docs/index.html 顶部的总结卡片片段
 *   docs/summary.json 为结构化真相源（只留最新一份），含 dataHash 供「无变化跳过」。
 *
 * 用法：
 *   node scripts/summary/index.mjs [--force] [--dry-run] [--no-ai] [--rerender]
 *   --force     忽略窗口哈希，强制重新调 AI（改了提示词 / 数据口径后用）
 *   --dry-run   只打印摘要，不写任何文件
 *   --no-ai     跳过 AI 调用，只产出确定数字 + 空叙述（联调用）
 *   --rerender  只按已存的 docs/summary.json 重渲染 summary.html 与 index.html，不聚合、不调 AI
 *
 * 无变化跳过：窗口不含今天，「昨天」一旦定稿，一天之内窗口数据通常不再变化；
 * 聚合哈希与已存 summary.json 相同且非 --force 时不调 AI、不写文件，避免浪费 token。
 *
 * 失败策略（与日报同思路）：
 *   · AI 全失败且已有一份带叙述的 summary.json → 打印警告，**不写任何文件**（沿用上一次，页面不降级）；
 *     但 run 级失败记录 data/ai-failure.json 照写（pageState=kept-previous，targets 空 —— 常驻 issue
 *     就是这类「页面不降级但 AI 已坏」状态的唯一可见出口）
 *   · AI 全失败但还没有任何可用叙述（首次运行）→ 仍写出「只有确定数字」的页面（数字不经 AI，
 *     缺日标注照常），AI 块显示「暂不可用」；这比一份都不写更接近「数字条始终可用」的目标，
 *     同时把 aiFailure 写进 summary.json + run 级记录
 *   · --no-ai 同理：有上一次叙述且窗口未变时保留，否则产出无叙述版
 *   · 成功 → summary.aiFailure 置 null 并删 run 级旧记录；失败不改退出码（仍以 0 退出，
 *     生成物照常提交），可见性靠 issue + ::warning:: + GITHUB_STEP_SUMMARY（--dry-run 一律不写不删）
 */

import { appendFileSync } from "node:fs";

import { providersForLane } from "../daily/lib/providers.mjs";
import { generateStructured } from "../daily/lib/ai.mjs";
import {
  AI_FAILURE_PATH,
  INDEX_PATH,
  SUMMARY_HTML_PATH,
  SUMMARY_JSON_PATH,
  listDays,
  readJsonIfExists,
  runUrlFromEnv,
  workflowFromEnv,
  writeAtomic,
} from "../daily/lib/days.mjs";
import { renderIndexPage } from "../daily/render.mjs";
import { buildItemIndex, collectSummaryData } from "./collect.mjs";
import { buildSummaryPrompts, summaryFeedback } from "./prompt.mjs";
import { renderSummaryPage, summaryCard } from "./render.mjs";
import { validateSummary } from "./validate-summary.mjs";

// ---------------------------------------------------------------- 常量与参数

const LOG = "[summary]";
const USERNAME = process.env.GITHUB_REPOSITORY_OWNER || "sogeisetsu";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const NO_AI = args.includes("--no-ai");
const FORCE = args.includes("--force");
const RERENDER = args.includes("--rerender");

// ---------------------------------------------------------------- 写站点产物

/**
 * 写 docs/summary.json + docs/summary.html，并重写 docs/index.html（带上总结卡片）。
 * index 的归档列表与日报共用 listDays()，两处口径必须一致。
 */
function writeSite(summary) {
  writeAtomic(SUMMARY_JSON_PATH, JSON.stringify(summary, null, 2));
  const html = renderSummaryPage({ summary, username: summary.username || USERNAME });
  writeAtomic(SUMMARY_HTML_PATH, html);
  const days = listDays();
  writeAtomic(
    INDEX_PATH,
    renderIndexPage({
      days,
      generatedAt: summary.generatedAt || new Date().toISOString(),
      username: summary.username || USERNAME,
      summaryCardHtml: summaryCard({ summary }),
    })
  );
  return { htmlLength: html.length, cardLength: summaryCard({ summary }).length, days: days.length };
}

/**
 * 窗口内是否没有任何可叙述的活动（只有机器人产出的空跑日）。
 * 与日报「空白天不调 AI」同理：没有条目时模型写不出 3 条 highlights，调了只会浪费 token 并失败。
 */
function hasAnyActivity(collected) {
  const p = collected.aiPayload || {};
  const hasCommits = (p.commits || []).some((c) => (Number(c?.count) || 0) + (Number(c?.automated) || 0) > 0);
  const sections = ["pullRequests", "issues", "reviews", "discussions", "replies", "stateChanges", "releases"];
  return hasCommits || sections.some((k) => Array.isArray(p[k]) && p[k].length > 0);
}

/** 汇总一行日志用的数字摘要。 */
function totalsLine(summary) {
  const t = summary.totals || {};
  return (
    `commits=${t.commits ?? 0} prs=${t.prs ?? 0} issues=${t.issues ?? 0} reviews=${t.reviews ?? 0}` +
    ` automated=${summary.automatedCommits ?? 0} missing=${summary.missing?.days ?? 0}`
  );
}

/**
 * 写 run 级 AI 结果记录 data/ai-failure.json（gitignore 的运行状态，不发布、不提交），
 * 供 scripts/notify-ai-failure.mjs 读取后开/追加常驻 issue（state=failed）或关闭已恢复的
 * issue（state=ok），并把 issue 号回写进 targets 文件。
 *
 * 为什么记录里必须带 state：CI 每次都是全新 checkout，这个文件在运行开始时必然不存在，
 * 所以「文件不存在」不能当作「AI 已恢复」——一次跳过 AI 的运行（窗口未变化早退）会因此
 * 误关掉仍然有效的失败 issue。恢复的唯一依据是本次运行明确写下 state:"ok"。
 *
 * state=failed 时同时打一行 ::warning::（Actions 日志可见）并向 GITHUB_STEP_SUMMARY 追加一行
 * —— 该 env 指向「本步追加写」的 markdown 文件，只能 append、绝不覆盖。
 * 只在确实做过 AI 尝试时调用（--dry-run 与无变化早退都不走这条路径）。
 */
function writeAiRunRecord(record) {
  writeAtomic(AI_FAILURE_PATH, JSON.stringify(record, null, 2));
  if (record.state !== "failed") return; // 成功记录只作恢复信号，不打警告
  const label =
    record.windowStart && record.windowEnd ? `窗口 ${record.windowStart} ~ ${record.windowEnd}` : "30 天窗口";
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

// ---------------------------------------------------------------- --rerender

function rerender() {
  const summary = readJsonIfExists(SUMMARY_JSON_PATH);
  if (!summary) {
    console.error(`${LOG} 错误：docs/summary.json 不存在或不是合法 JSON，无法重渲染`);
    process.exitCode = 1;
    return;
  }
  if (DRY_RUN) {
    console.log(`${LOG} --dry-run：--rerender 需要写文件，未写入（${totalsLine(summary)}）`);
    return;
  }
  const out = writeSite(summary);
  console.log(
    `${LOG} 已重渲染 docs/summary.html（${out.htmlLength} 字节）与 docs/index.html（归档 ${out.days} 天）`
  );
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (RERENDER) {
    rerender();
    return;
  }

  const collected = collectSummaryData({ username: USERNAME });
  console.log(
    `${LOG} 窗口 ${collected.windowStart} ~ ${collected.windowEnd}（UTC+8，${collected.days} 天）· ${totalsLine(collected)}`
  );
  if (collected.missing.days > 0) {
    console.warn(`${LOG} 窗口内缺 ${collected.missing.days} 天数据：${collected.missing.dates.join(", ")}`);
  }

  const existing = readJsonIfExists(SUMMARY_JSON_PATH);
  const sameHash = Boolean(existing && existing.dataHash === collected.dataHash);
  // 数据没变但上一次没拿到叙述时，仍要重试 AI（同日报的 missingAi 逻辑）
  const missingAi = !NO_AI && !(existing && existing.ai);
  if (sameHash && !FORCE && !missingAi) {
    console.log(`${LOG} 窗口数据无变化（dataHash 相同），跳过 AI 与写入`);
    return;
  }
  if (sameHash && !FORCE && missingAi && existing) {
    console.log(`${LOG} 窗口数据无变化但缺少 AI 叙述，重试生成`);
  }

  let ai = null;
  let aiProvider = null;
  let aiModel = null;
  let aiFailure = null; // 只在「AI 真调了且全失败、又没有可保留的叙述」时非 null（写进 docs/summary.json）
  let attempted = false; // 本次是否真的调了 AI（run 级记录要不要写的唯一依据）
  // 本次 AI 调用里逐个失败的 provider（onProviderFailure 填充）——失败记录的唯一权威来源
  const attempts = [];
  // run 级记录的公共字段（三条出口只差 state / pageState / attempts / targets）
  const runRecord = (state, pageState, targetList) => ({
    scope: "summary",
    state,
    dates: [], // 总结是窗口口径，不是日期口径
    windowStart: collected.windowStart,
    windowEnd: collected.windowEnd,
    username: USERNAME,
    generatedAt: new Date().toISOString(),
    workflow: workflowFromEnv(),
    runUrl: runUrlFromEnv(),
    pageState,
    attempts,
    issue: null,
    targets: targetList,
  });
  const emptyWindow = !hasAnyActivity(collected);
  if (NO_AI || emptyWindow) {
    if (emptyWindow) console.log(`${LOG} 窗口内没有任何可叙述的活动，跳过 AI（只出确定数字）`);
    else console.log(`${LOG} 跳过 AI（--no-ai）`);
    if (sameHash && existing && existing.ai) {
      ai = existing.ai;
      aiProvider = existing.aiProvider ?? null;
      aiModel = existing.aiModel ?? null;
      console.log(`${LOG} 窗口未变，保留上一次 AI 叙述`);
    }
  } else {
    attempted = true;
    const index = buildItemIndex(collected.daily);
    const { system, user } = buildSummaryPrompts({ collected });
    const res = await generateStructured({
      system,
      user,
      validate: (raw) => validateSummary(raw, { ...index, missing: collected.missing }),
      // 总结线读自己那条 lane（config/providers.json 的 lanes.summary）：顺序就是那份配置，
      // 不再在调用点重排。历史上 longcat-2.5-preview-free 做不了 30 天总结（连接约 306s 后被掐断），
      // 所以 summary lane 把 deepseek 放在第一位 —— 那条历史现在只体现在配置里。
      // 总结线不设 budgetMs（现状：deepseek 实测 51.8–83.0s + sensenova 兜底）。
      providers: providersForLane("summary"),
      feedback: summaryFeedback,
      onProviderFailure: (a) => attempts.push(a),
    });
    if (res) {
      ai = res.value;
      aiProvider = res.provider;
      aiModel = res.model;
      console.log(`${LOG} AI 叙述: 成功（provider=${aiProvider}${aiModel ? `, model=${aiModel}` : ""}）`);
    } else if (existing && existing.ai) {
      ai = existing.ai;
      aiProvider = existing.aiProvider ?? null;
      aiModel = existing.aiModel ?? null;
      console.warn(`${LOG} AI 叙述: 全部 provider 失败，保留上一次叙述；不写任何文件`);
      // 页面不降级（不写站点文件），但失败必须有可见出口：写 run 级记录 + ::warning:: + step summary。
      // --dry-run 例外：不写不删任何文件（含失败记录），继续往下走只打印摘要。
      if (!DRY_RUN) {
        // targets 为空：页面未降级、无文件需要回填；常驻 issue 就是这类状态的可见出口
        writeAiRunRecord(runRecord("failed", "kept-previous", []));
        return;
      }
    } else {
      console.warn(`${LOG} AI 叙述: 全部 provider 失败，且没有上一次叙述，产出只有确定数字的页面`);
      aiFailure = { generatedAt: new Date().toISOString(), pageState: "no-narrative", attempts, issue: null };
    }
  }

  const summary = {
    windowStart: collected.windowStart,
    windowEnd: collected.windowEnd,
    days: collected.days,
    username: collected.username,
    generatedAt: new Date().toISOString(),
    missing: collected.missing,
    totals: collected.totals,
    automatedCommits: collected.automatedCommits,
    sources: collected.sources,
    backfilled: collected.backfilled,
    backfillLimits: collected.backfillLimits,
    dataHash: collected.dataHash,
    ai,
    aiProvider,
    aiModel,
    aiFailure,
  };

  const cards = summaryCard({ summary });
  const html = renderSummaryPage({ summary, username: summary.username });
  if (DRY_RUN) {
    console.log(
      `${LOG} --dry-run：summary.html=${html.length} 字节 · 卡片=${cards.length} 字节 · ` +
        `ai=${ai ? "有" : "无"}（未写入任何文件）`
    );
    return;
  }

  const out = writeSite(summary);
  console.log(
    `${LOG} 已写入 docs/summary.json、docs/summary.html（${out.htmlLength} 字节）、` +
      `docs/index.html（归档 ${out.days} 天，卡片 ${out.cardLength} 字节）`
  );

  // run 级 AI 结果记录：本次做过 AI 尝试才写（state=failed 供 notify 开/追加 issue，
  // state=ok 供 notify 关闭已恢复的 issue）；一次 AI 都没调（--no-ai / 窗口内无可叙述活动 /
  // 无变化早退）时不动这个文件 ——「没尝试」不等于「已恢复」，不能拿它当关闭信号。
  // --dry-run 已先 return（不写任何文件）；kept-previous 分支在上面已写记录并 return。
  if (attempted) {
    writeAiRunRecord(
      aiFailure ? runRecord("failed", "no-narrative", ["docs/summary.json"]) : runRecord("ok", null, [])
    );
  }
}

main().catch((err) => {
  console.error(`${LOG} 错误: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
});
