#!/usr/bin/env node
/**
 * scripts/daily/test-render.mjs
 * ------------------------------------------------------------------
 * render.mjs / lib/github.mjs 纯函数的确定性回归（零依赖，不触网、不需要 key）。
 *
 * 覆盖（对应复审问题 3）：
 *   · aiInlineToHtml     — 标记「仅两样」(code+bold)；斜体/链接/字面 HTML 保持字面；转义安全
 *   · mdBlockToHtml      — 标题/列表/段落；先转义；fence 未闭合到 EOF 也收尾；截断边界内
 *   · i18nInline         — en/zh 两侧各走内联渲染
 *   · normalizeNotes     — 保留换行/行首结构、折叠行内空格、截断到上限、去零宽字符
 *   · splitParagraphs    — 英文句末切分不与 v1.3.0 / e.g. 撞车；保留结尾标点
 *   · renderReportPage   — 分区/角标/双语/转义；空状态与可见段口径
 *   · hasVisibleActivity — 可见段判定（discussion/release/star/回复/状态变更/纯机器人提交等边界）
 *
 * 用法：node scripts/daily/test-render.mjs
 * 输出：每个用例一行 PASS/FAIL；结尾 N/M；有失败退出码 1。
 */

const { aiInlineToHtml, mdBlockToHtml, i18nInline, splitParagraphs, renderReportPage, hasVisibleActivity } =
  await import(new URL("./render.mjs", import.meta.url).href);
const { normalizeNotes } = await import(new URL("./lib/github.mjs", import.meta.url).href);

// ---------------------------------------------------------------- 断言收集

let passed = 0;
const cases = [];
const check = (name, fn) => {
  cases.push(name); // 计入总数，保证抛异常的用例也拉低通过率
  let results;
  try {
    results = fn();
  } catch (err) {
    console.log(`FAIL ${name}  [threw: ${err && err.message}]`);
    return;
  }
  const ok = results.every(([, v]) => v);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  [${results.map(([k, v]) => `${k}=${v}`).join(", ")}]`);
};

// ---------------------------------------------------------------- aiInlineToHtml

check("aiInline: code + bold expanded", () => {
  const out = aiInlineToHtml("In `a/b` did **38 commits** fix stuff.");
  return [
    ["code", out.includes("<code>a/b</code>")],
    ["strong", out.includes("<strong>38 commits</strong>")],
    ["noLiteralBacktick", !out.includes("`")],
    ["noLiteralStars", !out.includes("**")],
  ];
});

check("aiInline: italic/link stay literal (only two markers)", () => {
  const out = aiInlineToHtml("_under_ and *star* and [a link](https://x.example)");
  return [
    ["underscoreLiteral", out.includes("_under_")],
    ["starLiteral", out.includes("*star*")],
    ["noEm", !/<em>/.test(out)],
    ["noAnchor", !/<a[ >]/.test(out)],
  ];
});

check("aiInline: raw HTML and script are escaped", () => {
  const out = aiInlineToHtml("<script>alert(1)</script> <b>x</b>");
  return [
    ["scriptEscaped", out.includes("&lt;script&gt;")],
    ["noRawScriptTag", !/<script>/i.test(out)],
    ["noRawBTag", !/<b>/.test(out)],
  ];
});

check("aiInline: code contents are not bold-rewritten", () => {
  const out = aiInlineToHtml("`a ** b` end");
  return [
    ["codeKeptVerbatim", out.includes("<code>a ** b</code>")],
    ["noNestedStrong", !/<code>a <strong>/.test(out)],
  ];
});

check("aiInline: stray markers stay bounded (do not swallow rest)", () => {
  const out = aiInlineToHtml("a ** b ` c");
  return [
    ["noStrong", !/<strong>/.test(out)],
    ["noCode", !/<code>/.test(out)],
    ["kept", out.includes("a ** b ` c")],
  ];
});

// ---------------------------------------------------------------- mdBlockToHtml

check("mdBlock: heading + paragraph + break", () => {
  const out = mdBlockToHtml("## Title\nline one\nline two");
  return [
    ["h4", out.includes("<h4>Title</h4>")],
    ["br", out.includes("line one<br>line two")],
    ["noLiteralHash", !out.includes("##")],
  ];
});

check("mdBlock: unordered + ordered lists", () => {
  const out = mdBlockToHtml("- a\n- b\n\n1. one\n2. two");
  return [
    ["ul", out.includes("<ul><li>a</li><li>b</li></ul>")],
    ["ol", out.includes("<ol><li>one</li><li>two</li></ol>")],
  ];
});

check("mdBlock: fenced code block, and unclosed fence at EOF is closed", () => {
  const closed = mdBlockToHtml("```\nconst a = 1;\n```");
  const open = mdBlockToHtml("```\nno close");
  return [
    ["closedPre", closed.includes("<pre><code>const a = 1;</code></pre>")],
    ["openPreClosed", open.includes("<pre><code>no close</code></pre>")],
  ];
});

check("mdBlock: raw HTML escaped, no injection", () => {
  const out = mdBlockToHtml("## <img src=x onerror=alert(1)>");
  return [
    ["escaped", out.includes("&lt;img")],
    ["noRawImg", !/<img/.test(out)],
  ];
});

check("mdBlock: respects maxChars bound", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const out = mdBlockToHtml(long, 300);
  // 截断后原始文本 <= 300 再渲染；这里只需确认没有无限增长
  return [["bounded", out.length < 1200]];
});

// ---------------------------------------------------------------- i18nInline

check("i18nInline: both sides rendered, en/zh spans when different", () => {
  const same = i18nInline("`x` **y**", "`x` **y**");
  const diff = i18nInline("`x` **y**", "`x` **z**");
  return [
    ["sameNoSpan", !/class="i18n"/.test(same)],
    ["sameCode", same.includes("<code>x</code>")],
    ["diffHasSpans", /data-lang="en"/.test(diff) && /data-lang="zh"/.test(diff)],
    ["zhStrong", diff.includes("<strong>z</strong>")],
  ];
});

// ---------------------------------------------------------------- normalizeNotes

check("normalizeNotes: keeps newlines + leading structure, folds inline spaces", () => {
  const src = "## Title   x\n\n\n- a\n\tindented   keep\ntext";
  const out = normalizeNotes(src, 1400);
  return [
    ["keepsNewline", out.includes("\n")],
    ["headingLineIntact", out.split("\n").some((l) => /^#{1,6}\s/.test(l))],
    ["listLineIntact", out.split("\n").some((l) => /^-\s/.test(l))],
    ["noTripleBlank", !/\n{3,}/.test(out)],
    ["inlineSpacesFolded", out.includes("Title x")],
  ];
});

check("normalizeNotes: truncates to max, strips zero-width", () => {
  const out = normalizeNotes("a\u200B".repeat(2000), 100);
  return [
    ["bounded", out.length <= 100],
    ["noZeroWidth", !/[\u200B-\u200D\uFEFF]/.test(out)],
  ];
});

// ---------------------------------------------------------------- splitParagraphs

check("splitParagraphs en: keeps v1.3.0 / e.g. intact, keeps terminators", () => {
  const paras = splitParagraphs("Version v1.3.0 shipped. See e.g. the docs. Done!", "en");
  return [
    ["threeParas", paras.length === 3],
    ["keepsVersion", paras[0].includes("v1.3.0")],
    ["keepsEg", paras[1].includes("e.g.")],
  ];
});

check("splitParagraphs zh: splits after 。！？", () => {
  const paras = splitParagraphs("第一句。第二句！第三句？", "zh");
  return [["threeParas", paras.length === 3]];
});

// ---------------------------------------------------------------- renderReportPage

check("renderReportPage: commits 角标取 totals=0，不用条目行数兜底", () => {
  // fixture = 「纯机器人提交 + 一条 discussion」的一天：totals 全 0、empty=true。
  // 可见性由 discussions 提供（commits 只有 count=0 的机器人条目，单独不算活动）；
  // Commits 分区仍会渲染，用来验证开关角标取 totals.commits(0) 而非条目行数(1)。
  const html = renderReportPage({
    data: {
      date: "2026-10-05",
      username: "sogeisetsu",
      generatedAt: "2026-10-05T09:54:00.000Z",
      empty: true,
      totals: { commits: 0, prs: 0, issues: 0, reviews: 0 },
      commits: [
        {
          repo: "sogeisetsu/sogeisetsu",
          count: 0,
          own: true,
          messages: [],
          automated: 8,
          automatedBots: ["github-actions[bot]"],
        },
      ],
      pullRequests: [],
      reviews: [],
      issues: [],
      stateChanges: [],
      discussions: [
        {
          repo: "openchamber/openchamber",
          number: 4901,
          title: "an idea",
          url: "https://github.com/openchamber/openchamber/discussions/4901",
          category: "Ideas",
          comments: 0,
          action: "started",
          ts: "2026-10-05T09:00:00.000Z",
          own: false,
        },
      ],
      releases: [],
      stars: [],
      replies: [],
    },
    ai: null,
  });
  const m = /<h2 class="sec-title">[\s\S]*?Commits[\s\S]*?<\/h2><span class="pill">(\d+)<\/span>/.exec(html);
  return [
    ["sectionRendered", m !== null],
    ["pillIsZero", m !== null && m[1] === "0"],
    ["notRowCount", m !== null && m[1] !== "1"],
  ];
});

// ---------------------------------------------------------------- discussions

check("renderReportPage: discussions 分区 + 动作徽章 + 评论数双语 + 回复 kind 标签", () => {
  const html = renderReportPage({
    data: {
      date: "2026-10-07",
      username: "sogeisetsu",
      generatedAt: "2026-10-07T12:00:00.000Z",
      empty: false,
      totals: { commits: 1, prs: 0, issues: 0, reviews: 0 },
      commits: [
        { repo: "sogeisetsu/sogeisetsu", count: 1, own: true, messages: [{ message: "docs: update" }], automated: 0, automatedBots: [] },
      ],
      pullRequests: [],
      reviews: [],
      issues: [],
      stateChanges: [],
      discussions: [
        {
          repo: "openchamber/openchamber",
          number: 4502,
          title: "Store relay keys <and> secrets",
          url: "https://github.com/openchamber/openchamber/discussions/4502",
          category: "Ideas",
          comments: 3,
          action: "started",
          ts: "2026-10-07T09:27:02.000Z",
          own: false,
        },
        {
          repo: "sogeisetsu/sogeisetsu",
          number: 7,
          title: "joined thread",
          url: "https://github.com/sogeisetsu/sogeisetsu/discussions/7",
          category: "Q&A",
          comments: 5,
          action: "commented",
          ts: "2026-10-07T10:00:00.000Z",
          own: true,
        },
      ],
      releases: [],
      stars: [],
      replies: [
        {
          repo: "openchamber/openchamber",
          number: 4502,
          title: "Store relay keys <and> secrets",
          url: "https://github.com/openchamber/openchamber/discussions/4502",
          author: "someone",
          excerpt: "nice idea",
          kind: "discussion_comment",
          ts: "2026-10-07T11:00:00.000Z",
          own: false,
        },
      ],
    },
    ai: null,
  });
  const pillM = /<h2 class="sec-title">[\s\S]*?Discussions[\s\S]*?<\/h2><span class="pill">(\d+)<\/span>/.exec(html);
  return [
    ["sectionRendered", pillM !== null],
    ["pillIsTwo", pillM !== null && pillM[1] === "2"],
    ["startedBadge", html.includes("Started") && html.includes("发起")],
    ["commentedBadge", html.includes("Commented") && html.includes("评论")],
    ["categoryChip", html.includes('chip-kind">Ideas<')],
    ["countEnZh", html.includes("3 comments") && html.includes("3 条评论")],
    ["titleEscaped", html.includes("Store relay keys &lt;and&gt; secrets") && !html.includes("keys <and>")],
    ["replyKindLabel", html.includes('data-lang="en">Discussion</span>')],
    ["noTotalsPollution", !html.includes('stat-label">Discussions') && !html.includes('stat-label">讨论<')],
  ];
});

// ---------------------------------------------------------------- issue/PR 评论数

check("renderReportPage: issue/PR 行评论数（双语单复数），缺失不渲染", () => {
  const htmlOf = (issues, pullRequests) =>
    renderReportPage({
      data: {
        date: "2026-10-16",
        username: "sogeisetsu",
        generatedAt: "2026-10-16T12:00:00.000Z",
        empty: false,
        totals: { commits: 0, prs: pullRequests.length, issues: issues.length, reviews: 0 },
        commits: [],
        pullRequests,
        reviews: [],
        issues,
        stateChanges: [],
        discussions: [],
        releases: [],
        stars: [],
        replies: [],
      },
      ai: null,
    });
  const issue = (number, extra) => ({
    repo: "anomalyco/opencode",
    number,
    title: `issue ${number}`,
    url: `https://github.com/anomalyco/opencode/issues/${number}`,
    action: "opened",
    ts: "2026-10-16T01:00:00.000Z",
    own: false,
    ...extra,
  });
  const pr = (number, extra) => ({
    repo: "anomalyco/opencode",
    number,
    title: `pr ${number}`,
    url: `https://github.com/anomalyco/opencode/pull/${number}`,
    action: "opened",
    ts: "2026-10-16T02:00:00.000Z",
    own: false,
    ...extra,
  });
  const withCounts = htmlOf([issue(55785, { comments: 3 })], [pr(55772, { comments: 1 })]);
  const without = htmlOf([issue(7, {})], []); // 历史 JSON：无 comments 字段
  return [
    ["zhPlural", withCounts.includes('data-lang="zh">3 条评论</span>')],
    ["enPlural", withCounts.includes('data-lang="en">3 comments</span>')],
    ["enSingular", withCounts.includes('data-lang="en">1 comment</span>')],
    ["zhSingular", withCounts.includes('data-lang="zh">1 条评论</span>')],
    ["missingZhSilent", !without.includes("条评论")],
    ["missingEnSilent", !/\d+ comments?/.test(without)],
    ["missingNoNaN", !/undefined|NaN/.test(without)],
  ];
});

// ---------------------------------------------------------------- hasVisibleActivity

check("hasVisibleActivity: 可见段判定与边界", () => {
  const base = {
    commits: [],
    pullRequests: [],
    reviews: [],
    issues: [],
    stateChanges: [],
    discussions: [],
    releases: [],
    stars: [],
    replies: [],
  };
  const autoOnly = { ...base, commits: [{ repo: "a/b", count: 0, automated: 8 }] };
  const one = (key, item) => ({ ...base, [key]: [item] });
  return [
    ["emptyObjFalse", hasVisibleActivity({}) === false],
    ["allEmptyFalse", hasVisibleActivity(base) === false],
    ["undefinedFalse", hasVisibleActivity(undefined) === false],
    ["autoOnlyFalse", hasVisibleActivity(autoOnly) === false],
    ["nullCommitEntryFalse", hasVisibleActivity({ ...base, commits: [null] }) === false],
    ["userCommitTrue", hasVisibleActivity({ ...base, commits: [{ repo: "a/b", count: 1 }] }) === true],
    ["autoPlusDiscussionTrue", hasVisibleActivity({ ...autoOnly, discussions: [{ number: 1 }] }) === true],
    ["discussionOnlyTrue", hasVisibleActivity(one("discussions", { number: 1 })) === true],
    ["issueOnlyTrue", hasVisibleActivity(one("issues", { number: 2 })) === true],
    ["prOnlyTrue", hasVisibleActivity(one("pullRequests", { number: 3 })) === true],
    ["reviewOnlyTrue", hasVisibleActivity(one("reviews", { number: 4 })) === true],
    ["releaseOnlyTrue", hasVisibleActivity(one("releases", { tag: "v1" })) === true],
    ["starOnlyTrue", hasVisibleActivity(one("stars", { repo: "a/b", delta: 1, total: 2 })) === true],
    ["replyOnlyTrue", hasVisibleActivity(one("replies", { author: "x" })) === true],
    ["stateChangeOnlyTrue", hasVisibleActivity(one("stateChanges", { action: "closed" })) === true],
  ];
});

check("renderReportPage: 空状态与可见段互斥（discussion-only 不再安静）", () => {
  const htmlFor = (data) => renderReportPage({ data, ai: null });
  const discussionOnly = {
    date: "2026-10-13",
    username: "sogeisetsu",
    generatedAt: "2026-10-13T12:00:00.000Z",
    empty: true,
    totals: { commits: 0, prs: 0, issues: 0, reviews: 0 },
    commits: [],
    pullRequests: [],
    reviews: [],
    issues: [],
    stateChanges: [],
    discussions: [{ repo: "o/r", number: 1, title: "d", url: "https://github.com/o/r/discussions/1", category: "Ideas", comments: 0, action: "started", ts: "2026-10-13T01:00:00.000Z", own: false }],
    releases: [],
    stars: [],
    replies: [],
  };
  const autoOnly = { ...discussionOnly, discussions: [], commits: [{ repo: "a/b", count: 0, automated: 3 }] };
  const dHtml = htmlFor(discussionOnly);
  const aHtml = htmlFor(autoOnly);
  return [
    ["discNoEmptyCard", !dHtml.includes('class="card empty-card"')],
    ["discHasSection", dHtml.includes(">Discussions<")],
    ["autoEmptyCard", aHtml.includes('class="card empty-card"')],
    ["autoNoSection", !aHtml.includes(">Discussions<") && !/<h2 class="sec-title">/.test(aHtml)],
  ];
});

// ---------------------------------------------------------------- 汇总

console.log(`\n${passed}/${cases.length} cases passed`);
process.exit(passed === cases.length ? 0 : 1);
