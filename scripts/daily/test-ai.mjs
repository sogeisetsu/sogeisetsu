#!/usr/bin/env node
/**
 * scripts/daily/test-ai.mjs
 * ------------------------------------------------------------------
 * lib/ai.mjs 的确定性回归测试（零依赖，不需要真实 API key）。
 *
 * 做法：起一个本地 http 服务器冒充 SenseNova 的 chat/completions，
 * 按脚本依次返回受控响应，验证 generateNarrative 在各失败形态下的处理：
 *   · summary / headline 超长 → 代码确定性截断到上限后接受（不整段失败）
 *   · JSON 夹在散文里 / 字符串内有未转义换行 → 仍能提取解析
 *   · finish_reason=length 截断 → 翻倍 max_tokens 重试
 *   · HTTP 400（带 reasoning_effort）→ 去掉该参数重试
 *   · HTTP 429 → 等待后重试
 *   · 只返回 1 句 summary → 追加“句数”纠正提示后重试
 *
 * 用法：node scripts/daily/test-ai.mjs
 * 输出：每个用例一行 PASS/FAIL，结尾 N/M；有失败时退出码 1。
 */

import http from "node:http";

const { generateNarrative } = await import(new URL("./lib/ai.mjs", import.meta.url).href);

// ---------------------------------------------------------------- 受控输入

const data = {
  date: "2026-10-03",
  windowStart: "2026-10-03T00:00:00+08:00",
  windowEnd: "2026-10-03T23:59:59+08:00",
  username: "tester",
  totals: { commits: 1, prs: 0, issues: 0, reviews: 0 },
  commits: [{ repo: "a/b", count: 1, own: true, automated: 0, automatedBots: [], messages: [{ message: "init" }] }],
  pullRequests: [], reviews: [], issues: [], releases: [], stars: [], replies: [],
  empty: false,
};

const OK_EN = "One. Two. Three. Four.";
const OK_ZH = "一。二。三。四。";
const LONG_SUMMARY = Array.from(
  { length: 4 },
  (_, i) => `Sentence number ${i + 1} ${"detail ".repeat(70)}.`
).join(" ");

function jsonWith({ enHeadline = "Head", enSummary = OK_EN, zhSummary = OK_ZH, releaseNotes = [] } = {}) {
  return {
    en: { headline: enHeadline, summary: enSummary, releaseNotes },
    zh: { headline: "标题", summary: zhSummary, releaseNotes },
  };
}
const validNarrative = () => jsonWith();
const chatResp = (content, finish = "stop") => ({
  status: 200,
  body: { choices: [{ message: { content, reasoning: "" }, finish_reason: finish }], usage: { total_tokens: 10 } },
});

// ---------------------------------------------------------------- 假服务器

let queue = [];
const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 非 JSON 请求体 */ }
    requests.push({ url: req.url, body: parsed });
    const next = queue.shift();
    if (!next) { res.writeHead(500); res.end("exhausted"); return; }
    if (next.status && next.status !== 200) {
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(next.body ?? "{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(next.body));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const provider = { name: "mock", baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: "test-key", model: "mock-model", shape: "chat" };

// ---------------------------------------------------------------- 用例

const cases = [
  { name: "trims-overlong-summary", script: [chatResp(JSON.stringify(jsonWith({ enSummary: LONG_SUMMARY })))], expect: { ok: true, calls: 1, maxSummaryLen: 1400 } },
  { name: "trims-overlong-headline", script: [chatResp(JSON.stringify(jsonWith({ enHeadline: "x".repeat(96) })))], expect: { ok: true, calls: 1, maxHeadlineLen: 80 } },
  { name: "json-wrapped-in-prose", script: [chatResp(`Here is the report:\n${JSON.stringify(validNarrative())}\nDone.`)], expect: { ok: true, calls: 1 } },
  { name: "json-unescaped-newline", script: [chatResp(JSON.stringify(validNarrative()).replace("One. Two. Three. Four.", "One.\nTwo. Three. Four."))], expect: { ok: true, calls: 1 } },
  { name: "truncation-then-double", script: [chatResp("", "length"), chatResp(JSON.stringify(validNarrative()))], expect: { ok: true, calls: 2, secondMaxTokens: 32768 } },
  { name: "http-400-drops-reasoning", script: [{ status: 400, body: "{}" }, chatResp(JSON.stringify(validNarrative()))], expect: { ok: true, calls: 2, secondNoReasoning: true } },
  { name: "http-429-retry", script: [{ status: 429, body: "{}" }, chatResp(JSON.stringify(validNarrative()))], expect: { ok: true, calls: 2 } },
  {
    name: "single-sentence-summary-retries",
    script: [chatResp(JSON.stringify(jsonWith({ enSummary: "Only one very long sentence that should be rejected." }))), chatResp(JSON.stringify(validNarrative()))],
    expect: { ok: true, calls: 2, userPrompt: "sentence count" },
  },
];

// ---------------------------------------------------------------- 执行

const origErr = console.error;
console.error = () => {}; // 屏蔽 ai.mjs 的调试日志
let passed = 0;
for (const c of cases) {
  requests.length = 0;
  queue = [...c.script];
  const res = await generateNarrative({ data, providers: [provider] });
  const checks = [["ok", !!res === c.expect.ok]];
  if (c.expect.calls !== undefined) checks.push(["calls", requests.length === c.expect.calls]);
  if (c.expect.userPrompt) {
    const u = requests.at(-1)?.body?.messages?.[1]?.content || "";
    checks.push(["userPrompt", u.includes(c.expect.userPrompt)]);
  }
  if (c.expect.secondMaxTokens !== undefined) checks.push(["secondMaxTokens", requests[1]?.body?.max_tokens === c.expect.secondMaxTokens]);
  if (c.expect.secondNoReasoning) checks.push(["secondNoReasoning", !("reasoning_effort" in (requests[1]?.body || {}))]);
  if (c.expect.maxSummaryLen !== undefined) checks.push(["summaryLen", res && res.en.summary.length <= c.expect.maxSummaryLen]);
  if (c.expect.maxHeadlineLen !== undefined) checks.push(["headlineLen", res && res.en.headline.length <= c.expect.maxHeadlineLen]);
  const ok = checks.every(([, v]) => v);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}  [${checks.map(([k, v]) => `${k}=${v}`).join(", ")}]`);
}
console.error = origErr;
server.close();
console.log(`\n${passed}/${cases.length} cases passed`);
process.exit(passed === cases.length ? 0 : 1);
