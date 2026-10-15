#!/usr/bin/env node
/**
 * scripts/summary/backfill.mjs
 * ------------------------------------------------------------------
 * 30 天总结 · 历史数据一次性回填 CLI（零依赖 ESM，Node 20+ 内置 fetch）。
 *
 * 背景：/users/:u/events/public 只保留最近 300 条 / 短窗口，30 天窗口的前半段
 * （如 2026-09-17 ~ 10-01）已拿不到动作级事件 —— 这段数据只能用 Search API
 * 按日期区间近似重建（见 lib/github.mjs 的 collectHistoricalData），产物写入
 * data/backfill/<date>.json（结构与 docs/data 同形，额外带 source/backfillLimits）。
 *
 * 为什么是一次性通道、不挂进 workflow：
 *   30 天窗口每天前移一天，回填覆盖的历史日就退出窗口一天 —— 每天重跑只会
 *   越跑越窄，且 Search API 限速约 30 次/分钟、逐日跑纯属浪费；
 *   需要时（窗口口径变化 / 补更早的日期）手动跑一次即可。
 *
 * 可重入：目标文件已存在且无 --force → 跳过（不发任何请求）；
 * --dry-run 只打印摘要不写文件；某一天失败打警告、继续下一天，最后退出码 1。
 *
 * 用法：
 *   node scripts/summary/backfill.mjs --from=YYYY-MM-DD --to=YYYY-MM-DD [--force] [--dry-run]
 * 环境变量：
 *   GITHUB_TOKEN（必需，无 token 时 Search / GraphQL 段基本拿不到数据）
 *   GITHUB_REPOSITORY_OWNER（可选，默认 sogeisetsu）
 */

import path from "node:path";

import {
  BACKFILL_DIR,
  DATE_RE,
  contentHash,
  dateRange,
  readJsonIfExists,
  writeAtomic,
} from "../daily/lib/days.mjs";
import { collectHistoricalData } from "../daily/lib/github.mjs";

const LOG = "[summary.backfill]";
const USAGE = `${LOG} 用法: node scripts/summary/backfill.mjs --from=YYYY-MM-DD --to=YYYY-MM-DD [--force] [--dry-run]`;

/** 一天的人工可读摘要行（日期、totals、各段条数、耗时）。 */
function printDaySummary(data, elapsedMs) {
  const t = data.totals;
  console.log(
    `${LOG} ${data.date}: totals(commits=${t.commits} prs=${t.prs} issues=${t.issues}` +
      ` reviews=${t.reviews}) · commits 段 ${data.commits.length} 仓` +
      ` · pr ${data.pullRequests.length} · issue ${data.issues.length}` +
      ` · review ${data.reviews.length} · release ${data.releases.length}` +
      ` · reply ${data.replies.length} · stateChange ${data.stateChanges.length}` +
      ` · discussion ${data.discussions.length}` +
      ` · automated ${data.automatedCommits} · ${(elapsedMs / 1000).toFixed(1)}s`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const fromArg = argv.find((a) => a.startsWith("--from="));
  const toArg = argv.find((a) => a.startsWith("--to="));
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const from = fromArg ? fromArg.slice("--from=".length) : "";
  const to = toArg ? toArg.slice("--to=".length) : "";
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    console.error(USAGE);
    console.error(`${LOG} --from / --to 缺失或格式非法（需 YYYY-MM-DD）`);
    process.exit(1);
  }
  if (from > to) {
    console.error(`${LOG} --from(${from}) 不能晚于 --to(${to})`);
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN || null;
  const username = process.env.GITHUB_REPOSITORY_OWNER || "sogeisetsu";
  const dates = dateRange(from, to); // 闭区间、升序
  console.log(
    `${LOG} 开始回填: ${from} → ${to}（共 ${dates.length} 天）` +
      ` username=${username} token=${token ? "有" : "无"}${dryRun ? " [dry-run]" : ""}`
  );

  let written = 0;
  let skipped = 0;
  let failed = 0;
  for (const date of dates) {
    const file = path.join(BACKFILL_DIR, `${date}.json`);
    if (!force && readJsonIfExists(file)) {
      console.log(`${LOG} ${date}: 已存在，跳过（--force 可强制重抓）`);
      skipped += 1;
      continue;
    }
    const started = Date.now();
    try {
      // previousData 恒为 null：回填日 stars 段无来源（事件流硬限制），不需要星标基准
      const data = await collectHistoricalData({ token, username, date, previousData: null });
      printDaySummary(data, Date.now() - started);
      if (dryRun) {
        console.log(`${LOG} ${date}: dry-run，不写文件`);
        written += 1; // 计入“处理了”的天数，汇总时单独标注 dry-run
        continue;
      }
      data.dataHash = contentHash(data);
      writeAtomic(file, JSON.stringify(data, null, 2));
      console.log(`${LOG} ${date}: 已写入 ${path.relative(process.cwd(), file)}`);
      written += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `${LOG} ${date}: 失败 —— ${err && err.stack ? err.stack : String(err)}（继续下一天）`
      );
    }
  }

  console.log(
    `${LOG} 汇总: ${dryRun ? "将写入" : "写入"} ${written} 份 · 跳过 ${skipped} 份 · 失败 ${failed} 份` +
      `（输出目录 ${path.relative(process.cwd(), BACKFILL_DIR) || BACKFILL_DIR}）`
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG} 错误: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
});
