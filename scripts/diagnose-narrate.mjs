#!/usr/bin/env node
/**
 * scripts/diagnose-narrate.mjs
 * ------------------------------------------------------------------
 * AI provider 失败诊断的「第二层：LLM 叙述」（零依赖 ESM，Node 20+）。
 *
 * 定位：scripts/diagnose-providers.mjs 已把纯脚本证据写进 data/ai-diagnosis.md（第一层，
 * 不依赖 LLM）；本脚本调用 opencode CLI，让它读那份证据 + 仓库代码，把「哪条腿失效 / 为什么 /
 * 最小 diff」追加到同一个文件末尾。回帖是 workflow 的动作 —— 本脚本只写这一个文件，不碰 GitHub。
 *
 * 为什么把这段逻辑放在脚本里而不是 workflow 的 inline bash：
 *   · 两个生成 workflow（日报 / 总结）要用同一份逻辑，抄两遍必然漂移；
 *   · 需要把 `opencode run --format json` 的 JSONL 事件流抽成纯文本（默认输出会带 ANSI 与
 *     工具调用流水，不适合直接当 issue 正文）；
 *   · 失败路径要写一句「LLM 也起不来」，保证「只有证据段」的回帖照样成立。
 *
 * 失败语义（关键）：**本脚本几乎不失败**。LLM 起不来 / 模型不存在 / 输出为空 → 追加一句
 * `LLM 也起不来…` 后退出 0，于是「证据段照常回帖」这条验收仍然成立；只有连证据文件都写不进去
 * 才退非 0（workflow 里这一步 continue-on-error，最坏也只留一行 ::warning::，绝不阻塞发布）。
 *
 * 用法：node scripts/diagnose-narrate.mjs
 * 环境变量：
 *   DIAG_MODEL    诊断用的模型（默认 opencode-go/deepseek-v4.1-flash；
 *                 Go 整体不可用时换成 sensenova/glm-5.2 —— provider 定义由 workflow 的
 *                 OPENCODE_CONFIG_CONTENT 提供）
 *   OPENCODE_BIN  opencode 可执行文件（默认 `opencode`；本地在 Windows 上跑时指到 .exe）
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";

import { sanitizeReason } from "./daily/lib/ai.mjs";
import { ROOT, writeAtomic } from "./daily/lib/days.mjs";
import { DIAGNOSIS_PROMPT } from "./diagnose-providers.mjs";

// ---------------------------------------------------------------- 常量

const LOG = "[diagnose-narrate]";
const EVIDENCE_PATH = path.join(ROOT, "data", "ai-diagnosis.md");
const SECTION_HEADER = "\n---\n\n## LLM 叙述\n\n";
const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";
// 比 workflow 的 timeout-minutes: 10 早一点收手，让日志里能看到「为什么没产出」而不是被 CI 硬杀
const RUN_TIMEOUT_MS = 9 * 60 * 1000;
const STDERR_KEEP = 200; // 失败原因只留一段，且先脱敏

// ---------------------------------------------------------------- 文本处理

/** 去 ANSI 转义（CLI 的默认输出带颜色，回帖里不能出现）。 */
function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * 从 `opencode run --format json` 的 JSONL 里抽出正文（type=text 的 part）。
 * 事件形态变了（action/CLI 是 @latest，随时可能漂）就退回原始 stdout —— 宁可带点噪音，
 * 也不要因为解析不出来而丢掉整段叙述。
 */
function extractText(stdout) {
  const raw = String(stdout ?? "");
  const parts = [];
  let sawEvent = false;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    sawEvent = true;
    if (ev && ev.type === "text" && ev.part && typeof ev.part.text === "string") {
      parts.push(ev.part.text);
    }
  }
  if (sawEvent) return parts.join("\n\n").trim();
  return stripAnsi(raw).trim();
}

/**
 * LLM 正文的轻量脱敏：只抹掉明确的凭据形态（Bearer / 常见 key 前缀），**保留 URL 与长标识符**。
 *
 * 为什么不直接用 lib/ai.mjs 的 sanitizeReason：它会把任意 ≥24 位 `[A-Za-z0-9_-]` 串也替换掉，
 * 而 `longcat-2.5-preview-free` 恰好就是 24 位 —— 一替换，叙述里所有模型 id 都成 `<redacted>`。
 * （那条腿 2026-10-23 已下线，现用 `deepseek-v4.1-flash` 只有 20 位；这条规则仍然要留着，
 * 因为 id 长度会随模型更换而变，不能靠"当前 id 够短"侥幸。）
 * 证据层（第一层）仍然全程用 sanitizeReason：那边处理的是 provider 返回的异常正文，宁可过杀。
 */
function scrub(text) {
  return String(text ?? "")
    .replace(/Bearer\s+\S+/gi, "<redacted>")
    .replace(/\b(?:sk-|oc_|ck_|ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_-]{6,}/g, "<redacted>");
}

/** 失败时的兜底句：明确写出「LLM 也起不来」，与验收「只剩证据段也成立」对齐。 */
function fallbackLine(model, reason) {
  return `LLM 也起不来：\`${model}\` 调用失败或无输出${reason ? `（${reason}）` : ""} —— 以上为纯脚本原始证据。`;
}

function warn(message) {
  console.log(`::warning::${message}`);
}

// ---------------------------------------------------------------- opencode 调用

/**
 * `opencode run --format json --model <model> <prompt>`。
 * 不用 shell、不做超时以外的重试：CLI 起不来就是「LLM 也起不来」，没有第二条命。
 */
function runOpencode({ bin, model, prompt }) {
  const res = spawnSync(bin, ["run", "--format", "json", "--model", model, prompt], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  const reason = res.error
    ? sanitizeReason(res.error.message)
    : res.status === 0
      ? ""
      : sanitizeReason(res.stderr || `退出码 ${res.status}`);
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout || "",
    reason: reason ? String(reason).slice(0, STDERR_KEEP) : "",
  };
}

// ---------------------------------------------------------------- 主流程

function main() {
  // 证据步是本步的前提（workflow 的 if 依赖它成功），但真出问题也别把整段诊断弄丢：
  // 补一份占位证据，回帖至少还有「哪次失败」的信息。
  if (!existsSync(EVIDENCE_PATH)) {
    writeAtomic(EVIDENCE_PATH, "# AI provider 失败诊断证据\n\n（证据文件缺失：scripts/diagnose-providers.mjs 未产出内容）\n");
    warn("AI 诊断：证据文件不存在，已补一份占位");
  }
  appendFileSync(EVIDENCE_PATH, SECTION_HEADER, "utf8");

  const model = process.env.DIAG_MODEL || DEFAULT_MODEL;
  const bin = process.env.OPENCODE_BIN || "opencode";
  const run = runOpencode({ bin, model, prompt: DIAGNOSIS_PROMPT });
  const text = run.ok ? scrub(extractText(run.stdout)) : "";

  if (text) {
    appendFileSync(EVIDENCE_PATH, `${text}\n`, "utf8");
    console.log(`${LOG} 已追加 LLM 叙述（model=${model}，${text.length} 字节）`);
    return;
  }
  appendFileSync(EVIDENCE_PATH, `${fallbackLine(model, run.reason)}\n`, "utf8");
  warn(`AI 诊断-叙述：LLM 没有产出（model=${model}）${run.reason ? `：${run.reason}` : ""}`);
}

try {
  main();
} catch (err) {
  // 连文件都写不进去：退非 0 交给 continue-on-error（生成物早已发布，绝不阻塞）
  console.error(`${LOG} 错误: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
}
