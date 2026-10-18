#!/usr/bin/env node
/**
 * scripts/daily/lib/days.mjs
 * ------------------------------------------------------------------
 * 「已定稿日」数据目录的共享助手（零依赖 ESM，Node 20+）。
 *
 * 从 scripts/daily/index.mjs 提出来的公共件：路径常量、+08 自然日推算、JSON 读写、
 * 内容哈希、docs/data 扫描。日报编排器（index.mjs）与 30 天总结
 * （scripts/summary/*）两侧复用，保证两处的日期口径与哈希口径完全一致。
 *
 * 口径：所有日期都是 Asia/Shanghai（+08:00）自然日，字符串形如 YYYY-MM-DD
 * （口径本体在 scripts/cst.mjs，这里只转出，三条产物线共用同一份定义）。
 * docs/data/<date>.json 是日报的结构化真相源（AI 叙述在 `ai` 字段，无叙述时为 null）。
 * data/backfill/<date>.json 是一次性 Search API 回填的同一结构（额外带来源标记），
 * 不进站点、不出现在归档列表里。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hasVisibleActivity } from "../render.mjs";
import { DATE_RE } from "../../cst.mjs";

// +08 自然日口径本身住在 scripts/cst.mjs（三条产物线共用）；这里原样转出，
// 保证既有 `from "./lib/days.mjs"` 的引用一个字都不用改。
export {
  CST_OFFSET_MS,
  DAY_MS,
  cstDateNextStartMs,
  cstDateOf,
  cstDateShift,
  cstDateStartMs,
  cstDayMinus,
  cstToday,
  dateRange,
  nextDateOf,
  prevDateOf,
} from "../../cst.mjs";

export { DATE_RE };

// ---------------------------------------------------------------- 常量

/** 仓库根（scripts/daily/lib/ → 上三级）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const ARCHIVE_LIMIT = 60;

export const DOCS_DIR = path.join(ROOT, "docs");
export const DATA_DIR = path.join(DOCS_DIR, "data");
export const REPORT_DIR = path.join(DOCS_DIR, "report");
export const INDEX_PATH = path.join(DOCS_DIR, "index.html");
export const SUMMARY_JSON_PATH = path.join(DOCS_DIR, "summary.json");
export const SUMMARY_HTML_PATH = path.join(DOCS_DIR, "summary.html");
export const BACKFILL_DIR = path.join(ROOT, "data", "backfill");
// AI 执行结果的 run 级状态（state=failed/ok：哪次 run、哪些日期、provider 逐条失败原因、issue 回填号）：
// 这是运行状态而非站点产物 —— 已 gitignore，不发布、不提交；
// scripts/notify-ai-failure.mjs 读它开/追加常驻 issue（failed）或关闭已恢复的 issue（ok）。
export const AI_FAILURE_PATH = path.join(ROOT, "data", "ai-failure.json");

// ---------------------------------------------------------------- 文件

export function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 原子写入：先写临时文件再 rename。 */
export function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/** 从 Actions 环境变量拼 run URL；本地无 env 时返回 ""（本地演练不写假链接）。 */
export function runUrlFromEnv(env = process.env) {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!server || !repo || !runId) return "";
  return `${server}/${repo}/actions/runs/${runId}`;
}

/** 当前 workflow 名（Actions 注入 GITHUB_WORKFLOW）；本地为空串。 */
export function workflowFromEnv(env = process.env) {
  return String(env.GITHUB_WORKFLOW || "");
}

/**
 * 内容哈希：忽略 generatedAt / ai / aiProvider / aiModel / aiFailure / dataHash，其余参与比较。
 * aiModel / aiFailure 是 AI 运行状态（成败与所用模型），不属于「数据内容」——
 * 同一份数据重跑一次 AI 就可能翻转，不能因此判定「内容有变化」触发重采集。
 */
export function contentHash(data) {
  const { generatedAt, ai, aiProvider, aiModel, aiFailure, dataHash, ...rest } = data;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

/** 扫描一个数据目录，返回所有 <YYYY-MM-DD>.json 的日期（新→旧）。 */
export function listDateStrings(dir = DATA_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && DATE_RE.test(f.slice(0, 10)))
    .map((f) => f.slice(0, 10))
    .sort()
    .reverse();
}

/**
 * 扫描 docs/data，返回最近 limit 天的归档索引条目（新→旧）。
 * 「安静的一天」用可见段口径（讨论/发布/标星/回复也算活动），不能用 data.empty
 * ——否则只发 discussion 的一天会被标成安静的一天。
 */
export function listDays({ dir = DATA_DIR, limit = ARCHIVE_LIMIT } = {}) {
  const dates = listDateStrings(dir).slice(0, limit);
  return dates.map((d) => {
    const j = readJsonIfExists(path.join(dir, `${d}.json`));
    return {
      date: d,
      url: `./report/${d}.html${j?.dataHash ? `?v=${String(j.dataHash).slice(0, 10)}` : ""}`,
      headline_en: j?.ai?.en?.headline ?? null,
      headline_zh: j?.ai?.zh?.headline ?? null,
      hasActivity: hasVisibleActivity(j),
    };
  });
}
