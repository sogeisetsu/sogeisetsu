#!/usr/bin/env node
/**
 * scripts/notify-ai-failure.mjs
 * ------------------------------------------------------------------
 * AI 叙述失败可见性通知器（零依赖 ESM，Node 20+）。
 *
 * 定位：日报（update-daily-report.yml）与 30 天总结（update-summary.yml）的
 * 编排器每次「真的调了 AI」都把本次结果写到 data/ai-failure.json（gitignore 的运行状态）：
 * state=failed（全部 provider 失败）/ state=ok（成功）。本脚本在两个 workflow 的
 * 「生成」与「提交」之间运行，把这份记录变成可见、可追溯的信号：
 *
 *   state=failed → 失败路径
 *     1. 幂等确保存住 label `ai-failure`（gh label create --force，失败忽略）
 *     2. 找常住 open issue（gh issue list --label ai-failure --state open）：
 *        没有就用固定标题 `[ai-failure] AI 叙述生成失败` 建一条；有则追加评论
 *        —— 每次失败 run 恰好一条，正文纯代码拼接（绝不由 AI 参与），
 *        reason 一律先过 sanitizeReason 脱敏：body/comment 里绝不出现
 *        key / token / URL / env 泄露
 *     3. 把 issue { number, url } 回写进记录本体的 `issue` 字段，
 *        并逐个回写 record.targets 指向的 docs 数据文件（aiFailure.issue）
 *     4. 重渲染受影响页面（日报：report/<date>.html/.md + index.html；
 *        总结：summary.html + index.html），让线上页面挂上 issue 链接。
 *        整段重渲染裹在 try/catch 里：失败只打 ::warning:: 继续走
 *
 *   state=ok → 恢复路径
 *     本次运行 AI 明确成功：若还有 open 的 ai-failure issue → 每条追加「已恢复」评论并关闭
 *     （gh issue close）；没有 open issue → 什么都不做
 *
 *   记录不存在 → 本次没做 AI 尝试（无变化跳过 / --no-ai）：什么都不做。
 *     **不能把「没有记录」当成已恢复**：CI 每次都是全新 checkout，文件在运行开始时必然不存在，
 *     否则一次跳过 AI 的运行就会误关掉仍然有效的失败 issue。
 *
 * 退出码永远为 0：通知器坏了绝不能挡住生成物发布——顶层 catch 把一切异常
 * 降级成 ::warning:: 行后 process.exit(0)；可见性三件套 = 常住 issue +
 * ::warning:: 行 + $GITHUB_STEP_SUMMARY 一行摘要（本地无该环境变量则跳过）。
 * gh 一律 spawnSync("gh", args 数组)（正文走 stdin 的 --body-file -），
 * 绝不拼 shell 字符串。
 *
 * 用法：node scripts/notify-ai-failure.mjs
 * （由 update-daily-report.yml / update-summary.yml 在生成步骤后、提交步骤前调用；
 *   Actions 里 gh 由 GITHUB_TOKEN 认证，本地用 gh 自身的登录态。）
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

import { sanitizeReason } from "./daily/lib/ai.mjs";
import {
  AI_FAILURE_PATH,
  DATA_DIR,
  DOCS_DIR,
  INDEX_PATH,
  REPORT_DIR,
  ROOT,
  SUMMARY_JSON_PATH,
  listDays,
  readJsonIfExists,
  writeAtomic,
} from "./daily/lib/days.mjs";
import { renderIndexPage, renderMarkdown, renderReportPage } from "./daily/render.mjs";
import { renderSummaryPage, summaryCard } from "./summary/render.mjs";

// ---------------------------------------------------------------- 常量

const LOG = "[notify-ai-failure]";
const REPO = process.env.GITHUB_REPOSITORY || "sogeisetsu/sogeisetsu";
const USERNAME = process.env.GITHUB_REPOSITORY_OWNER || "sogeisetsu";
const LABEL = "ai-failure";
const ISSUE_TITLE = "[ai-failure] AI 叙述生成失败";

// ---------------------------------------------------------------- gh 封装

/**
 * 调 gh CLI：args 以数组直传（绝不拼 shell 字符串），input 走 stdin
 * （配合 --body-file - 传正文，避免命令行长度限制与转义问题）。
 * gh 不存在 / 非 0 退出都只返回 { ok, stdout, stderr }，不抛异常——
 * 由调用方决定是否升级成错误。
 */
function gh(args, { input } = {}) {
  const res = spawnSync("gh", args, { encoding: "utf8", input });
  if (res.error) return { ok: false, stdout: "", stderr: res.error.message };
  return {
    ok: res.status === 0,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

// ---------------------------------------------------------------- 环境推导

/** run URL：记录里 runUrl 为空时按 workflow 环境兜底（与编排器同口径）。 */
function envRunUrl() {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : "";
}

/** workflow 名：优先 GITHUB_WORKFLOW_REF 里的 .yml 文件名，退回 GITHUB_WORKFLOW。 */
function envWorkflow() {
  const ref = process.env.GITHUB_WORKFLOW_REF || "";
  const m = ref.match(/\/workflows\/([^@]+)@/);
  if (m) return m[1];
  return process.env.GITHUB_WORKFLOW || "";
}

// ---------------------------------------------------------------- 正文拼接

/** reason 去重行：脱敏后压成单行，保证评论的编号列表不被换行截断。 */
function oneLineReason(reason) {
  return sanitizeReason(reason == null ? "" : String(reason)).replace(/\s+/g, " ").trim();
}

/**
 * 失败正文（issue 首帖与后续评论同构）：标题 / 范围 / 工作流 / Run / 页面状态 /
 * 逐条 attempt / 固定注脚。纯代码拼接，不经任何 AI；reason 一律脱敏。
 */
function buildFailureBody(record) {
  const now = new Date().toISOString();
  const lines = [`AI 叙述生成失败 · ${now}`, ""];

  if (record.scope === "summary") {
    lines.push(`30 天总结：窗口 ${record.windowStart ?? "?"} ~ ${record.windowEnd ?? "?"}`);
  } else {
    const dates = Array.isArray(record.dates) ? record.dates : [];
    lines.push(`日报：${dates.join(", ")}`);
  }

  const workflow = record.workflow || envWorkflow();
  if (workflow) lines.push(`工作流：${workflow}`);

  const runUrl = record.runUrl || envRunUrl();
  if (runUrl) lines.push(`Run：${runUrl}`);

  lines.push(
    `页面状态：${record.pageState === "kept-previous" ? "保留上一次叙述（页面未降级）" : "该页显示「无叙述」"}`
  );
  lines.push("");

  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  attempts.forEach((a, i) => {
    const provider = (a && a.provider) || "未知 provider";
    const model = a && a.model != null ? String(a.model).trim() : "";
    const reason = oneLineReason(a && a.reason);
    lines.push(model ? `${i + 1}. ${provider} / ${model}：${reason}` : `${i + 1}. ${provider}：${reason}`);
  });

  lines.push("");
  lines.push("AI 不可用时页面上的数字仍由代码求和，未被 AI 影响。");
  return lines.join("\n");
}

// ---------------------------------------------------------------- 回写 + 重渲染

/**
 * 把 issue { number, url } 回写进记录本体与 record.targets 指向的文件
 * （docs/data/<date>.json / docs/summary.json 的 aiFailure.issue）。
 * 回写失败只 warning，不阻塞后面的重渲染与发布。
 */
function writeBackIssue(record, issue) {
  try {
    const info = { number: issue.number, url: issue.url };
    record.issue = info;
    writeAtomic(AI_FAILURE_PATH, JSON.stringify(record, null, 2));
    const targets = Array.isArray(record.targets) ? record.targets : [];
    for (const rel of targets) {
      const file = path.join(ROOT, rel);
      const obj = readJsonIfExists(file);
      if (!obj) {
        console.log(`::warning::AI 失败可见性：回写目标不存在或不是合法 JSON，跳过 ${rel}`);
        continue;
      }
      obj.aiFailure = { ...(obj.aiFailure || {}), issue: info };
      writeAtomic(file, JSON.stringify(obj, null, 2));
    }
  } catch (err) {
    console.log(`::warning::AI 失败可见性：回写 issue 信息失败（${errMessage(err)}），继续重渲染`);
  }
}

/** 首页重写（与两个编排器同口径：归档 listDays + summary.json 卡片，卡片缺失时为 null）。 */
function rewriteIndex(record) {
  const summary = readJsonIfExists(SUMMARY_JSON_PATH);
  writeAtomic(
    INDEX_PATH,
    renderIndexPage({
      days: listDays(),
      generatedAt: new Date().toISOString(),
      username: record.username || USERNAME,
      summaryCardHtml: summary ? summaryCard({ summary }) : null,
    })
  );
}

/**
 * 让页面挂上 issue 链接：日报重渲染各日 report 页 + index；总结重渲染
 * summary.html + index.html。整段裹 try/catch——重渲染失败绝不能挡住发布。
 */
function rerender(record) {
  try {
    if (record.scope === "summary") {
      const summary = readJsonIfExists(SUMMARY_JSON_PATH);
      if (summary) {
        writeAtomic(
          path.join(DOCS_DIR, "summary.html"),
          renderSummaryPage({ summary, username: summary.username || record.username || USERNAME })
        );
      }
      rewriteIndex(record);
      console.log(`${LOG} 已重渲染 docs/summary.html 与 docs/index.html`);
    } else {
      for (const date of Array.isArray(record.dates) ? record.dates : []) {
        const j = readJsonIfExists(path.join(DATA_DIR, `${date}.json`));
        if (!j) {
          console.log(`::warning::AI 失败可见性：docs/data/${date}.json 不存在，跳过该日重渲染`);
          continue;
        }
        const ai = j.ai || null;
        writeAtomic(path.join(REPORT_DIR, `${date}.html`), renderReportPage({ data: j, ai }));
        writeAtomic(path.join(REPORT_DIR, `${date}.md`), renderMarkdown({ data: j, ai }));
      }
      rewriteIndex(record);
      console.log(`${LOG} 已重渲染日报页与 docs/index.html`);
    }
  } catch (err) {
    console.log(`::warning::AI 失败可见性：重渲染失败（${errMessage(err)}），不阻塞发布`);
  }
}

// ---------------------------------------------------------------- 两条路径

/** gh issue list 的公共参数（失败路径与恢复路径共用口径）。 */
const LIST_ARGS = ["issue", "list", "--repo", REPO, "--label", LABEL, "--state", "open",
  "--json", "number,url,title", "--limit", "5"];

/** 列出 open 的 ai-failure issue；gh 失败抛错（顶层降级成 warning）。 */
function listOpenIssues() {
  const res = gh(LIST_ARGS);
  if (!res.ok) throw new Error(`gh issue list 失败：${res.stderr || res.stdout || "未知错误"}`);
  try {
    return JSON.parse(res.stdout || "[]");
  } catch {
    throw new Error(`gh issue list 输出不是合法 JSON：${res.stdout.slice(0, 200)}`);
  }
}

/** 失败路径：建/评论常住 issue → 回写 → 重渲染。返回单行摘要。 */
function failurePath(record) {
  const body = buildFailureBody(record);
  const issues = listOpenIssues();
  let issue;
  if (issues.length > 0) {
    issue = issues[0];
    const res = gh(["issue", "comment", String(issue.number), "--repo", REPO, "--body-file", "-"], { input: body });
    if (!res.ok) throw new Error(`gh issue comment 失败：${res.stderr || res.stdout || "未知错误"}`);
    console.log(`${LOG} 已在 issue #${issue.number} 追加失败评论`);
  } else {
    const res = gh(
      ["issue", "create", "--repo", REPO, "--title", ISSUE_TITLE, "--label", LABEL, "--body-file", "-"],
      { input: body }
    );
    if (!res.ok) throw new Error(`gh issue create 失败：${res.stderr || res.stdout || "未知错误"}`);
    // gh issue create 成功后把 URL 打到 stdout；编号取末段，取不到再回查列表兜底
    const m = res.stdout.match(/\/issues\/(\d+)\s*$/);
    if (m) {
      issue = { number: Number(m[1]), url: res.stdout };
    } else {
      const again = listOpenIssues();
      if (!again.length) throw new Error("gh issue create 成功但拿不到 issue 编号");
      issue = again[0];
    }
    console.log(`${LOG} 已创建 issue #${issue.number}`);
  }

  writeBackIssue(record, issue);
  rerender(record);
  return `失败记录存在 → issue #${issue.number} ${issues.length > 0 ? "已追加评论" : "已创建"}，已回写并重渲染`;
}

/** 恢复路径：有 open issue 才动作（补「已恢复」评论并关闭），否则什么都不做。 */
function recoveryPath() {
  const issues = listOpenIssues();
  if (!issues.length) return "本次 AI 成功，且无 open 的 ai-failure issue，无需动作";
  const now = new Date().toISOString();
  const lines = [`已恢复：本次运行 AI 叙述生成成功（${now}）`];
  const workflow = envWorkflow();
  if (workflow) lines.push(`工作流：${workflow}`);
  const runUrl = envRunUrl();
  if (runUrl) lines.push(`Run：${runUrl}`);
  const body = lines.join("\n");
  for (const issue of issues) {
    const c = gh(["issue", "comment", String(issue.number), "--repo", REPO, "--body-file", "-"], { input: body });
    if (!c.ok) throw new Error(`gh issue comment 失败（#${issue.number}）：${c.stderr || c.stdout || "未知错误"}`);
    const closed = gh(["issue", "close", String(issue.number), "--repo", REPO]);
    if (!closed.ok) throw new Error(`gh issue close 失败（#${issue.number}）：${closed.stderr || closed.stdout || "未知错误"}`);
    console.log(`${LOG} issue #${issue.number} 已评论恢复并关闭`);
  }
  return `state=ok → 已恢复关闭 ${issues.length} 个 issue`;
}

// ---------------------------------------------------------------- 主流程

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Actions step summary（$GITHUB_STEP_SUMMARY）：可见性的第三条腿（issue + ::warning:: + 这里）。
 * 本地没有该环境变量、或写失败，都静默跳过——绝不影响退出码。
 */
function appendStepSummary(markdown) {
  try {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (!file) return;
    appendFileSync(file, `${markdown}\n`, "utf8");
  } catch {
    // step summary 只是锦上添花，失败静默
  }
}

function main() {
  // 1. label 幂等确保：已存在时 --force 等价于更新描述/颜色，任何失败都忽略（只是装饰性前置）
  gh(["label", "create", LABEL, "--repo", REPO, "--color", "B60205", "--description", "AI 叙述生成失败（常住）", "--force"]);

  // 2. 读 run 级记录，按键分三条路：
  //    无记录           → 本次没做 AI 尝试，不动（绝不能当恢复）
  //    state === "ok"   → 恢复路径（本次 AI 明确成功）
  //    其余（failed）    → 失败路径
  const record = readJsonIfExists(AI_FAILURE_PATH);
  let summary;
  if (!record) {
    summary = "无 run 级记录（本次未做 AI 尝试），不动作";
  } else if (record.state === "ok") {
    summary = recoveryPath();
  } else {
    summary = failurePath(record);
  }
  console.log(`${LOG} ${summary}`);
  appendStepSummary(`**AI 失败可见性**：${summary}`);
}

try {
  main();
} catch (err) {
  // 任何异常都不许逃逸：通知器坏了绝不能挡住生成物发布
  console.log(`::warning::AI 失败可见性：${errMessage(err)}`);
  appendStepSummary(`**AI 失败可见性**：本次通知失败 —— ${errMessage(err)}`);
}
process.exit(0);
