#!/usr/bin/env node
/**
 * scripts/daily/lib/ai/prose.mjs
 * ------------------------------------------------------------------
 * AI 叙述的**文本标尺**（零依赖 ESM，Node 20+；**零 import**）：脱敏、句数统计、
 * 句界切分、headline / 正文的长度收敛、JSON 转义残留还原。
 *
 * 为什么单独成文件：这些都是纯字符串函数，表现层（日报页 / 总结页 / 失败卡）
 * 需要 `sanitizeReason`，而它原来和 provider 责任链、HTTP 重试、prompt 住在同一个
 * 模块（lib/ai.mjs）里 —— 于是渲染一个页面要先加载整条 AI 传输层。搬到这里后
 * 表现层直连本文件即可，桶（lib/ai.mjs）只给编排层用。
 *
 * 不属于本文件：`fitHeadline` / `fitText` 的**上限常量**在 scripts/lib/rules.mjs
 * （与 30 天总结共享同一口径），本文件只收 `maxChars` 参数。
 */

/**
 * 失败原因脱敏（写进 issue 正文 / 页面失败卡前必过）。
 *
 * 口径：宁可多替换，绝不漏 key。依次抹掉
 *   · `Bearer <token>` 授权头
 *   · `sk-…` / `oc_…` 形态的 API key
 *   · 任意 ≥24 位的 `[A-Za-z0-9_-]` 串（长 token / 长 session id / commit sha 一律算敏感）
 *   · `http(s)://…` URL（baseUrl / query 都可能藏在里面）
 * 最后单条截断到 maxLen 字符（默认 300，模型返回的 snippet 上限也在这量级）。
 */
export function sanitizeReason(text, maxLen = 300) {
  let s = String(text ?? "");
  s = s.replace(/Bearer\s+\S+/gi, "<redacted>");
  s = s.replace(/\b(?:sk-|oc_)[A-Za-z0-9_-]{6,}/g, "<redacted>");
  s = s.replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>");
  s = s.replace(/https?:\/\/\S+/gi, "<redacted-url>");
  s = s.trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/** 粗算句数：中文句号/叹号/问号直接计数（中文句间通常无空格）；英文句末标点需后接空白或结尾，避免小数点、缩写点误判。 */
export function countSentences(text) {
  const s = String(text).trim();
  if (!s) return 0;
  const cjk = (s.match(/[。！？]/g) || []).length;
  const latin = (s.match(/[.!?]+(?=\s|$)/g) || []).length;
  let n = cjk + latin;
  if (!/[.!?。！？]\s*$/.test(s)) n += 1; // 末尾没有句号的残句也计入
  return n;
}

/** 按句末标点切句（中英兼顾），保留标点、去掉空段。 */
export function splitSentences(text) {
  const s = String(text).trim();
  if (!s) return [];
  const out = [];
  let buf = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    buf += ch;
    const cjkEnd = ch === "。" || ch === "！" || ch === "？";
    const latinEnd = (ch === "." || ch === "!" || ch === "?") && (i + 1 >= s.length || /\s/.test(s[i + 1]));
    if (cjkEnd || latinEnd) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 拼接句子：前句以中文句末标点结尾时不留空格（中文句间通常无空格），否则用空格。 */
function joinSentences(sentences) {  let out = "";
  for (let i = 0; i < sentences.length; i += 1) {
    if (i === 0) { out = sentences[i]; continue; }
    const prev = sentences[i - 1];
    out += (/[。！？]$/.test(prev) ? "" : " ") + sentences[i];
  }
  return out;
}

/** 保留前 keepMax 句（用于 release notes 等）。 */
export function fitSentences(text, keepMax) {
  const s = String(text).trim();
  if (!s) return "";
  const sentences = splitSentences(s);
  if (sentences.length <= keepMax) return s;
  return joinSentences(sentences.slice(0, keepMax)).trim();
}

/**
 * headline 超长时优先在分隔符处断开，其次按词边界断开；保证不超过 maxChars。
 */
export function fitHeadline(text, maxChars) {
  const s = String(text).trim();
  if (s.length <= maxChars) return s;
  const seps = ["；", ";", " | ", "—", " - "];
  let cut = -1;
  for (const sep of seps) {
    const i = s.indexOf(sep);
    if (i > 0 && i <= maxChars && (cut === -1 || i < cut)) cut = i;
  }
  if (cut >= Math.max(20, Math.floor(maxChars * 0.3))) return s.slice(0, cut).trim();
  const head = s.slice(0, maxChars);
  const sp = head.lastIndexOf(" ");
  return (sp >= Math.floor(maxChars * 0.6) ? head.slice(0, sp) : head).trim();
}

/**
 * 把过长文本截断到 maxChars 内，尽量保留完整句子（句界优先），并保证句数落在 [keepMin, keepMax]。
 * 用于强制模型无法稳定遵守的硬性长度上限：宁可截短，也不因超长整段失败。
 */
export function fitText(text, maxChars, keepMin, keepMax) {
  const s = String(text).trim();
  if (!s) return "";
  if (s.length <= maxChars && countSentences(s) <= keepMax) return s;
  let sentences = splitSentences(s);
  if (sentences.length === 0) return s.slice(0, maxChars).trim();
  if (sentences.length > keepMax) sentences = sentences.slice(0, keepMax);
  const kept = [];
  for (const sent of sentences) {
    const trial = joinSentences([...kept, sent]);
    if (kept.length > 0 && trial.length > maxChars) break;
    kept.push(sent);
  }
  const needMin = Math.min(keepMin, sentences.length);
  const chosen = kept.length < needMin ? sentences.slice(0, needMin) : kept;
  const joined = joinSentences(chosen);
  return (joined.length > maxChars ? joined.slice(0, maxChars) : joined).trim();
}

/**
 * 剥掉模型写进正文里的「JSON 转义残留」：`\"` `\'` `\\` `\/` 还原成对应字符，字面 `\n` `\r` `\t`
 * 换成空格。起因是 `buildPrompts` 用 `JSON.stringify` 把输入塞进 user 消息，模型看到输入里
 * issue 标题的 `\"` 会照抄进自己的 JSON 字符串，`JSON.parse` 之后正文就带着反斜杠上页面
 * （线上实证：2026-10-23 的 "[Bug] \"Run as goal\"…"）。
 * 只处理转义序列本身，不碰普通反斜杠；对已经干净的文本是幂等的。
 */
export function unescapeProse(text) {
  return String(text == null ? "" : text).replace(/\\(["'\\/nrt])/g, (_m, ch) =>
    ch === "n" || ch === "r" || ch === "t" ? " " : ch
  );
}
