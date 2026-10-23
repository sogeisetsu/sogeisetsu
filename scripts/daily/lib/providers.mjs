#!/usr/bin/env node
/**
 * scripts/daily/lib/providers.mjs
 * ------------------------------------------------------------------
 * provider 配置层的唯一事实来源（零依赖 ESM，零网络）。
 *
 * 职责边界：
 *   · `config/providers.json` 是「哪条链用哪些模型、每个模型什么参数、整条链最多跑多久」的唯一出处；
 *     本模块只做读配置 → 解析成 `ai.mjs` 认的 provider 对象，以及安全的写操作（纯函数，输入输出都是配置对象）。
 *   · 网络探测（真实跑一次叙述）与 `gh` 调用不在这里：那两样是 `scripts/providers.mjs`（薄 CLI）的事，
 *     本模块的写入口接受注入的 `probeImpl` / `ghImpl`，所以测试可以不触网、不碰凭据。
 *
 * 导出：
 *   loadConfig(configPath?)                   → { ok, config } | { ok:false, errors }
 *   validateConfig(config)                    → { ok, errors }
 *   catalogue(env?, opts?)                    → 全部 model（含未进任何 lane 的）+ 每条的 key/lane 现状
 *   providersForLane(lane, env?, opts?)       → 该 lane 的 provider 对象（跳过 enabled:false / 缺 key）
 *   providerForSlug(slug, env?, opts?)        → { provider, reason }（单条，供探测用）
 *   laneOrder(lane, opts?) / laneBudgetMs(lane, opts?)
 *   addProvider(spec, opts?)                  → add 命令的编排：预览 diff → 探测门槛 → 落盘 → 推 secret
 *   addModel / laneAdd / laneMove / laneRemove / setPath / setEnabled   纯写操作（返回新配置）
 *   unifiedDiff(before, after, opts?)         → 最小 unified diff（零依赖，供所有写操作打印）
 *   checkWorkflowWiring(opts?)                → workflow 接线硬断言（纯文本扫描，不引 YAML 库）
 *   statusReport(opts?)                       → 本机 env / repo secret / 配置 三方对照
 *
 * 配置缺失 / JSON 损坏 / schema 不合法 → **warn + 回落内置 FALLBACK_CHAIN（deepseek → sensenova）**：
 * CI 不能因为一个坏 JSON 全挂；`node scripts/providers.mjs check`（check.mjs 里会跑）让坏配置在提交前就红。
 *
 * 安全线：配置里只允许 `keyEnv`（环境变量名），永不存明文 key；所有输出不打印 key 值（只 name/长度/sha256 前 8 位）。
 *
 * 用法（诊断 / 目测）：
 *   node -e "import('./scripts/daily/lib/providers.mjs').then(m=>console.log(m.providersForLane('daily')))"
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

import { ROOT } from "../../lib/paths.mjs";

const LOG = "[providers]";

// ROOT 的唯一来源是 scripts/lib/paths.mjs（零依赖）。刻意不 import days.mjs：那边会带进渲染层。
export const CONFIG_PATH = path.join(ROOT, "config", "providers.json");
export const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
export const CONFIG_VERSION = 1;

/** `params` 允许的字段（少开口子 = 少一处能配错的地方）。 */
export const PARAM_KEYS = ["reasoningEffort", "extraBody", "responseFormat"];

/**
 * 内置兜底链 —— **只在配置不可用时**使用（缺失 / JSON 坏 / schema 不合法）。
 * 内容是「历史默认」的最小副本：先 Go 的 deepseek，再商汤。它与配置里那两条腿必须保持同一口径，
 * 否则坏配置的那次运行会悄悄换成另一条链。改配置时不要动这里（它是灾备，不是事实来源）。
 */
export const FALLBACK_CHAIN = Object.freeze([
  Object.freeze({
    name: "opencode-go-deepseek",
    endpoint: "opencode-go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    keyEnv: "OPENCODE_API_KEY",
    headers: Object.freeze({
      "user-agent": "sogeisetsu-daily-report/1.0 (+https://github.com/sogeisetsu/sogeisetsu)",
      "x-opencode-session": "sogeisetsu-daily-report-${session}",
    }),
    model: "deepseek-v4.1-flash",
    shape: "chat",
  }),
  Object.freeze({
    name: "sensenova",
    endpoint: "sensenova",
    baseUrl: "https://token.sensenova.cn/v1",
    keyEnv: "SENSENOVA_API_KEY",
    model: "glm-5.2",
    shape: "chat",
    extraBody: Object.freeze({ thinking: Object.freeze({ type: "disabled" }) }),
  }),
]);
const FALLBACK_SLUGS = FALLBACK_CHAIN.map((p) => p.name);

// ---------------------------------------------------------------- 小工具

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const clone = (v) => JSON.parse(JSON.stringify(v));

/** deepseek 等模型的 `/models` 端点：配置里给了 `modelsUrl` 就用它，否则按 `<baseUrl>/models` 派生。 */
function deriveModelsUrl(ep) {
  if (isStr(ep?.modelsUrl)) return ep.modelsUrl.replace(/\/+$/, "");
  const base = String(ep?.baseUrl || "").replace(/\/+$/, "");
  return `${base}/models`;
}

/** 环境里这个 endpoint 的 key 与它的实际来源变量名（别名优先于规范名？不：规范名优先，别名只是本地便利）。 */
export function resolveApiKey(ep, env = process.env) {
  const names = [ep?.keyEnv, ...(Array.isArray(ep?.keyEnvAliases) ? ep.keyEnvAliases : [])].filter(isStr);
  for (const name of names) {
    const value = env?.[name];
    if (isStr(value)) return { envVar: name, value };
  }
  return { envVar: null, value: null };
}

function expandHeaders(headers, session) {
  if (!isObj(headers)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = String(v).replaceAll("${session}", session);
  }
  return out;
}

// ---------------------------------------------------------------- schema

/**
 * 校验配置结构。返回 { ok, errors }：errors 是中文短句，直接给 CLI 打印。
 *
 * 有意只校验「错了一定会出问题」的东西（README 里 schema 说清其余约束）：
 * version / endpoints 必有 baseUrl+keyEnv / models.endpoint 必须存在 / 同 endpoint 下 apiModel 不重复 /
 * lane 只许引用存在的 slug、不许重复 / params 只许三个已知字段 / budgetMs 必须是正数。
 */
export function validateConfig(config) {
  const errors = [];
  if (!isObj(config)) return { ok: false, errors: ["配置根节点必须是 JSON 对象"] };
  if (config.version !== CONFIG_VERSION) {
    errors.push(`version 必须是 ${CONFIG_VERSION}（当前 ${JSON.stringify(config.version)}）`);
  }

  const endpoints = config.endpoints;
  if (!isObj(endpoints) || Object.keys(endpoints).length === 0) {
    errors.push("endpoints 必须是非空对象");
  } else {
    for (const [name, ep] of Object.entries(endpoints)) {
      if (!isObj(ep)) {
        errors.push(`endpoints.${name} 必须是对象`);
        continue;
      }
      if (!isStr(ep.baseUrl)) errors.push(`endpoints.${name}.baseUrl 必须是非空字符串`);
      else if (!/^https?:\/\//i.test(ep.baseUrl)) {
        errors.push(`endpoints.${name}.baseUrl 必须以 http(s):// 开头`);
      }
      if (!isStr(ep.keyEnv)) errors.push(`endpoints.${name}.keyEnv 必须是非空字符串（环境变量名）`);
      else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ep.keyEnv)) {
        errors.push(`endpoints.${name}.keyEnv 必须是合法的环境变量名（当前 ${JSON.stringify(ep.keyEnv)}）`);
      }
      if (ep.keyEnvAliases !== undefined) {
        const aliases = ep.keyEnvAliases;
        if (!Array.isArray(aliases) || aliases.some((a) => !isStr(a))) {
          errors.push(`endpoints.${name}.keyEnvAliases 必须是字符串数组`);
        }
      }
      if (ep.shape !== undefined && ep.shape !== "chat" && ep.shape !== "responses") {
        errors.push(`endpoints.${name}.shape 只能是 "chat" / "responses"（当前 ${JSON.stringify(ep.shape)}）`);
      }
      if (ep.enabled !== undefined && typeof ep.enabled !== "boolean") {
        errors.push(`endpoints.${name}.enabled 必须是布尔值`);
      }
      if (ep.modelsUrl !== undefined && !isStr(ep.modelsUrl)) {
        errors.push(`endpoints.${name}.modelsUrl 必须是非空字符串`);
      }
      if (ep.headers !== undefined) {
        if (!isObj(ep.headers) || Object.values(ep.headers).some((v) => typeof v !== "string")) {
          errors.push(`endpoints.${name}.headers 必须是「header 名 → 字符串」对象`);
        }
      }
    }
  }

  const models = config.models;
  const seenApiModels = new Map(); // `${endpoint}\u0000${apiModel}` → slug
  if (!isObj(models) || Object.keys(models).length === 0) {
    errors.push("models 必须是非空对象");
  } else {
    for (const [slug, m] of Object.entries(models)) {
      if (!isObj(m)) {
        errors.push(`models.${slug} 必须是对象`);
        continue;
      }
      if (!isStr(m.endpoint)) errors.push(`models.${slug}.endpoint 必须是非空字符串`);
      else if (isObj(endpoints) && !isObj(endpoints[m.endpoint])) {
        errors.push(`models.${slug}.endpoint 指向不存在的 endpoint：${JSON.stringify(m.endpoint)}`);
      }
      if (!isStr(m.apiModel)) errors.push(`models.${slug}.apiModel 必须是非空字符串`);
      if (m.enabled !== undefined && typeof m.enabled !== "boolean") {
        errors.push(`models.${slug}.enabled 必须是布尔值`);
      }
      if (m.note !== undefined && typeof m.note !== "string") {
        errors.push(`models.${slug}.note 必须是字符串`);
      }
      if (isStr(m.endpoint) && isStr(m.apiModel)) {
        const key = `${m.endpoint}\u0000${m.apiModel}`;
        if (seenApiModels.has(key)) {
          errors.push(
            `models.${slug} 与 models.${seenApiModels.get(key)} 在 endpoint \`${m.endpoint}\` 下用了同一个 apiModel：\`${m.apiModel}\``
          );
        } else {
          seenApiModels.set(key, slug);
        }
      }
      if (m.params !== undefined) {
        if (!isObj(m.params)) {
          errors.push(`models.${slug}.params 必须是对象`);
        } else {
          for (const k of Object.keys(m.params)) {
            if (!PARAM_KEYS.includes(k)) {
              errors.push(`models.${slug}.params.${k} 不是已知字段（只允许 ${PARAM_KEYS.join(" / ")}）`);
            }
          }
          const { reasoningEffort, extraBody, responseFormat } = m.params;
          if (reasoningEffort !== undefined && !isStr(reasoningEffort)) {
            errors.push(`models.${slug}.params.reasoningEffort 必须是非空字符串`);
          }
          if (extraBody !== undefined && !isObj(extraBody)) {
            errors.push(`models.${slug}.params.extraBody 必须是对象（合并进 chat 请求体）`);
          }
          if (responseFormat !== undefined && typeof responseFormat !== "boolean") {
            errors.push(`models.${slug}.params.responseFormat 必须是布尔值（false = 从不发 json_object）`);
          }
        }
      }
    }
  }

  const lanes = config.lanes;
  if (!isObj(lanes) || Object.keys(lanes).length === 0) {
    errors.push("lanes 必须是非空对象");
  } else {
    for (const required of ["daily", "summary"]) {
      if (!isObj(lanes[required])) errors.push(`lanes.${required} 必须存在（日报 / 30 天总结各读自己那条链）`);
    }
    for (const [name, lane] of Object.entries(lanes)) {
      if (!isObj(lane)) {
        errors.push(`lanes.${name} 必须是对象`);
        continue;
      }
      if (!Array.isArray(lane.order) || lane.order.length === 0) {
        errors.push(`lanes.${name}.order 必须是非空数组`);
        continue;
      }
      const seen = new Set();
      for (const slug of lane.order) {
        if (!isStr(slug)) {
          errors.push(`lanes.${name}.order 的元素必须是非空字符串`);
          continue;
        }
        if (isObj(models) && !isObj(models[slug])) {
          errors.push(`lanes.${name}.order 引用了不存在的 model：\`${slug}\``);
        }
        if (seen.has(slug)) errors.push(`lanes.${name}.order 里 \`${slug}\` 重复`);
        seen.add(slug);
      }
      if (lane.budgetMs !== undefined) {
        if (!Number.isFinite(lane.budgetMs) || lane.budgetMs <= 0) {
          errors.push(`lanes.${name}.budgetMs 必须是正数（毫秒）`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 读配置。**不抛异常**：返回 { ok:true, config } 或 { ok:false, errors }。
 * `configPath` 可注入（测试用临时文件）。
 */
export function loadConfig(configPath = CONFIG_PATH) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    return { ok: false, config: null, errors: [`读不到 ${path.relative(ROOT, configPath) || configPath}（${err?.code || err?.message}）`] };
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    return { ok: false, config: null, errors: [`配置不是合法 JSON：${err?.message || String(err)}`] };
  }
  const checked = validateConfig(config);
  if (!checked.ok) return { ok: false, config: null, errors: checked.errors };
  return { ok: true, config, errors: [] };
}

let warnedFallback = false;

/** 回落告警只打一次（一次运行里三处调用不该刷三遍同样的 warn）。 */
function warnFallbackOnce(errors, configPath) {
  if (warnedFallback) return;
  warnedFallback = true;
  console.error(
    `${LOG} ⚠️ 配置不可用（${path.relative(ROOT, configPath) || configPath}），回落到内置 FALLBACK_CHAIN「${FALLBACK_SLUGS.join(" → ")}」：${errors.join("；")}`
  );
  console.error(`${LOG} 跑 \`node scripts/providers.mjs check\` 看完整校验，别让坏配置进 CI`);
}

/** 测试用：让下一次回落告警重新出现。 */
export function resetFallbackWarning() {
  warnedFallback = false;
}

// ---------------------------------------------------------------- lane 解析

function buildProvider(slug, model, ep, env, session) {
  const { value: apiKey } = resolveApiKey(ep, env);
  const params = isObj(model.params) ? model.params : {};
  const provider = {
    name: slug,
    endpoint: String(model.endpoint),
    baseUrl: String(ep.baseUrl).replace(/\/+$/, ""),
    apiKey,
    model: String(model.apiModel),
    shape: ep.shape === "responses" ? "responses" : "chat",
    ...(isObj(ep.headers) ? { headers: expandHeaders(ep.headers, session) } : {}),
    ...(isStr(params.reasoningEffort) ? { reasoningEffort: params.reasoningEffort } : {}),
    ...(isObj(params.extraBody) ? { extraBody: params.extraBody } : {}),
    ...(params.responseFormat === false ? { responseFormat: false } : {}),
  };
  return provider;
}

/** 内置兜底链 → provider 对象（缺 key 的照样跳过，与正常路径同口径）。 */
function fallbackProviders(env, session) {
  const list = [];
  for (const leg of FALLBACK_CHAIN) {
    const { value: apiKey } = resolveApiKey(leg, env);
    if (!apiKey) continue;
    list.push({
      ...clone(leg),
      apiKey,
      ...(isObj(leg.headers) ? { headers: expandHeaders(leg.headers, session) } : {}),
    });
  }
  return list;
}

function configLaneOrder(config, lane) {
  const order = config?.lanes?.[lane]?.order;
  return Array.isArray(order) ? order : [];
}

/**
 * 该 lane 的 provider 列表（`ai.mjs` 的 `defaultProviders` 就等价 `providersForLane("daily")`）。
 *
 * 跳过规则：model `enabled:false` / endpoint `enabled:false` / 缺 key（`keyEnv` 或 `keyEnvAliases` 都没值）。
 * `${session}` 在一次调用里只展开成**同一个** UUID —— 一次运行 = 一个会话。
 */
export function providersForLane(lane, env = process.env, opts = {}) {
  const configPath = opts.configPath || CONFIG_PATH;
  const session = randomUUID();
  const loaded = loadConfig(configPath);
  if (!loaded.ok) {
    warnFallbackOnce(loaded.errors, configPath);
    return fallbackProviders(env, session);
  }
  const { config } = loaded;
  const order = configLaneOrder(config, lane);
  if (order.length === 0) {
    if (lane !== "daily" || Object.keys(config.lanes).length > 0) {
      if (opts.warnMissingLane !== false) {
        console.error(`${LOG} 配置里没有 lane \`${lane}\`（或 order 为空），这条线没有可用 provider`);
      }
    }
    return [];
  }

  const list = [];
  for (const slug of order) {
    const model = config.models[slug];
    if (!model) continue;
    if (model.enabled === false) continue;
    const ep = config.endpoints[model.endpoint];
    if (!ep || ep.enabled === false) continue;
    const provider = buildProvider(slug, model, ep, env, session);
    if (!provider.apiKey) continue;
    list.push(provider);
  }
  return list;
}

/** 单条腿（探测用）：{ provider, reason }；拿不到时 reason 说明原因。 */
export function providerForSlug(slug, env = process.env, opts = {}) {
  const configPath = opts.configPath || CONFIG_PATH;
  const session = randomUUID();
  const loaded = loadConfig(configPath);
  if (!loaded.ok) {
    const leg = FALLBACK_CHAIN.find((p) => p.name === slug);
    if (!leg) return { provider: null, reason: `配置不可用，且兜底链里也没有 \`${slug}\`` };
    const { value: apiKey } = resolveApiKey(leg, env);
    if (!apiKey) return { provider: null, reason: `缺 key：${leg.keyEnv}` };
    return {
      provider: {
        ...clone(leg),
        apiKey,
        ...(isObj(leg.headers) ? { headers: expandHeaders(leg.headers, session) } : {}),
      },
      reason: "",
    };
  }
  const { config } = loaded;
  const model = config.models[slug];
  if (!model) return { provider: null, reason: `配置里没有 model \`${slug}\`` };
  const ep = config.endpoints[model.endpoint];
  if (!ep) return { provider: null, reason: `models.${slug}.endpoint 指向不存在的 endpoint` };
  if (ep.enabled === false) return { provider: null, reason: `endpoint \`${model.endpoint}\` 被禁用（enabled:false）` };
  const provider = buildProvider(slug, model, ep, env, session);
  if (!provider.apiKey) {
    const aliases = Array.isArray(ep.keyEnvAliases) && ep.keyEnvAliases.length ? `（或别名 ${ep.keyEnvAliases.join(" / ")}）` : "";
    return { provider: null, reason: `缺 key：环境变量 ${ep.keyEnv}${aliases} 未设置` };
  }
  return { provider, reason: "" };
}

export function laneOrder(lane, opts = {}) {
  const loaded = loadConfig(opts.configPath || CONFIG_PATH);
  if (!loaded.ok) return [...FALLBACK_SLUGS];
  return [...configLaneOrder(loaded.config, lane)];
}

/** lane 的总预算（毫秒）；没配就是 null（不设上限）。 */
export function laneBudgetMs(lane, opts = {}) {
  const loaded = loadConfig(opts.configPath || CONFIG_PATH);
  if (!loaded.ok) return null;
  const n = loaded.config?.lanes?.[lane]?.budgetMs;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 全量目录（诊断 / `list` / `show` 用）：**配置里的每一条 model**，含没进任何 lane 的、含缺 key 的。
 * 每行带 `configured`（key 是否齐）与 `lanes`（在哪些链里），以及探测要用的 `baseUrl` / `modelsUrl` / `headers`。
 */
export function catalogue(env = process.env, opts = {}) {
  const configPath = opts.configPath || CONFIG_PATH;
  const session = randomUUID();
  const loaded = loadConfig(configPath);
  const lanesOf = (slug) =>
    Object.entries(loaded.ok ? loaded.config.lanes : {}).flatMap(([lane, def]) =>
      Array.isArray(def?.order) && def.order.includes(slug) ? [lane] : []
    );

  if (!loaded.ok) {
    return FALLBACK_CHAIN.map((leg) => {
      const { value: apiKey, envVar } = resolveApiKey(leg, env);
      return {
        name: leg.name,
        endpoint: leg.endpoint,
        model: leg.model,
        apiModel: leg.model,
        baseUrl: leg.baseUrl,
        modelsUrl: deriveModelsUrl({ baseUrl: leg.baseUrl }),
        shape: leg.shape,
        headers: isObj(leg.headers) ? expandHeaders(leg.headers, session) : undefined,
        apiKey,
        keyEnv: leg.keyEnv,
        keyEnvAliases: [],
        keyEnvUsed: envVar,
        configured: Boolean(apiKey),
        enabled: true,
        endpointEnabled: true,
        lanes: ["daily", "summary"],
        params: {},
        note: "内置兜底链（配置不可用时）",
        resolved: false,
      };
    });
  }

  const { config } = loaded;
  const rows = [];
  for (const [slug, model] of Object.entries(config.models)) {
    const ep = config.endpoints[model.endpoint] || {};
    const { value: apiKey, envVar } = resolveApiKey(ep, env);
    rows.push({
      name: slug,
      endpoint: model.endpoint,
      model: model.apiModel,
      apiModel: model.apiModel,
      baseUrl: String(ep.baseUrl || "").replace(/\/+$/, ""),
      modelsUrl: deriveModelsUrl(ep),
      shape: ep.shape === "responses" ? "responses" : "chat",
      headers: isObj(ep.headers) ? expandHeaders(ep.headers, session) : undefined,
      apiKey,
      keyEnv: ep.keyEnv,
      keyEnvAliases: Array.isArray(ep.keyEnvAliases) ? ep.keyEnvAliases : [],
      keyEnvUsed: envVar,
      configured: Boolean(apiKey),
      enabled: model.enabled !== false,
      endpointEnabled: ep.enabled !== false,
      lanes: lanesOf(slug),
      params: isObj(model.params) ? model.params : {},
      note: model.note || "",
      resolved: true,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- diff

function splitLines(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/** 行级 LCS → 操作序列（' ' / '-' / '+'）。配置只有百来行，O(n·m) 完全够。 */
function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "-", line: a[i] });
      i += 1;
    } else {
      ops.push({ t: "+", line: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ t: "-", line: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ t: "+", line: b[j] });
    j += 1;
  }
  return ops;
}

/**
 * 最小 unified diff（零依赖）。没有差异返回 ""。
 * 输出形如 `--- a/config/providers.json` / `+++ b/…` / `@@ -1,6 +1,7 @@`，供所有写操作在落盘前打印。
 */
export function unifiedDiff(beforeText, afterText, { file = "config/providers.json", context = 3 } = {}) {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const ops = diffOps(before, after);
  const changed = ops.flatMap((op, idx) => (op.t === " " ? [] : [idx]));
  if (changed.length === 0) return "";

  // 把相邻改动合并成 hunk（两处改动间隔 ≤ 2*context 就并进同一块）
  const hunks = [];
  let start = Math.max(0, changed[0] - context);
  let end = changed[0];
  for (const idx of changed.slice(1)) {
    if (idx - end <= context * 2) {
      end = idx;
    } else {
      hunks.push([start, end]);
      start = Math.max(0, idx - context);
      end = idx;
    }
  }
  hunks.push([start, end]);

  // 每个 op 之前的老/新行号（1-based）
  const oldNo = [];
  const newNo = [];
  let o = 1;
  let nw = 1;
  for (const op of ops) {
    oldNo.push(o);
    newNo.push(nw);
    if (op.t !== "+") o += 1;
    if (op.t !== "-") nw += 1;
  }

  const lines = [`--- a/${file}`, `+++ b/${file}`];
  for (const [rawStart, rawEnd] of hunks) {
    const lo = Math.max(0, rawStart - context);
    const hi = Math.min(ops.length - 1, rawEnd + context);
    const slice = ops.slice(lo, hi + 1);
    const oldStart = oldNo[lo];
    const newStart = newNo[lo];
    const oldCount = slice.filter((op) => op.t !== "+").length;
    const newCount = slice.filter((op) => op.t !== "-").length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) lines.push(`${op.t}${op.line}`);
  }
  return lines.join("\n");
}

/** 配置对象 → 文件文本（2 空格缩进 + 末尾换行，与仓库里其他 JSON 产物一致）。 */
export function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** 原子写配置（tmp + rename），并保证父目录存在。 */
export function writeConfig(config, configPath = CONFIG_PATH) {
  const checked = validateConfig(config);
  if (!checked.ok) throw new Error(`拒绝写入不合法的配置：${checked.errors.join("；")}`);
  mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, serializeConfig(config), "utf8");
  renameSync(tmp, configPath);
  return config;
}

// ---------------------------------------------------------------- 写操作（纯函数）

function assertValid(config) {
  const checked = validateConfig(config);
  if (!checked.ok) throw new Error(`改动会让配置不合法：${checked.errors.join("；")}`);
  return config;
}

function findOrderIndex(order, slug) {
  return order.indexOf(slug);
}

/** 在 order 数组里插入（不负责去重，调用方保证 slug 不在里面）。 */
function insertAt(order, slug, position) {
  const where = position?.where || "bottom";
  if (where === "top") {
    order.unshift(slug);
    return;
  }
  if (where === "bottom") {
    order.push(slug);
    return;
  }
  const ref = position?.ref;
  if (!isStr(ref)) throw new Error(`--${where} 需要参照 slug`);
  const idx = findOrderIndex(order, ref);
  if (idx === -1) throw new Error(`lane 里没有参照项 \`${ref}\``);
  order.splice(where === "before" ? idx : idx + 1, 0, slug);
}

/**
 * 加一条 model（可选同时进某条 lane）。
 * params / note 只在给了非空值时才写，避免生成 `"params": {}` 这种噪音。
 */
export function addModel(config, { slug, endpoint, apiModel, params, note, lane, position } = {}) {
  if (!isStr(slug)) throw new Error("model slug 不能为空");
  if (!isStr(endpoint)) throw new Error("--endpoint 必填");
  if (!isStr(apiModel)) throw new Error("--api-model 必填");
  const next = clone(config);
  if (next.models[slug]) throw new Error(`model \`${slug}\` 已存在（要改它用 set / enable / disable）`);
  const model = { endpoint, apiModel };
  if (isObj(params) && Object.keys(params).length > 0) model.params = params;
  if (isStr(note)) model.note = note;
  next.models[slug] = model;
  if (isStr(lane)) {
    if (!isObj(next.lanes[lane])) next.lanes[lane] = { order: [] };
    insertAt(next.lanes[lane].order, slug, position || { where: "bottom" });
  }
  return assertValid(next);
}

export function laneAdd(config, lane, slug, position) {
  const next = clone(config);
  if (!isObj(next.models[slug])) throw new Error(`配置里没有 model \`${slug}\``);
  const def = next.lanes[lane];
  if (!isObj(def)) throw new Error(`配置里没有 lane \`${lane}\``);
  if (findOrderIndex(def.order, slug) !== -1) throw new Error(`lane \`${lane}\` 里已经有 \`${slug}\`（要换位置用 lane move）`);
  insertAt(def.order, slug, position || { where: "bottom" });
  return assertValid(next);
}

export function laneMove(config, lane, slug, position) {
  const next = clone(config);
  const def = next.lanes[lane];
  if (!isObj(def)) throw new Error(`配置里没有 lane \`${lane}\``);
  const idx = findOrderIndex(def.order, slug);
  if (idx === -1) throw new Error(`lane \`${lane}\` 里没有 \`${slug}\``);
  def.order.splice(idx, 1);
  if (position?.where === "before" || position?.where === "after") {
    if (position.ref === slug) throw new Error("参照项不能是它自己");
  }
  insertAt(def.order, slug, position || { where: "bottom" });
  return assertValid(next);
}

export function laneRemove(config, lane, slug) {
  const next = clone(config);
  const def = next.lanes[lane];
  if (!isObj(def)) throw new Error(`配置里没有 lane \`${lane}\``);
  const idx = findOrderIndex(def.order, slug);
  if (idx === -1) throw new Error(`lane \`${lane}\` 里没有 \`${slug}\``);
  def.order.splice(idx, 1);
  return assertValid(next);
}

/**
 * 解析 `set` 的取值：`true` / `false` / `null` / 数字 / JSON 字面量，其余按字符串。
 * 特意**不**把 `low` 当关键字：`params.reasoningEffort=low` 就是字符串 low。
 */
export function parseValue(raw) {
  const s = String(raw ?? "");
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t === "") return "";
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return s; // 不是 JSON 就按原字符串（用户可能真的想存 `{x}`）
    }
  }
  return s;
}

/**
 * 解析 `set` / `show` 的目标：显式前缀 `model:` / `lane:` / `endpoint:` 优先，
 * 否则按 model → lane → endpoint 的顺序找（`sensenova` 既是 model 也是 endpoint，model 优先是刻意的）。
 */
export function resolveTarget(config, target) {
  const raw = String(target ?? "").trim();
  if (!raw) throw new Error("缺少目标（slug / lane / endpoint）");
  const [maybeKind, ...rest] = raw.split(":");
  if (rest.length > 0 && ["model", "lane", "endpoint"].includes(maybeKind)) {
    const id = rest.join(":");
    if (maybeKind === "model") {
      if (!isObj(config.models[id])) throw new Error(`配置里没有 model \`${id}\``);
      return { kind: "model", id, label: `models.${id}` };
    }
    if (maybeKind === "lane") {
      if (!isObj(config.lanes[id])) throw new Error(`配置里没有 lane \`${id}\``);
      return { kind: "lane", id, label: `lanes.${id}` };
    }
    if (!isObj(config.endpoints[id])) throw new Error(`配置里没有 endpoint \`${id}\``);
    return { kind: "endpoint", id, label: `endpoints.${id}` };
  }
  if (isObj(config.models[raw])) return { kind: "model", id: raw, label: `models.${raw}` };
  if (isObj(config.lanes[raw])) return { kind: "lane", id: raw, label: `lanes.${raw}` };
  if (isObj(config.endpoints[raw])) return { kind: "endpoint", id: raw, label: `endpoints.${raw}` };
  throw new Error(`配置里找不到 \`${raw}\`（model / lane / endpoint 都没有）`);
}

/**
 * 按路径赋值：`set nvidia-minimax-flash params.reasoningEffort=low`。
 * 路径相对目标对象（models.<slug> / lanes.<lane> / endpoints.<name>），中间层不存在时创建。
 */
export function setPath(config, target, pathExpr, rawValue) {
  const t = resolveTarget(config, target);
  const segs = String(pathExpr ?? "").split(".").filter(Boolean);
  if (segs.length === 0) throw new Error("缺少要设置的路径（例：params.reasoningEffort）");
  const next = clone(config);
  const buckets = { model: next.models, lane: next.lanes, endpoint: next.endpoints };
  let node = buckets[t.kind][t.id];
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node[seg])) node[seg] = {};
    node = node[seg];
  }
  const last = segs[segs.length - 1];
  const value = parseValue(rawValue);
  if (value === null) delete node[last];
  else node[last] = value;
  return assertValid(next);
}

export function setEnabled(config, slug, enabled) {
  const next = clone(config);
  if (!isObj(next.models[slug])) throw new Error(`配置里没有 model \`${slug}\``);
  if (enabled) delete next.models[slug].enabled;
  else next.models[slug].enabled = false;
  return assertValid(next);
}

// ---------------------------------------------------------------- workflow 接线断言

/**
 * 接线规则（B4）——纯文本扫描、不引 YAML 库，先剔掉以 `#` 开头的注释行：
 *   A 跑 `scripts/daily/index.mjs` 的 workflow 必须给 daily lane 里每个 endpoint 的 `secrets.<KEY_ENV>`
 *   B 跑 `scripts/summary/index.mjs` 的 workflow 必须给 summary lane 的
 *   C 跑 `scripts/diagnose-providers.mjs` 的 workflow 必须给**每个 enabled endpoint** 的
 *   违反 → 打印 文件 / 缺哪个 secrets.X / 该加在哪一步，退出码 1（由 CLI 负责）。
 */
export const WIRING_RULES = Object.freeze([
  { id: "A", script: "scripts/daily/index.mjs", lane: "daily", label: "日报" },
  { id: "B", script: "scripts/summary/index.mjs", lane: "summary", label: "30 天总结" },
  { id: "C", script: "scripts/diagnose-providers.mjs", allEndpoints: true, label: "诊断" },
]);

/** 去掉整行注释（YAML 的 `#`；行内 `#` 不处理——secrets 引用不会出现在那里）。 */
export function stripYamlComments(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function requiredKeysForRule(config, rule) {
  const keys = new Map(); // KEY_ENV → endpoint 名
  if (rule.allEndpoints) {
    for (const [name, ep] of Object.entries(config.endpoints)) {
      if (ep.enabled === false) continue;
      if (isStr(ep.keyEnv)) keys.set(ep.keyEnv, name);
    }
    return keys;
  }
  const order = Array.isArray(config.lanes?.[rule.lane]?.order) ? config.lanes[rule.lane].order : [];
  for (const slug of order) {
    const model = config.models[slug];
    if (!model || model.enabled === false) continue;
    const ep = config.endpoints[model.endpoint];
    if (!ep || ep.enabled === false) continue;
    if (isStr(ep.keyEnv)) keys.set(ep.keyEnv, model.endpoint);
  }
  return keys;
}

/**
 * 扫 `.github/workflows/*.yml`，返回 { ok, checked, errors }。
 * `workflowDir` 与 `configPath` 可注入（测试用 fixture 文本）。
 */
export function checkWorkflowWiring({ workflowDir = WORKFLOW_DIR, configPath = CONFIG_PATH } = {}) {
  const loaded = loadConfig(configPath);
  if (!loaded.ok) return { ok: false, checked: [], errors: loaded.errors.map((e) => `配置不可用：${e}`) };
  const { config } = loaded;

  let files;
  try {
    files = readdirSync(workflowDir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort();
  } catch (err) {
    return { ok: false, checked: [], errors: [`读不到 workflow 目录 ${workflowDir}（${err?.code || err?.message}）`] };
  }

  const errors = [];
  const checked = [];
  for (const file of files) {
    const abs = path.join(workflowDir, file);
    const active = stripYamlComments(readFileSync(abs, "utf8"));
    const rel = path.relative(ROOT, abs) || abs;
    const applied = [];
    for (const rule of WIRING_RULES) {
      if (!active.includes(rule.script)) continue;
      applied.push(rule.id);
      for (const [keyEnv, endpoint] of requiredKeysForRule(config, rule)) {
        if (active.includes(`secrets.${keyEnv}`)) continue;
        errors.push(
          `${rel}：缺 \`secrets.${keyEnv}\`（${rule.label}链的 endpoint \`${endpoint}\` 需要它）——` +
            `加在运行 \`${rule.script}\` 那一步的 \`env:\` 里，形如 \`${keyEnv}: \${{ secrets.${keyEnv} }}\``
        );
      }
    }
    if (applied.length > 0) checked.push({ file: rel, rules: applied });
  }

  const isRepoWorkflowDir = path.resolve(workflowDir) === path.resolve(WORKFLOW_DIR);
  if (checked.length === 0) {
    errors.push("没有任何 workflow 引用三条入口脚本 —— 接线检查没扫到东西，多半是路径变了");
  } else if (isRepoWorkflowDir) {
    // 每条规则至少要被一个真实 workflow 覆盖，否则规则形同虚设（fixture 目录不做这项）
    for (const { script } of WIRING_RULES) {
      const covered = checked.some(({ file }) =>
        stripYamlComments(readFileSync(path.resolve(ROOT, file), "utf8")).includes(script)
      );
      if (!covered) errors.push(`没有 workflow 跑 \`${script}\`，对应的接线规则没有落点（改名了？）`);
    }
  }

  return { ok: errors.length === 0, checked, errors };
}

// ---------------------------------------------------------------- 状态对照 / secret

/** sha256 前 8 位：给 secret 干跑预览用，不可逆、不能还原成 key。 */
export function sha256Short(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

/**
 * 本机 env / repo secret / 配置 三方对照（只读）。
 * `secretList` 是 `gh secret list` 的原始文本（注入，便于测试）；不传就是「未知」。
 * 返回 { rows, errors }：rows 每行带 envSource / secretStatus，**不含任何 key 值**。
 */
export function statusReport({ env = process.env, configPath = CONFIG_PATH, secretList = null } = {}) {
  const rows = catalogue(env, { configPath });
  const secrets = new Map();
  if (typeof secretList === "string") {
    for (const line of secretList.split(/\r?\n/)) {
      const name = line.trim().split(/\s+/)[0];
      if (name && !/^NAME$/i.test(name)) secrets.set(name, true);
    }
  }
  const out = rows.map((row) => {
    const envVar = row.keyEnvUsed || null;
    const aliases = row.keyEnvAliases || [];
    const aliasHit = aliases.find((a) => isStr(env?.[a])) || null;
    return {
      ...row,
      envSource: envVar || aliasHit || null,
      secretStatus: secretList === null ? "unknown" : secrets.has(row.keyEnv) ? "present" : "missing",
    };
  });
  const errors = [];
  if (secretList === null) errors.push("没拿到 `gh secret list`（未登录 / 无网络），repo secret 一列显示 unknown");
  return { rows: out, errors };
}

/**
 * 推 repo secret：`gh secret set NAME`，**值只走 stdin**（绝不用 `--body`，也绝不出现在输出里）。
 * `ghImpl.secretSet({ name, value })` 由 CLI 注入（spawnSync + input）；测试注入假实现。
 * 返回 { ok, dryRun, name, length, sha }。
 */
export function pushSecretValue({ name, value, ghImpl, dryRun = false } = {}) {
  if (!isStr(name)) throw new Error("secret 名字不能为空");
  if (!isStr(value)) throw new Error("secret 值为空（从 env 或 stdin 提供）");
  const preview = { name, length: value.length, sha: sha256Short(value) };
  if (dryRun) return { ok: true, dryRun: true, ...preview };
  if (!ghImpl || typeof ghImpl.secretSet !== "function") throw new Error("没有可用的 gh 实现");
  const res = ghImpl.secretSet({ name, value });
  const ok = res?.ok !== false && (res?.status === undefined || res.status === 0);
  return { ok, dryRun: false, ...preview, error: ok ? "" : String(res?.stderr || res?.error || "gh secret set 失败").trim() };
}

// ---------------------------------------------------------------- add 编排

/**
 * `add <slug>` 的编排（B3 的四个阶段）：
 *   ① 预览 diff（不落盘）      —— `previewAdd`
 *   ② 真实探测门槛（3/3）      —— 不通过：**不写配置、不推密钥**，直接返回
 *   ③ 落盘（`--yes` 才写）
 *   ④ 推 secret（默认干跑；`--push-secret` 才真推）
 *
 * `probeImpl(provider, { runs, prompt })` → { ok, runs:[{ok,ms,chars}], error }
 * 由 CLI 注入真实实现（会联网）；测试注入假实现 → 不触网。
 */
export async function previewAdd(spec, { configPath = CONFIG_PATH } = {}) {
  const loaded = loadConfig(configPath);
  if (!loaded.ok) throw new Error(`配置不可用，先修它再加腿：${loaded.errors.join("；")}`);
  const config = addModel(loaded.config, spec);
  return {
    config,
    before: serializeConfig(loaded.config),
    after: serializeConfig(config),
    diff: unifiedDiff(serializeConfig(loaded.config), serializeConfig(config), {
      file: path.relative(ROOT, configPath) || configPath,
    }),
  };
}

export async function addProvider(spec, opts = {}) {
  const {
    configPath = CONFIG_PATH,
    env = process.env,
    yes = false,
    prompt = "real",
    runs = 3,
    probeImpl,
    ghImpl,
    pushSecret = false,
    dryRun = false,
  } = opts;

  const preview = await previewAdd(spec, { configPath });
  const result = { ok: false, stage: "preview", diff: preview.diff, probe: null, wrote: false, secret: null, errors: [] };
  if (dryRun || !yes) {
    return { ...result, ok: true, stage: dryRun ? "dry-run" : "preview-only" };
  }

  // ② 探测门槛：拿到候选配置里这条腿的 provider 对象（key 从 env 取，缺失就当场失败）
  const loaded = loadConfig(configPath);
  if (!loaded.ok) return { ...result, stage: "config", errors: loaded.errors };
  const model = preview.config.models[spec.slug];
  const ep = preview.config.endpoints[model.endpoint];
  const { value: apiKey, envVar } = resolveApiKey(ep, env);
  if (!apiKey) {
    const aliases = Array.isArray(ep.keyEnvAliases) && ep.keyEnvAliases.length ? ` / ${ep.keyEnvAliases.join(" / ")}` : "";
    return { ...result, stage: "missing-key", errors: [`环境变量 ${ep.keyEnv}${aliases} 未设置——先 export 再探测`] };
  }
  if (typeof probeImpl !== "function") {
    return { ...result, stage: "probe", errors: ["没有注入 probeImpl（add 必须真实探测后才允许写配置）"] };
  }
  const provider = buildProvider(spec.slug, model, ep, env, randomUUID());
  const probe = await probeImpl(provider, { runs, prompt });
  result.probe = probe;
  if (!probe || !probe.ok) {
    return {
      ...result,
      stage: "probe-failed",
      errors: [`探测未通过（${probe?.runs?.map((r) => (r.ok ? `${r.ms}ms` : "fail")).join(" / ") || probe?.error || "无结果"}）——不写配置、不推密钥`],
    };
  }

  // ③ 落盘
  writeConfig(preview.config, configPath);
  result.wrote = true;

  // ④ secret（默认干跑）
  if (pushSecret) {
    result.secret = pushSecretValue({ name: ep.keyEnv, value: apiKey, ghImpl, dryRun: false });
  } else {
    result.secret = pushSecretValue({ name: ep.keyEnv, value: apiKey, dryRun: true });
  }
  return { ...result, ok: true, stage: "written", resolvedEnvVar: envVar };
}
