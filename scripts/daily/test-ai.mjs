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
 *   · empty:true（totals 全 0）但 discussion 非空 → 仍会调用 provider
 *     （锁住「可见性判断只在调用方，generateNarrative 不按 empty 自行拦截」）
 *   · provider.headers 原样进请求头（OpenCode Go 的 user-agent / 会话 id 走这条）
 *   · defaultProviders 的列表与顺序（sensenova → OpenCode Go longcat → deepseek，不触网）
 *
 * 用法：node scripts/daily/test-ai.mjs
 * 输出：每个用例一行 PASS/FAIL，结尾 N/M；有失败时退出码 1。
 */

import http from "node:http";

const { generateNarrative, defaultProviders } = await import(new URL("./lib/ai.mjs", import.meta.url).href);

// ---------------------------------------------------------------- 受控输入

const data = {
  date: "2026-10-03",
  windowStart: "2026-10-03T00:00:00+08:00",
  windowEnd: "2026-10-03T23:59:59+08:00",
  username: "tester",
  totals: { commits: 1, prs: 0, issues: 0, reviews: 0 },
  commits: [{ repo: "a/b", count: 1, own: true, automated: 0, automatedBots: [], messages: [{ message: "init" }] }],
  pullRequests: [], reviews: [], issues: [], releases: [], stars: [], replies: [],
  discussions: [
    {
      repo: "openchamber/openchamber",
      number: 4502,
      title: "Store relay keys",
      category: "Ideas",
      comments: 3,
      action: "started",
      ts: "2026-10-03T09:27:02.000Z",
    },
  ],
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
    requests.push({ url: req.url, body: parsed, headers: req.headers });
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
  {
    name: "discussions-in-payload-and-prompt",
    script: [chatResp(JSON.stringify(validNarrative()))],
    expect: { ok: true, calls: 1, systemPrompt: "Discussions:", userPrompt: '"action":"started"' },
  },
  {
    // 回归护栏：totals 全 0（empty:true）的 discussion-only 日不得被 generateNarrative 内部挡掉。
    // 可见性判断是调用方（index.mjs）的职责；这里必须真的打到 provider（calls=1 且拿到叙述）。
    name: "empty-true-but-discussions-still-calls-provider",
    data: {
      ...data,
      empty: true,
      totals: { commits: 0, prs: 0, issues: 0, reviews: 0 },
      commits: [],
    },
    script: [chatResp(JSON.stringify(validNarrative()))],
    expect: { ok: true, calls: 1 },
  },
  {
    // provider.headers（OpenCode Go 要求的自报 UA + 稳定会话 id）必须原样出现在请求头里
    name: "provider-custom-headers-sent",
    provider: {
      ...provider,
      name: "mock-go",
      headers: { "user-agent": "sogeisetsu-daily-report/1.0", "x-opencode-session": "sess-test-1" },
    },
    script: [chatResp(JSON.stringify(validNarrative()))],
    expect: {
      ok: true,
      calls: 1,
      headerUA: "sogeisetsu-daily-report/1.0",
      headerSession: "sess-test-1",
    },
  },
  {
    // 不触网：只验 defaultProviders 的列表、顺序与 Go 侧请求头约定
    name: "default-providers-order-and-go-headers",
    fn: () => {
      const none = defaultProviders({});
      const senseOnly = defaultProviders({ SENSENOVA_API_KEY: "k" });
      const both = defaultProviders({ SENSENOVA_API_KEY: "k", OPENCODE_API_KEY: "go-key" });
      const go = both.slice(1);
      const ua = String(go[0]?.headers?.["user-agent"] || "");
      const sessions = new Set(go.map((p) => p.headers?.["x-opencode-session"]));
      return [
        ["noKeysEmpty", none.length === 0],
        ["senseOnlyFirst", senseOnly.length === 1 && senseOnly[0].name === "sensenova"],
        ["order", both.map((p) => p.name).join(",") === "sensenova,opencode-go-longcat,opencode-go-deepseek"],
        [
          "goModels",
          go[0]?.model === "longcat-2.5-preview-free" && go[1]?.model === "deepseek-v4.1-flash",
        ],
        [
          "goShape",
          go.every(
            (p) =>
              p.baseUrl === "https://opencode.ai/inference/go/openai/v1" &&
              p.shape === "chat" &&
              p.apiKey === "go-key"
          ),
        ],
        // 自报 UA：形如 name/版本，且不是 SDK / HTTP 库的默认名
        ["selfIdentifiedUA", /^[A-Za-z0-9._-]+\/[\d.]+/.test(ua) && !/undici|axios|node-fetch|^node\//i.test(ua)],
        ["stableSession", sessions.size === 1 && String([...sessions][0] || "").length > 8],
        ["noZen", !both.some((p) => p.name === "zen" || /zen/i.test(String(p.baseUrl)))],
      ];
    },
  },
];

// ---------------------------------------------------------------- 执行

const origErr = console.error;
console.error = () => {}; // 屏蔽 ai.mjs 的调试日志
let passed = 0;
for (const c of cases) {
  // 不触网的用例：自己返回 [key, ok] 断言数组（如 defaultProviders 的列表/顺序）
  if (typeof c.fn === "function") {
    const checks = c.fn();
    const ok = checks.every(([, v]) => v);
    if (ok) passed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${c.name}  [${checks.map(([k, v]) => `${k}=${v}`).join(", ")}]`);
    continue;
  }

  requests.length = 0;
  queue = [...c.script];
  const res = await generateNarrative({ data: c.data || data, providers: [c.provider || provider] });
  const checks = [["ok", !!res === c.expect.ok]];
  if (c.expect.calls !== undefined) checks.push(["calls", requests.length === c.expect.calls]);
  if (c.expect.userPrompt) {
    const u = requests.at(-1)?.body?.messages?.[1]?.content || "";
    checks.push(["userPrompt", u.includes(c.expect.userPrompt)]);
  }
  if (c.expect.systemPrompt) {
    const s = requests.at(-1)?.body?.messages?.[0]?.content || "";
    checks.push(["systemPrompt", s.includes(c.expect.systemPrompt)]);
  }
  if (c.expect.secondMaxTokens !== undefined) checks.push(["secondMaxTokens", requests[1]?.body?.max_tokens === c.expect.secondMaxTokens]);
  if (c.expect.secondNoReasoning) checks.push(["secondNoReasoning", !("reasoning_effort" in (requests[1]?.body || {}))]);
  if (c.expect.headerUA !== undefined) checks.push(["headerUA", (requests.at(-1)?.headers?.["user-agent"] || "") === c.expect.headerUA]);
  if (c.expect.headerSession !== undefined) checks.push(["headerSession", (requests.at(-1)?.headers?.["x-opencode-session"] || "") === c.expect.headerSession]);
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
