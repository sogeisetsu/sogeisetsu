#!/usr/bin/env node
/**
 * scripts/daily/lib/ai/transport.mjs
 * ------------------------------------------------------------------
 * AI 传输层：一次 provider 调用的全部重试阶梯（零依赖 ESM，Node 20+ 内置 fetch）。
 *
 * 这里只管「把 system/user 发出去、把符合校验的 JSON 拿回来」：
 *   · chat / responses 两种形态（URL 与请求体不同，见 attemptProvider 注释）
 *   · 429 / 5xx 等 ~2s 重试一次 → 仍失败换下一家
 *   · 带 response_format 收到 400 → 去掉 JSON 模式重试，并进程内记住该 provider
 *   · 带 reasoning_effort 收到 400 → 去掉该参数重试
 *   · SenseNova chat 404/405 → 同 provider 换 responses 形态
 *   · 截断 / 空输出 → 翻倍 max_tokens 重试（上限 MAX_TOKENS_CAP）
 *   · JSON 提取或校验失败 → 逐次加严的纠正提示，最多追加 MAX_CORRECTIONS 次
 *   · deadline（lane 总预算）→ 每次发请求前收敛单次超时
 *
 * 链顺序、模型、参数、预算**一律来自 config/providers.json**；本文件不持有任何
 * 「哪条腿在链里」的事实。lane 级的「腿之间」编排在 ai/structured.mjs。
 */

export const LOG = "[daily-report]";

const MAX_TOKENS = 49152; // chat max_tokens / responses 共用；实测最坏 17213 completion tokens（含 reasoning），16384 会被截断，49152 ≈ 2.9x 余量
const MAX_TOKENS_CAP = 65536; // 截断时自适应扩容上限（各家 output 上限远高于此）

const RETRY_WAIT_MS = 2000; // 429/5xx 重试前等待 ~2s
const MAX_ROUNDS = 12; // 单 provider 内部循环安全上限（json 重试×3 + rf-400 退让 + 429 重试 + 形态切换 + 截断重试）
const CHAT_TIMEOUT_MS = 180000; // chat/responses POST 超时；总结线唯一的稳定腿实测 51.8–83.0s，90s 太贴边
export const MIN_ATTEMPT_MS = 1000; // 剩余 lane 预算低于这个值就别再发请求（否则一定在预算外拖一个必败的往返）

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 带超时的 fetch：AbortController + setTimeout，finally 里清定时器，避免句柄泄漏。 */
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- provider 进程内状态

// 进程内记住不支持 response_format 的 provider（key: name+baseUrl），后续调用直接跳过
const jsonModeUnsupported = new Set();

// 校验失败后的纠正提醒（第 1 次请求不带提醒，之后最多追加 MAX_CORRECTIONS 次 → 共 4 次尝试）：
// JSON 类失败用通用 JSON 提醒；超长/句数类失败给出可执行的长度反馈。
// 长度问题是重灾区：模型在重输入下的自然输出常达 1500-1900 字符，超过校验上限；只重复“输出 JSON”无法纠正，必须明确要求变短。
const JSON_REMINDERS = [
  "Return ONLY valid JSON, no prose, no markdown fences.",
  "Output must start with { and end with }. No other text.",
  "Output the COMPLETE JSON object ending with }; do not cut it off.",
];
const MAX_CORRECTIONS = 3;

/** 根据上一轮校验失败原因，生成可执行的纠正提示（让模型能真正改对，而不是重复同一错误）。 */
function buildRetryFeedback(reason, n) {
  const r = String(reason || "");
  if (/headline 超长/.test(r)) {
    return "REJECTED: the headline was too long. Rewrite with a headline of AT MOST 72 characters (count them); keep only the single most important fact.";
  }
  if (/summary 超长/.test(r)) {
    return "REJECTED: the summary was too long. Rewrite the summary with 4-6 sentences and UNDER 1100 characters (hard limit). Keep the concrete repository names, numbers and tags, but drop secondary detail.";
  }
  if (/句数/.test(r)) {
    return "REJECTED: the summary sentence count was outside 4-8. Rewrite with 4-6 sentences.";
  }
  if (/包含关系|自动提交/.test(r)) {
    return 'REJECTED: automated commits are SEPARATE and ADDITIONAL — never a subset of the user\'s own commits. Rewrite additive: "8 own commits plus 1 automated commit" / "8 次本人提交，另有 1 次自动提交"; never "其中" / "of which" / "includes" / "包含".';
  }
  if (/releaseNotes/.test(r)) {
    return "REJECTED: check releaseNotes — one entry per input release, repo+tag exactly matching, each summary at most 3 sentences.";
  }
  return JSON_REMINDERS[Math.min(n, JSON_REMINDERS.length - 1)];
}

// ---------------------------------------------------------------- 解析与校验

/** 从首个 `{` 起按括号配平扫出完整 JSON（正确处理字符串内的 { } 与转义），用于剔除 JSON 前后的散文。 */
function balancedJsonSlice(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // 括号不配平（多为截断）
}

/**
 * 从返回文本里稳提取 JSON：剥 ```json 围栏 → 括号配平切片 / 首 { 到末 } → 去掉裸控制字符 → JSON.parse。
 * 多个候选逐个尝试，失败返回 null。
 */
function parseJsonPayload(text) {
  let t = String(text ?? "").trim();
  if (!t) return null;
  t = t.replace(/```(?:json)?/gi, "").trim(); // 剥围栏
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  const candidates = [];
  const balanced = balancedJsonSlice(t);
  if (balanced) candidates.push(balanced);
  if (first !== -1 && last > first) candidates.push(t.slice(first, last + 1));
  candidates.push(t); // 兜底：整段直接就是 JSON
  for (const raw of candidates) {
    // 裸控制字符（字符串内未转义的换行/制表符）会让 JSON.parse 失败，去掉后再试一次
    for (const candidate of [raw, raw.replace(/[\u0000-\u001F]+/g, " ")]) {
      try {
        return JSON.parse(candidate);
      } catch {
        // 继续尝试下一个候选
      }
    }
  }
  return null;
}

/** 按 shape 从响应 JSON 中取回文本。 */
function extractContent(json, shape) {  if (shape === "responses") {
    if (typeof json.output_text === "string" && json.output_text.trim()) {
      return json.output_text;
    }
    const parts = [];
    for (const item of Array.isArray(json.output) ? json.output : []) {
      for (const c of Array.isArray(item?.content) ? item.content : []) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
    return parts.join("");
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  }
  return "";
}

// ---------------------------------------------------------------- 单 provider 尝试

/**
 * 对一个 provider 完整尝试（含内部重试）：
 *   · chat 形态默认带 response_format JSON 模式；带 rf 收到 400 → 去掉 rf 重试一次，
 *     并在进程内记住该 provider 不支持（后续调用直接跳过），绝不因此放弃该 provider
 *   · 429/5xx → 等 ~2s 重试一次 → 仍失败换下一家
 *   · SenseNova chat 404/405 → 同 provider 换 responses 形态再试一次
 *   · JSON 提取/校验失败 → 逐次加严提醒，最多追加 3 次（共 4 次尝试）→ 换下一家
 *   · 截断（finish_reason=length）或空输出（200 但 content 为空，reasoning 吃光预算）
 *     → 打印 usage/reasoning 诊断并翻倍 max_tokens 重试（上限 65536）
 *   · chat 默认发 reasoning_effort=none 关闭思考（避免 CoT 吃光 max_tokens 导致 content 为空）；400 时去掉重试。
 *     取值可由 provider.reasoningEffort 覆盖 —— minimax 不认 "none"（400），而整个去掉参数
 *     它又会无约束地思考到超时，所以它单独配 "low"
 *   · provider.headers（可选）原样追加进请求头（OpenCode Go 的 user-agent / 会话 id 走这里）
 *   · provider.extraBody（可选）合并进 chat 请求体（sensenova 的 thinking:{type:"disabled"} 走这里）
 *   · provider.responseFormat === false → 从不发 json_object（默认发）
 *   · deadline（可选，epoch ms）→ lane 总预算：每次发请求前剩余 ≤ MIN_ATTEMPT_MS 就立刻放弃，
 *     否则 timeout = min(CHAT_TIMEOUT_MS, 剩余)。**这是本函数唯一为 lane 预算加的分支**
 *     ——重试 / 纠正 / 截断翻倍 / JSON 模式退让 / 形态切换一律不动。
 *
 * `validate(parsed)` 是同步校验器，返回 { ok:true, value } 或 { ok:false, reason }；
 * `feedback(reason, n)` 按失败原因生成可执行的纠正提示（默认 buildRetryFeedback，日报专用）。
 */
export async function attemptProvider(provider, system, user, validate, feedback = buildRetryFeedback, deadline = Infinity) {
  const base = String(provider.baseUrl || "").replace(/\/+$/, "");
  const providerKey = `${provider.name}\u0000${base}`;
  let shape = provider.shape === "responses" ? "responses" : "chat";
  let prompt = user;
  let retriedStatus = false; // 429/5xx 已重试过
  let corrections = 0; // 已因 JSON/校验失败追加纠正提示的次数（最多 MAX_CORRECTIONS 次）
  let triedResponses = false; // SenseNova 404/405 → responses 已切换过
  let reasoningOff = true; // chat 形态默认发 reasoning_effort=none 关思考；400 时去掉重试
  // 实测（2026-10-22，真实日报 prompt，deepseek-v4.1-flash）：none → reasoning_tokens=0 / 8.5s；
  // low → 1077 / 17.1s；整个不带参数 → 2799 / 24.0s。所以 "none" 对它是真关掉的，不是被忽略。
  let maxTokens = MAX_TOKENS; // 截断时自适应翻倍（上限 MAX_TOKENS_CAP）

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    // lane 预算：剩余 ≤ 1s 就不再发请求（否则一定在预算外拖一个必败的往返）
    const remaining = deadline - Date.now();
    if (remaining <= MIN_ATTEMPT_MS) {
      return { ok: false, reason: "lane 预算耗尽" };
    }
    const timeoutMs = Number.isFinite(deadline) ? Math.min(CHAT_TIMEOUT_MS, remaining) : CHAT_TIMEOUT_MS;
    const url = `${base}/${shape === "responses" ? "responses" : "chat/completions"}`;
    // chat 形态请求 JSON 模式；已知该 provider 不支持（或配置写死 responseFormat:false）则跳过
    const useJsonMode =
      shape === "chat" && provider.responseFormat !== false && !jsonModeUnsupported.has(providerKey);
    const body =
      shape === "responses"
        ? {
            model: provider.model,
            input: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            max_output_tokens: maxTokens,
          }
        : {
            model: provider.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            temperature: 0.3,
            max_tokens: maxTokens,
            ...(reasoningOff ? { reasoning_effort: provider.reasoningEffort || "none" } : {}),
            ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
            // provider 自定义请求体片段（sensenova 的 thinking:{type:"disabled"} 走这里）；
            // 只作用于 chat 形态，responses 形态不带（那边的参数名不同）
            ...(provider.extraBody && typeof provider.extraBody === "object" ? provider.extraBody : {}),
          };

    let res;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${provider.apiKey}`,
            // provider 自定义头（OpenCode Go 要求自报 user-agent + 稳定会话 id）
            ...(provider.headers && typeof provider.headers === "object" ? provider.headers : {}),
          },
          body: JSON.stringify(body),
        },
        timeoutMs
      );
    } catch (err) {
      return { ok: false, reason: `网络异常 ${err && err.message}` };
    }

    // 429 / 5xx：等 ~2s 重试一次，再失败就换下一家
    if (res.status === 429 || res.status >= 500) {
      if (!retriedStatus) {
        retriedStatus = true;
        console.error(
          `${LOG} ${provider.name}: HTTP ${res.status}，${RETRY_WAIT_MS}ms 后重试一次`
        );
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      return { ok: false, reason: `HTTP ${res.status}（已重试仍失败）` };
    }

    // SenseNova chat 形态 404/405：同一 provider 换 /responses 形态再试一次。
    // 按 endpoint 判断（不按 name）：name 是可随便改的稳定 slug，线上历史数据与测试都依赖它不变。
    if (
      (res.status === 404 || res.status === 405) &&
      provider.endpoint === "sensenova" &&
      shape === "chat" &&
      !triedResponses
    ) {
      triedResponses = true;
      shape = "responses";
      console.error(
        `${LOG} ${provider.name}: chat 形态 HTTP ${res.status}，改用 responses 形态重试`
      );
      continue;
    }

    // 400：先去掉可能不被支持的 reasoning_effort，再退让 response_format（都不放弃 provider）
    if (res.status === 400 && shape === "chat" && reasoningOff) {
      reasoningOff = false;
      console.error(`${LOG} ${provider.name}: HTTP 400 且请求带了 reasoning_effort，去掉后重试`);
      continue;
    }
    // 带 response_format 收到 400：去掉 JSON 模式重试一次，并进程内记住该 provider 不支持（不放弃该 provider）
    if (res.status === 400 && useJsonMode) {
      jsonModeUnsupported.add(providerKey);
      console.error(
        `${LOG} ${provider.name}: HTTP 400 且请求带了 response_format，改为不带 JSON 模式重试（该 provider 进程内不再发送）`
      );
      continue;
    }

    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, reason: `HTTP ${res.status} ${snippet}` };
    }

    const json = await res.json().catch(() => null);
    if (!json) return { ok: false, reason: "响应体不是 JSON" };

    const content = extractContent(json, shape);
    // 截断检测：chat 看 finish_reason=length；responses 看 incomplete_details / status=incomplete
    const truncated =
      (shape === "chat" && json?.choices?.[0]?.finish_reason === "length") ||
      (shape === "responses" &&
        (json?.incomplete_details != null || json?.status === "incomplete"));
    // 空输出检测：OpenCode Go 上的模型即使发 reasoning_effort=none 也计 reasoning tokens，
    // max_tokens 被思考吃光时会回 200 + content 为空 + finish_reason=stop —— 截断那支逮不到，
    // 只会被当成「提取不到 JSON」空转 4 轮纠正再换下一家。这类纯预算问题与截断同法处理。
    const emptyContent = content.trim() === "";
    let checked;
    if (truncated || emptyContent) {
      const finish = json?.choices?.[0]?.finish_reason ?? json?.status ?? "?";
      const usage = json?.usage ? JSON.stringify(json.usage) : "n/a";
      const reasoningLen =
        typeof (json?.choices?.[0]?.message?.reasoning ?? json?.choices?.[0]?.message?.reasoning_content) === "string"
          ? String(json?.choices?.[0]?.message?.reasoning ?? json?.choices?.[0]?.message?.reasoning_content).length
          : 0;
      console.error(
        `${LOG} ${provider.name}: ${truncated ? "输出被截断" : "输出为空"}（finish_reason=${finish}, content_len=${content.length}, reasoning_len=${reasoningLen}, max_tokens=${maxTokens}, usage=${usage}）`
      );
      // CoT 吃光 max_tokens 时 content 为空：先尝试抬高预算，到顶仍不行才算失败
      if (maxTokens < MAX_TOKENS_CAP) {
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CAP);
        console.error(`${LOG} ${provider.name}: 提高 max_tokens 至 ${maxTokens} 后重试`);
        continue;
      }
      checked = {
        ok: false,
        reason: truncated ? "输出被 max_tokens 截断" : "输出为空（reasoning 可能吃光 max_tokens）",
      };
    } else {
      const parsed = parseJsonPayload(content);
      checked = parsed
        ? validate(parsed)
        : { ok: false, reason: "无法从返回文本中提取 JSON" };
    }
    if (checked.ok) return { ok: true, value: checked.value };

    // 失败时打印原始返回片段，便于事后诊断（prose / 截断 / 结构不符）
    console.error(
      `${LOG} ${provider.name}: 返回不合约束（${checked.reason}），原始返回前 400 字: ${String(content).slice(0, 400)}`
    );

    if (corrections < MAX_CORRECTIONS) {
      const hint = feedback(checked.reason, corrections);
      corrections += 1;
      prompt = `${user}\n\n${hint}`;
      console.error(
        `${LOG} ${provider.name}: 返回不合约束（${checked.reason}），追加纠正提示后重试（第 ${corrections + 1}/${
          MAX_CORRECTIONS + 1
        } 次）`
      );
      continue;
    }
    return { ok: false, reason: `返回不合约束（${checked.reason}）` };
  }
  return { ok: false, reason: `超过内部重试上限 ${MAX_ROUNDS} 次` };
}

/** 规范化 provider：补 shape；无效则返回 null（并记日志）。模型一律由 provider 自身写死，不再动态解析。 */
export function normalizeProvider(raw) {
  if (!raw || typeof raw !== "object") {
    console.error(`${LOG} 跳过无效 provider 条目`);
    return null;
  }
  const provider = { ...raw, shape: raw.shape === "responses" ? "responses" : "chat" };
  const name = provider.name || "?";
  if (!provider.baseUrl || !provider.apiKey) {
    console.error(`${LOG} ${name}: 缺 baseUrl/apiKey，跳过`);
    return null;
  }
  if (!provider.model) {
    console.error(`${LOG} ${name}: 缺 model，跳过`);
    return null;
  }
  return provider;
}
