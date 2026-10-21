#!/usr/bin/env node
/**
 * scripts/diagnose-providers.mjs
 * ------------------------------------------------------------------
 * AI provider 失败诊断的「纯脚本证据层」（零依赖 ESM，Node 20+ 内置 fetch）。
 *
 * 定位：日报 / 30 天总结的 AI 叙述**全失败**时，notify-ai-failure.mjs 会新建常驻
 * `ai-failure` issue；两个生成 workflow 在那之后追加一步诊断。诊断分两层，本脚本是**第一层**：
 * 完全不依赖任何 LLM —— `/models` 端点可用性与「本仓写死的 model 是否还在」是纯 HTTP + 机械对账，
 * 所以 OpenCode Go 整条腿挂掉时它照样产出（否则「agent 与被测腿同源」会让诊断跟着一起死）。
 * 第二层（LLM 叙述）由 scripts/diagnose-narrate.mjs 追加进同一份文件。
 *
 * 产出 data/ai-diagnosis.md（gitignore 的运行状态：不发布、不提交、不进 docs/），四段：
 *   1. 失败记录：读 data/ai-failure.json 的 attempts（provider / model / reason，已脱敏）
 *      + scope / dates / window / pageState / run
 *   2. provider 现状：逐条 `GET <baseUrl>/models`（带各自 key），只记录 HTTP 状态、模型数量、
 *      本仓写死的 model id 是否在列表里、以及「家族前缀相近」的候选 id（判断改名用）
 *   3. 机械对账结论：model 不在列表 → 疑似改名/下架；HTTP 401/403 → 凭据失效；
 *      `/models` 取不到 → 疑似整体不可用。只做机械判断，不做判断性叙述（那是第二层的事）
 *   4. 证据的时间戳与来源 URL，便于人工复核
 *
 * 同一份文件也是 issue 回帖的正文（回帖是 workflow 的动作，不是 LLM 的动作）——
 * 所以本文件里绝不出现 key / token / 凭据；异常文本一律先过 sanitizeReason。
 * 首行是一条机器标记 `<!-- ai-diagnosis ... -->`，回帖 step 用它做「同一失败事件不重复贴」的去重。
 *
 * provider 目录不在此抄一份：name / baseUrl / model / 链顺序全部来自 lib/ai.mjs 的
 * `defaultProviders`（总结线再用 `orderProvidersForSummary` 对齐实际尝试顺序），
 * 所以 ai.mjs 改了模型或端点，这里自动跟上。
 *
 * 用法：
 *   node scripts/diagnose-providers.mjs            # 采集证据 → 写 data/ai-diagnosis.md
 *   node scripts/diagnose-providers.mjs --prompt   # 只打印「自动档 / `/oc`」共用的诊断提示词
 *
 * 环境变量：OPENCODE_API_KEY / SENSENOVA_API_KEY（缺哪条就只把它标成「未配置」，不探查也不报错）；
 *           GITHUB_RUN_ID（本地无此变量时标记为 local）。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { defaultProviders, orderProvidersForSummary, sanitizeReason } from "./daily/lib/ai.mjs";
import { AI_FAILURE_PATH, ROOT, readJsonIfExists, writeAtomic } from "./daily/lib/days.mjs";

// ---------------------------------------------------------------- 常量

const LOG = "[diagnose-providers]";
const OUT_PATH = path.join(ROOT, "data", "ai-diagnosis.md");
const MODELS_TIMEOUT_MS = 20000; // /models 只是列目录：20s 足够，且别把诊断拖成发布阻塞
const NEAR_MATCH_CAP = 5; // 「家族相近」候选 id 最多列 5 个（只是判断改名的线索，不是全量列表）

/** provider 名 → 它需要的环境变量名（只用于「未配置」时的提示文本，不参与探查）。 */
const KEY_ENV = {
  "opencode-go-minimax": "OPENCODE_API_KEY",
  "opencode-go-longcat": "OPENCODE_API_KEY",
  "opencode-go-deepseek": "OPENCODE_API_KEY",
  sensenova: "SENSENOVA_API_KEY",
};

// ---------------------------------------------------------------- 共享提示词

/**
 * 诊断提示词 —— **自动档的「诊断-叙述」step 与手动 `/oc` 入口共用同一份**，避免两处漂移。
 * 由 `--prompt` 打印；两个生成 workflow 与 .github/workflows/opencode.yml 都通过它取，
 * 谁都不许各自抄一份。scripts/diagnose-narrate.mjs 直接 import 本常量（同一份，无副本）。
 */
export const DIAGNOSIS_PROMPT = [
  "你在本仓（sogeisetsu/sogeisetsu）的 CI 检出里做一次 AI provider 失败诊断；这是失败诊断，不是日常开发任务。",
  "",
  "输入证据：`data/ai-diagnosis.md` 里已经有一份纯脚本采集的证据（失败记录 + 各 provider `/models` 现状 + 机械对账结论）。",
  "请再读 `scripts/daily/lib/ai.mjs`（provider 链 `defaultProviders` / `orderProvidersForSummary`、单腿尝试 `attemptProvider`）与 `scripts/notify-ai-failure.mjs`，把证据与代码对上。",
  "",
  "只输出下面三段 markdown，不要别的章节：",
  "",
  "### 哪条腿失效",
  "逐条 provider / model 说明：成功 / 失败 / 未配置，以及失败落在链的哪一环（形态切换、JSON 模式退让、截断重试、校验拒绝、网络与超时等）。",
  "",
  "### 为什么",
  "给出最可能的根因（模型 id 改名或下架、凭据失效、限流、超时、输出被截断、输出不合校验等），每条都指向证据里的具体行；证据不足就写「不确定」并说明还缺哪条证据。",
  "",
  "### 最小 diff 建议",
  "给出可直接落地的最小改动（文件路径 + 行号 + 改动前后）。不要重构，不要改数字口径、生成链路与产物。",
  "",
  "硬约束：",
  "- 你的输出会被追加进 `data/ai-diagnosis.md`，并作为公开仓库 issue 评论的正文发布 —— 绝不输出任何 key、token、凭据或私有仓库信息。",
  "- 只读地看代码：不要写文件、不要提交、不要推送、不要评论 issue、不要做任何 `gh` 写操作；把结论写到标准输出即可。",
  "- 中文叙述；文件路径、代码、标识符保持原文。",
  "- 证据显示两条腿都不可用、或你判断不出来时，明确写「LLM 无法给出结论」，只复述证据事实。",
].join("\n");

// ---------------------------------------------------------------- provider 目录

/**
 * 全量 provider 目录 + 本进程哪几条腿真的配了 key。
 *
 * 为什么要跑两遍 `defaultProviders`：它按「有没有 key」过滤，直接调用拿不到「未配置的腿」——
 * 而诊断恰恰要说清「哪条腿没配」。所以再用占位 key 跑一遍拿全量 name / baseUrl / model；
 * 占位 key 绝不用于任何网络请求（探查只对 configured 的腿发起）。
 * model id 与顺序永远跟着 ai.mjs 走，本脚本不抄第二份。
 */
function providerCatalogue(env = process.env) {
  const configuredNames = new Set(defaultProviders(env).map((p) => p.name));
  const all = defaultProviders({
    ...env,
    OPENCODE_API_KEY: env.OPENCODE_API_KEY || "unconfigured",
    SENSENOVA_API_KEY: env.SENSENOVA_API_KEY || "unconfigured",
  });
  return all.map((p) => ({ ...p, configured: configuredNames.has(p.name) }));
}

/** 实际尝试顺序：总结线把 deepseek 提前（与 ai.mjs 的 orderProvidersForSummary 同口径）。 */
function orderForScope(catalogue, scope) {
  return scope === "summary" ? orderProvidersForSummary(catalogue) : catalogue;
}

// ---------------------------------------------------------------- /models 探查

/**
 * 该 provider 的 `/models` 列表端点。
 *
 * OpenAI 兼容形态直接在 baseUrl 后接 `/models`（商汤：`/v1/models`）。
 * OpenCode Go 是例外：它的 chat 走 `/inference/go/openai/v1/chat/completions`，
 * 列表端点却在 `/inference/go/v1/models` —— 实测 `/openai/v1/models` 是 404（空响应），
 * 而 `/go/v1/models` 会带结构化鉴权错误（说明路由存在）。所以把 `/openai/v1` 换回 `/v1`。
 * 这里不写死完整 URL：baseUrl 变了它跟着变，只有「Go 的列表在 Go 根下」这一条形状假设。
 */
function modelsUrl(provider) {
  const base = String(provider.baseUrl || "").replace(/\/+$/, "");
  return `${base.replace(/\/openai\/v1$/, "/v1")}/models`;
}

/**
 * `GET <modelsUrl>`。只记录 HTTP 状态、模型数量、目标 model 是否在列表里，
 * 异常正文走 sanitizeReason 后截断。任何失败都返回对象、绝不抛异常
 * —— 证据层必须能写下去（它的存在意义就是「其他都挂了」时还活着）。
 */
async function probeModels(provider) {
  const url = modelsUrl(provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        // provider 自定义头（OpenCode Go 要求自报 user-agent + 会话 id）原样带上
        ...(provider.headers && typeof provider.headers === "object" ? provider.headers : {}),
      },
      signal: controller.signal,
    });
    const body = await res.text().catch(() => "");
    return {
      url,
      status: res.status,
      ok: res.ok,
      ids: parseModelIds(body),
      bodySnippet: res.ok ? "" : sanitizeReason(body),
      error: "",
    };
  } catch (err) {
    return {
      url,
      status: null,
      ok: false,
      ids: null,
      bodySnippet: "",
      error: sanitizeReason(err && err.message ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 从 /models 响应体里抽模型 id（OpenAI 形态 data[].id，兼容 models[].id/name）；解析不出返回 null。 */
function parseModelIds(body) {
  let json;
  try {
    json = JSON.parse(String(body || ""));
  } catch {
    return null;
  }
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : null;
  if (!arr) return null;
  return arr.map((m) => String((m && (m.id ?? m.name)) ?? "")).filter(Boolean);
}

/** 家族前缀（`longcat-2.5-preview-free` → `longcat`）：用于「改名后可能叫什么」的线索。 */
function familyPrefix(model) {
  return String(model || "").split("-")[0].toLowerCase();
}

/** 机械对账：一条腿一条结论，只做规则判断，不做判断性叙述。 */
function reconcile(provider, probe) {
  if (!provider.configured) {
    const env = KEY_ENV[provider.name] || "对应的 API key";
    return `未配置（缺 \`${env}\`），未探查`;
  }
  if (probe.error) return `\`/models\` 取不到（${probe.error}）→ 疑似整体不可用`;
  if (probe.status === 401 || probe.status === 403) return `HTTP ${probe.status} → 该端点鉴权被拒（疑似凭据失效 / 过期）`;
  if (probe.status >= 500) return `HTTP ${probe.status} → provider 服务侧异常（非本仓可修）`;
  if (!probe.ok) {
    return `HTTP ${probe.status} → 非预期响应${probe.bodySnippet ? `：${probe.bodySnippet}` : ""}`;
  }
  if (probe.ids === null) return "HTTP 200，但响应不是可解析的模型列表 → 端点形态可能变了";
  if (!probe.ids.includes(provider.model)) {
    return `本仓写死的 model \`${provider.model}\` 不在 /models 列表里（共 ${probe.ids.length} 个）→ 疑似改名 / 下架`;
  }
  return `model 在 /models 列表中（共 ${probe.ids.length} 个）`;
}

/** 把失败记录里的 attempt 与探查结果对上：同一 provider 同一 HTTP 码 → 标注「与失败记录一致」。 */
function correlation(record, provider, probe) {
  const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
  const hit = attempts.find((a) => a && a.provider === provider.name);
  if (!hit) return "";
  if (probe.status && new RegExp(`HTTP ${probe.status}\\b`).test(String(hit.reason || ""))) {
    return `（与失败记录一致：\`${provider.name}\` 本次也报了 HTTP ${probe.status}）`;
  }
  return "";
}

// ---------------------------------------------------------------- 证据拼装

/** 证据的生成时间戳（ISO，UTC）。 */
const stamp = () => new Date().toISOString();

/** 表格单元格：转义竖线与换行（正文里的 reason 可能带管道符）。 */
function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "—";
}

/** 第 1 段：失败记录。记录不存在时如实说明（本地跑或 ·没做 AI 尝试· 时就是这种）。 */
function failureSection(record) {
  const lines = ["## 1. 失败记录（`data/ai-failure.json`）", ""];
  if (!record) {
    lines.push("本次没读到 `data/ai-failure.json`（本地演练、或这次运行根本没做 AI 尝试）。下面只有 provider 现状。");
    return lines;
  }
  lines.push(`- scope：\`${record.scope ?? "?"}\``);
  if (record.scope === "summary") {
    lines.push(`- 窗口：\`${record.windowStart ?? "?"} ~ ${record.windowEnd ?? "?"}\``);
    lines.push("- dates：—（总结是窗口口径）");
  } else {
    const dates = Array.isArray(record.dates) ? record.dates : [];
    lines.push(`- dates：${dates.length ? dates.map((d) => `\`${d}\``).join(", ") : "—"}`);
  }
  lines.push(`- pageState：\`${record.pageState ?? "?"}\``);
  if (record.workflow) lines.push(`- workflow：\`${record.workflow}\``);
  if (record.runUrl) lines.push(`- Run：${record.runUrl}`);
  if (record.issue && record.issue.number) lines.push(`- 常驻 issue：#${record.issue.number}`);
  lines.push(`- 记录生成的 generatedAt：\`${record.generatedAt ?? "?"}\``);
  lines.push("");
  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  if (attempts.length === 0) {
    lines.push("逐条 attempt：—（记录里没有 attempt，通常是一个 provider key 都没配）");
    return lines;
  }
  lines.push("逐条 attempt（reason 已脱敏）：");
  attempts.forEach((a, i) => {
    const provider = (a && a.provider) || "未知 provider";
    const model = a && a.model != null ? ` / \`${a.model}\`` : "";
    const reason = sanitizeReason(a && a.reason).replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. \`${provider}\`${model}：${reason || "—"}`);
  });
  return lines;
}

/** 第 2 段：provider 现状表 + 逐条明细。 */
function providerSection(rows) {
  const lines = ["## 2. provider `/models` 现状", ""];
  lines.push("| provider | model（本仓写死） | 配置 | `GET /models` | 模型数 | 该 model 在列表 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const { provider, probe } of rows) {
    if (!provider.configured) {
      lines.push(`| \`${provider.name}\` | \`${provider.model}\` | 未配置 | 未探查 | — | — |`);
      continue;
    }
    const http = probe.error ? "网络失败" : `${probe.status}`;
    const count = probe.ids ? String(probe.ids.length) : "—";
    const hit = probe.ids ? (probe.ids.includes(provider.model) ? "✅" : "❌") : "—";
    lines.push(
      `| \`${provider.name}\` | \`${provider.model}\` | 已配置 | ${cell(http)} | ${count} | ${hit} |`
    );
  }
  lines.push("");
  lines.push("逐条明细：");
  for (const { provider, probe } of rows) {
    const near = probe.ids
      ? probe.ids
          .filter((id) => id.toLowerCase().startsWith(familyPrefix(provider.model)))
          .slice(0, NEAR_MATCH_CAP)
      : [];
    const nearText = near.length
      ? `；家族相近的 id（改名线索）：${near.map((id) => `\`${id}\``).join(", ")}`
      : "";
    lines.push(`- \`${provider.name}\`：\`GET ${probe.url}\` → ${reconcile(provider, probe)}${nearText}`);
  }
  return lines;
}

/** 第 3 段：机械对账结论。 */
function reconcileSection(rows, record) {
  const lines = ["## 3. 机械对账结论（脚本规则，不含推测性叙述）", ""];
  const configured = rows.filter((r) => r.provider.configured);
  for (const { provider, probe } of configured) {
    lines.push(`- \`${provider.name}\` / \`${provider.model}\`：${reconcile(provider, probe)}${correlation(record, provider, probe)}`);
  }
  for (const { provider } of rows.filter((r) => !r.provider.configured)) {
    lines.push(`- \`${provider.name}\` / \`${provider.model}\`：未配置（缺 \`${KEY_ENV[provider.name] || "对应的 API key"}\`），本次不是它。`);
  }
  if (configured.length === 0) {
    lines.push("- ⚠️ 一条腿都没配 key：无法用 `/models` 对账，只能看第 1 段的失败记录。");
  } else if (configured.every((r) => r.probe.error)) {
    lines.push("- ⚠️ 所有已配置的腿都取不到 `/models` → 疑似整体不可用（本地网络 / key / 端点三者都可能）。");
  }
  // Go 列表端点的鉴权口径与 chat 不一致（实测）：同一 key chat 调用成功、/models 却回 401
  // api_key_expired —— 所以 401 只等于「列表端点被拒」，不能直接推成「key 一定不可用」。
  if (configured.some((r) => /^opencode-go-/.test(r.provider.name) && (r.probe.status === 401 || r.probe.status === 403))) {
    lines.push("");
    lines.push(
      "- 注意（实测口径）：OpenCode Go 的 `/models` 与 chat 的鉴权**可能不一致** —— 同一 key 实测 chat 调用成功、`/models` 却回 401 `api_key_expired`。所以 Go 腿的 401 只说明「列表端点被拒」，不等价于「key 一定不可用」，请结合第 1 段失败记录判断。"
    );
  }
  return lines;
}

/** 第 4 段：来源与时间戳（人工复核用）。 */
function sourceSection(rows) {
  const lines = ["## 4. 证据来源与时间戳", ""];
  lines.push(`- 本文件生成时间（UTC）：\`${stamp()}\``);
  lines.push(`- 采集脚本：\`node scripts/diagnose-providers.mjs\`（零依赖、不调 LLM）`);
  lines.push(`- 复现：\`node scripts/diagnose-providers.mjs\`；提示词：\`node scripts/diagnose-providers.mjs --prompt\``);
  for (const { provider, probe } of rows) {
    if (!provider.configured) continue;
    lines.push(`- \`${provider.name}\` 的 \`/models\`：${probe.url}`);
  }
  lines.push(`- key 与 token 一律不落盘：异常文本先过 \`sanitizeReason\``);
  return lines;
}

/**
 * 采集 + 拼装整份证据。返回 { markdown, summary }：summary 只用于 Actions 日志的一行摘要。
 * 导出是为了让本地/测试可以直接拿字符串，不用碰文件。
 */
export async function buildEvidence() {
  const record = readJsonIfExists(AI_FAILURE_PATH);
  const catalogue = orderForScope(providerCatalogue(), record?.scope);
  const rows = [];
  for (const provider of catalogue) {
    // 未配置的腿不发请求（apiKey 是占位串，拿它发请求毫无意义且会污染凭据日志）
    const probe = provider.configured
      ? await probeModels(provider)
      : { url: modelsUrl(provider), status: null, ok: false, ids: null, bodySnippet: "", error: "" };
    rows.push({ provider, probe });
  }

  const generatedAt = record?.generatedAt || stamp();
  const marker = `<!-- ai-diagnosis run=${process.env.GITHUB_RUN_ID || "local"} generatedAt=${generatedAt} -->`;
  const markdown = [
    marker,
    "",
    "# AI provider 失败诊断证据",
    "",
    "由 `scripts/diagnose-providers.mjs` 在 AI 叙述全失败后自动采集（纯脚本，不依赖 LLM）。",
    "provider 链与 model id 取自 `scripts/daily/lib/ai.mjs`，此处不复制第二份。",
    "",
    ...failureSection(record),
    "",
    ...providerSection(rows),
    "",
    ...reconcileSection(rows, record),
    "",
    ...sourceSection(rows),
    "",
  ].join("\n");

  const configured = rows.filter((r) => r.provider.configured);
  const abnormal = configured.filter((r) => !r.probe.ok || r.probe.ids === null || !r.probe.ids.includes(r.provider.model));
  return {
    markdown,
    summary: `provider=${rows.length} 已配置=${configured.length} 异常=${abnormal.length}`,
  };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--prompt")) {
    process.stdout.write(`${DIAGNOSIS_PROMPT}\n`);
    return;
  }
  const { markdown, summary } = await buildEvidence();
  writeAtomic(OUT_PATH, markdown);
  console.log(`${LOG} 已写 ${path.relative(ROOT, OUT_PATH)}（${markdown.length} 字节，${summary}）`);
}

// 仅当作为入口直接执行时跑 CLI（被 import 时不执行；diagnose-narrate.mjs 直接 import 提示词常量）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    // 证据层自己坏了就退非 0：workflow 里这一步 continue-on-error，只留 ::warning::，绝不阻塞发布
    console.error(`${LOG} 错误: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
  });
}
