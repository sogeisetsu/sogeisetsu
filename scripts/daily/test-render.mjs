#!/usr/bin/env node
/**
 * scripts/daily/test-render.mjs
 * ------------------------------------------------------------------
 * render.mjs / lib/github.mjs 纯函数的确定性回归（零依赖，不触网、不需要 key）。
 *
 * 覆盖（对应复审问题 3 与本次复审）：
 *   · aiInlineToHtml     — 标记「仅两样」(code+bold)；斜体/链接/字面 HTML 保持字面；转义安全
 *   · mdBlockToHtml      — 标题/列表/段落/GFM 管道表格（对齐、`\|` 转义、行宽不齐）；
 *                          先转义；fence 未闭合到 EOF 也收尾；截断边界内
 *   · i18nInline         — en/zh 两侧各走内联渲染
 *   · normalizeNotes     — 保留换行/行首结构、折叠行内空格、截断到上限、去零宽字符
 *   · splitParagraphs    — 英文句末切分不与 v1.3.0 / e.g. 撞车；保留结尾标点
 *   · renderReportPage   — 分区/角标/双语/转义；空状态与可见段口径
 *   · hasVisibleActivity — 可见段判定（discussion/release/star/回复/状态变更/纯机器人提交等边界）
 *   · buildTargetQueries / filterTargetCandidates / orderTargetCandidates —
 *     目标检索下界不回退、只剔窗口起点之前的条目、窗口内优先切片
 *   · isPullRow / commentTotalOf                 — PR 行口径（会话评论 + 行内评审评论）
 *   · groupCommentCountTargets / attachCommentCounts — 分组/上限/冻结短路（禁网断言）
 *
 * 用法：node scripts/daily/test-render.mjs
 * 输出：每个用例一行 PASS/FAIL；结尾 N/M；有失败退出码 1。
 */

const { renderReportPage } = await import(new URL("./render.mjs", import.meta.url).href);
const { aiInlineToHtml, mdBlockToHtml, i18nInline, splitParagraphs } = await import(
  new URL("../site/md.mjs", import.meta.url).href
);
const { hasVisibleActivity } = await import(new URL("../lib/domain.mjs", import.meta.url).href);
const {
  normalizeNotes,
  buildTargetQueries,
  filterTargetCandidates,
  orderTargetCandidates,
  isPullRow,
  commentTotalOf,
  groupCommentCountTargets,
  attachCommentCounts,
  repoPayloadIsPublic,
  filterPublicRepos,
  selectScanRepos,
  mapEvents,
} = await import(new URL("./lib/github.mjs", import.meta.url).href);

// ---------------------------------------------------------------- 断言收集

let passed = 0;
const cases = [];
const pending = []; // 异步用例（如冻结短路需要 await 网络契约）

const report = (name, results) => {
  const ok = results.every(([, v]) => v);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  [${results.map(([k, v]) => `${k}=${v}`).join(", ")}]`);
};

const check = (name, fn) => {
  cases.push(name); // 计入总数，保证抛异常的用例也拉低通过率
  let results;
  try {
    results = fn();
  } catch (err) {
    console.log(`FAIL ${name}  [threw: ${err && err.message}]`);
    return;
  }
  if (results && typeof results.then === "function") {
    // 异步用例：先登记，main 末尾统一 await，保证汇总数字正确
    pending.push(
      Promise.resolve(results)
        .then((r) => report(name, r))
        .catch((err) => {
          console.log(`FAIL ${name}  [threw: ${err && err.message}]`);
        })
    );
    return;
  }
  report(name, results);
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

check("mdBlock: GFM table renders as a real table", () => {
  const out = mdBlockToHtml(
    "intro\n\n| Action | What |\n|---|---|\n| `list` | every skill |\n| inspect | why |\n\nafter"
  );
  return [
    ["thead", out.includes("<thead><tr><th>Action</th><th>What</th></tr></thead>")],
    ["tbody", out.includes("<tbody><tr><td><code>list</code></td><td>every skill</td></tr>")],
    ["twoRows", (out.match(/<tr>/g) || []).length === 3],
    ["noPipes", !out.includes("|---|") && !out.includes("| Action |")],
    ["paraBefore", out.includes("<p>intro</p>")],
    ["paraAfter", out.includes("<p>after</p>")],
  ];
});

check("mdBlock: table alignment, escaped pipes, ragged rows", () => {
  const out = mdBlockToHtml("| L | C | R |\n|:--|:-:|--:|\n| a | b | c |\n| only |");
  const shortRow = /<tr>(?:(?!<\/tr>).)*only(?:(?!<\/tr>).)*<\/tr>/.exec(out);
  return [
    ["center", out.includes('<th style="text-align:center">C</th>')],
    ["right", out.includes('<th style="text-align:right">R</th>')],
    ["leftPlain", out.includes("<th>L</th>")],
    ["paddedCell", (shortRow[0].match(/<td/g) || []).length === 3],
    ["paddedAlign", shortRow[0].includes('<td style="text-align:center"></td>')],
  ];
});

check("mdBlock: table cells are escaped and `\\|` stays literal", () => {
  const out = mdBlockToHtml("| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | x \\| y |");
  return [
    ["noRawImg", !/<img/.test(out)],
    ["escaped", out.includes("&lt;img")],
    ["literalPipe", out.includes("x | y")],
    ["noEscapedPipeLeft", !out.includes("\\|")],
  ];
});

check("mdBlock: not a table without a matching delimiter row", () => {
  const bad = mdBlockToHtml("a | b\n---\nnext");
  const hr = mdBlockToHtml("text\n\n---\n\nmore");
  return [
    ["noTable", !/<table>/.test(bad) && !/<table>/.test(hr)],
    ["keptLiteral", bad.includes("a | b")],
    ["hrKept", hr.includes("---")],
  ];
});

check("mdBlock: table does not swallow the following list", () => {
  const out = mdBlockToHtml("| a | b |\n|---|---|\n| 1 | 2 |\n- after table");
  return [["ul", out.includes("<ul><li>after table</li></ul>")], ["oneBodyRow", (out.match(/<tr>/g) || []).length === 2]];
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

// ---------------------------------------------------------------- 目标检索（buildTargetQueries / filterTargetCandidates / orderTargetCandidates）

check("buildTargetQueries: 下界早于 win.date 一天，三条 query 不回退到当天", () => {
  const qs = buildTargetQueries("sogeisetsu", { date: "2026-10-16" });
  return [
    ["len3", qs.length === 3],
    ["firstExact", qs[0] === "author:sogeisetsu updated:>=2026-10-15"],
    ["pr", qs[1] === "author:sogeisetsu updated:>=2026-10-15 type:pr"],
    ["issue", qs[2] === "author:sogeisetsu updated:>=2026-10-15 type:issue"],
    ["noSameDayBound", qs.every((q) => !q.includes("updated:>=2026-10-16"))],
  ];
});

check("filterTargetCandidates: 只剔窗口起点之前的条目，窗口后与缺失 updated_at 保留", () => {
  // 2026-10-16（+08）= UTC [2026-10-15T16:00Z, 2026-10-16T16:00Z)
  const win = {
    date: "2026-10-16",
    startMs: Date.parse("2026-10-15T16:00:00Z"),
    endMs: Date.parse("2026-10-16T16:00:00Z"),
  };
  const items = [
    { id: "in", updated_at: "2026-10-15T18:00:00Z" },
    { id: "before", updated_at: "2026-10-15T10:00:00Z" },
    { id: "after", updated_at: "2026-10-16T18:00:00Z" },
    { id: "missing" },
  ];
  const out = filterTargetCandidates(items, win);
  return [
    ["len3", out.length === 3],
    ["keepsIn", out.some((i) => i.id === "in")],
    ["dropsBefore", !out.some((i) => i.id === "before")],
    ["keepsAfter", out.some((i) => i.id === "after")],
    ["keepsMissing", out.some((i) => i.id === "missing")],
  ];
});

check("orderTargetCandidates: 窗口内优先占 slice，超 max 截断", () => {
  // 同一窗口：2026-10-16（+08）= UTC [2026-10-15T16:00Z, 2026-10-16T16:00Z)
  const win = {
    date: "2026-10-16",
    startMs: Date.parse("2026-10-15T16:00:00Z"),
    endMs: Date.parse("2026-10-16T16:00:00Z"),
  };
  // 故意把 3 条窗口后的条目排在前面（模拟 new→old 排序下挤占 slice）
  const items = [
    { id: "after1", updated_at: "2026-10-17T01:00:00Z" },
    { id: "after2", updated_at: "2026-11-01T00:00:00Z" },
    { id: "after3", updated_at: "2026-12-01T00:00:00Z" },
    { id: "in", updated_at: "2026-10-15T18:00:00Z" },
  ];
  const small = orderTargetCandidates(items, win, 2);
  const big = orderTargetCandidates(items, win, 10);
  return [
    ["smallLen2", small.targets.length === 2],
    ["inFirst", small.targets[0] && small.targets[0].id === "in"],
    ["smallTruncated", small.truncated === true],
    ["bigLen4", big.targets.length === 4],
    ["bigNotTruncated", big.truncated === false],
  ];
});

// ---------------------------------------------------------------- PR 行口径（isPullRow / commentTotalOf）

check("isPullRow: /pull/ 为 true、/issues/ 为 false", () => [
  ["pull", isPullRow({ url: "https://github.com/a/b/pull/12" }) === true],
  ["issue", isPullRow({ url: "https://github.com/a/b/issues/12" }) === false],
  ["missingUrl", isPullRow({}) === false],
  ["nullRow", isPullRow(null) === false],
]);

check("commentTotalOf: Issue=会话评论，PR=会话+行内，缺字段不兜底成 0", () => [
  ["prBoth", commentTotalOf({ comments: 2, review_comments: 3 }, true) === 5],
  ["issueOnly", commentTotalOf({ comments: 2 }, false) === 2],
  ["prReviewOnly", commentTotalOf({ review_comments: 3 }, true) === 3],
  ["emptyIssue", commentTotalOf({}, false) === null],
  ["nullComments", commentTotalOf({ comments: null, review_comments: 3 }, true) === 3],
  ["stringComments", commentTotalOf({ comments: "2" }, false) === null],
]);

// ---------------------------------------------------------------- 评论数回填（分组 / 上限 / 冻结）

check("groupCommentCountTargets: 非法行跳过、同 key 合并、超上限 capped", () => {
  const rows = [
    { repo: "a/b", number: 1, action: "opened" },
    { repo: "a/b", number: 1, action: "commented" },
    { repo: "c/d", number: 2, action: "opened" },
    { repo: "", number: 3 },
    { number: 4 },
    { repo: "e/f" },
    { repo: "e/f", number: 0 },
    null,
  ];
  const g = groupCommentCountTargets(rows, 40);
  const merged = g.groups.get("a/b#1");
  const capped = groupCommentCountTargets(
    [
      { repo: "a/b", number: 1 },
      { repo: "c/d", number: 2 },
      { repo: "e/f", number: 3 },
    ],
    2
  );
  return [
    ["skipsInvalid", g.groups.size === 2 && g.keys.length === 2],
    ["mergedItems2", Boolean(merged) && merged.items.length === 2],
    ["notCapped", g.capped === false],
    ["capKeys2", capped.keys.length === 2],
    ["cappedTrue", capped.capped === true],
  ];
});

check("attachCommentCounts: frozen 短路（禁网也写出快照值）", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network disabled");
  };
  try {
    const rows = [
      { repo: "a/b", number: 1, action: "opened" },
      { repo: "a/b", number: 1, action: "commented" },
    ];
    const written = await attachCommentCounts(null, rows, new Map(), {
      frozen: new Map([["a/b#1", 7]]),
    });
    return [
      ["noThrow", true],
      ["written2", written === 2],
      ["row1", rows[0].comments === 7],
      ["row2", rows[1].comments === 7],
    ];
  } finally {
    globalThis.fetch = origFetch; // 用例结束必须还原，别污染后续用例
  }
});

// ---------------------------------------------------------------- AI 块旁注 + 失败可见性

/** 一天的最小可见数据（一条本人提交），用于 AI 块相关用例。 */
const aiDay = (extra = {}) => ({
  date: "2026-10-09",
  username: "sogeisetsu",
  generatedAt: "2026-10-09T12:00:00.000Z",
  empty: false,
  totals: { commits: 1, prs: 0, issues: 0, reviews: 0 },
  commits: [
    { repo: "sogeisetsu/sogeisetsu", count: 1, own: true, messages: [{ message: "feat: x" }], automated: 0, automatedBots: [] },
  ],
  pullRequests: [],
  reviews: [],
  issues: [],
  stateChanges: [],
  discussions: [],
  releases: [],
  stars: [],
  replies: [],
  ...extra,
});

check("aiSummaryBlock: provider / model 旁注（有 model 显示两者，缺 model 只显示 provider，缺 provider 不渲染）", () => {
  const withModel = renderReportPage({
    data: aiDay({ aiProvider: "sensenova", aiModel: "glm-5.2" }),
    ai: { en: { headline: "H", summary: "One. Two." }, zh: { headline: "标", summary: "一。二。" } },
  });
  const providerOnly = renderReportPage({
    data: aiDay({ aiProvider: "sensenova" }),
    ai: { en: { headline: "H", summary: "One. Two." }, zh: { headline: "标", summary: "一。二。" } },
  });
  const noProvider = renderReportPage({
    data: aiDay(),
    ai: { en: { headline: "H", summary: "One. Two." }, zh: { headline: "标", summary: "一。二。" } },
  });
  return [
    ["hasProviderClass", withModel.includes('<span class="ai-provider">')],
    ["withModel", withModel.includes("由 sensenova / glm-5.2 生成") && withModel.includes("via sensenova / glm-5.2")],
    ["providerOnlyNoSlash", providerOnly.includes("由 sensenova 生成") && !providerOnly.includes("由 sensenova / ")],
    ["noProviderNoSpan", !noProvider.includes('class="ai-provider"')],
  ];
});

check("aiSummaryBlock: 无叙述 + aiFailure → 原因逐条脱敏 + issue 链接", () => {
  const html = renderReportPage({
    data: aiDay({
      aiFailure: {
        generatedAt: "2026-10-09T12:00:00.000Z",
        pageState: "no-narrative",
        attempts: [
          { provider: "opencode-go-longcat", model: "longcat-2.5-preview-free", reason: "HTTP 429（已重试仍失败）" },
          { provider: "sensenova", model: "glm-5.2", reason: "网络异常 fetch failed Bearer gho_SECRETTOKEN1234567890" },
        ],
        issue: { number: 12, url: "https://github.com/sogeisetsu/sogeisetsu/issues/12" },
      },
    }),
    ai: null,
  });
  return [
    ["hasFailureBlock", html.includes('<div class="ai-failure">')],
    ["twoLines", (html.match(/class="ai-failure-line"/g) || []).length === 2],
    ["keepsLongModelName", html.includes("longcat-2.5-preview-free")],
    ["reasonShown", html.includes("HTTP 429（已重试仍失败）")],
    ["bearerRedacted", !html.includes("gho_SECRETTOKEN1234567890") && html.includes("&lt;redacted&gt;")],
    ["issueLink", html.includes("https://github.com/sogeisetsu/sogeisetsu/issues/12") && html.includes("查看失败详情 #12")],
    ["stillUnavailable", html.includes("AI 摘要暂不可用")],
  ];
});

check("aiSummaryBlock: 无 aiFailure 时不出失败块（退回单段「暂不可用」）", () => {
  const html = renderReportPage({ data: aiDay(), ai: null });
  return [
    ["unavailable", html.includes("AI 摘要暂不可用")],
    ["noFailureBlock", !html.includes('<div class="ai-failure">')],
  ];
});

check("aiSummaryBlock: notifier 没跑成（有 aiFailure 但没 issue）→ 退化成「未取到 issue 链接」", () => {
  const withReasons = renderReportPage({
    data: aiDay({
      aiFailure: {
        generatedAt: "2026-10-09T12:00:00.000Z",
        pageState: "no-narrative",
        attempts: [{ provider: "sensenova", model: "glm-5.2", reason: "HTTP 503" }],
        issue: null,
      },
    }),
    ai: null,
  });
  // attempts 为空的极端情况（例如一个 key 都没配 → generateStructured 早退）也要保留降级提示
  const noAttempts = renderReportPage({
    data: aiDay({
      aiFailure: { generatedAt: "2026-10-09T12:00:00.000Z", pageState: "no-narrative", attempts: [], issue: null },
    }),
    ai: null,
  });
  const unavailable = renderReportPage({ data: aiDay(), ai: null });
  return [
    ["reasonsBlock", withReasons.includes('<div class="ai-failure">')],
    ["reasonsLine", withReasons.includes("sensenova / glm-5.2：HTTP 503")],
    ["noLink", !/<a class="link"[^>]*href="https:\/\/github\.com\//.test(withReasons)],
    ["noteShown", withReasons.includes("失败详情：未取到 issue 链接")],
    ["emptyAttemptsStillShows", noAttempts.includes('<div class="ai-failure">') && noAttempts.includes("失败详情：未取到 issue 链接")],
    ["aiFailureAbsentNoNote", !unavailable.includes("未取到 issue 链接")],
  ];
});

check("pageStyle: 失败可见性 / provider 旁注样式在基础样式里（index 卡片没有 extraCss 钩子）", () => {
  const html = renderReportPage({ data: aiDay(), ai: null });
  return [
    ["providerCss", html.includes(".ai-provider{")],
    ["failureCss", html.includes(".ai-failure{") && html.includes(".ai-failure-line{")],
  ];
});

// ---------------------------------------------------------------- 事件时间：只用 payload 业务时间

check("mapEvents: 复活的旧 opened 事件按 payload 时间落窗（不串到第二天）", () => {
  const win = {
    startMs: Date.parse("2026-10-24T00:00:00+08:00"),
    endMs: Date.parse("2026-10-25T00:00:00+08:00"),
  };
  // 线上实证：#5489 创建于 10-23 10:57Z、12:28Z 关闭，事件流却在 17:09Z 重放了一条 opened
  const replayed = {
    type: "IssuesEvent",
    created_at: "2026-10-23T17:09:18Z",
    repo: { name: "openchamber/openchamber" },
    payload: {
      action: "opened",
      issue: { number: 5489, title: "old", html_url: "u5489", created_at: "2026-10-23T10:57:44Z" },
    },
  };
  const todayIssue = {
    type: "IssuesEvent",
    created_at: "2026-10-24T01:00:00Z",
    repo: { name: "me/repo" },
    payload: {
      action: "opened",
      issue: { number: 7, title: "today", html_url: "u7", created_at: "2026-10-24T01:00:00Z" },
    },
  };
  const duplicate = { ...todayIssue, created_at: "2026-10-24T05:00:00Z" }; // 同一动作重复投递
  const mergedPr = {
    type: "PullRequestEvent",
    created_at: "2026-10-24T06:00:00Z",
    repo: { name: "me/repo" },
    payload: {
      action: "closed",
      pull_request: {
        number: 9,
        title: "pr9",
        merged: true,
        created_at: "2026-10-20T00:00:00Z",
        closed_at: "2026-10-24T06:00:00Z",
        merged_at: "2026-10-24T06:00:00Z",
      },
    },
  };
  const oldPrOpened = {
    type: "PullRequestEvent",
    created_at: "2026-10-24T07:00:00Z",
    repo: { name: "me/repo" },
    payload: {
      action: "opened",
      pull_request: { number: 10, title: "pr10", created_at: "2026-10-01T00:00:00Z" },
    },
  };
  const oldComment = {
    type: "IssueCommentEvent",
    created_at: "2026-10-24T08:00:00Z",
    actor: { login: "tester" },
    repo: { name: "x/y" },
    payload: {
      comment: { id: 1, created_at: "2026-10-20T00:00:00Z" },
      issue: { number: 3, title: "z" },
    },
  };
  const out = mapEvents([replayed, todayIssue, duplicate, mergedPr, oldPrOpened, oldComment], "tester", win);
  const issueRows = out.issues.filter((i) => i.action !== "commented");
  return [
    ["noReplay", !out.issues.some((i) => i.number === 5489)],
    ["issueCount", issueRows.length === 1],
    ["deduped", issueRows[0] && issueRows[0].number === 7 && issueRows[0].action === "opened"],
    ["earliestTs", issueRows[0] && issueRows[0].ts === "2026-10-24T01:00:00.000Z"],
    ["prMerged", out.pullRequests.length === 1 && out.pullRequests[0].action === "merged"],
    ["prNoOldOpened", !out.pullRequests.some((p) => p.number === 10)],
    ["commentDropped", !out.issues.some((i) => i.action === "commented")],
  ];
});

// ---------------------------------------------------------------- 公开性闸门：私有仓绝不进提交扫描
check("repos: 私有 / internal / 窗口外仓库都不进提交扫描队列", () => {
  const win = {
    startMs: Date.parse("2026-10-03T00:00:00+08:00"),
    endMs: Date.parse("2026-10-04T00:00:00+08:00"),
  };
  const ownRepos = [
    { full_name: "me/public-repo", pushed_at: "2026-10-03T10:00:00Z", private: false, visibility: "public" },
    { full_name: "me/secret-repo", pushed_at: "2026-10-03T11:00:00Z", private: true, visibility: "private" },
    { full_name: "me/internal-repo", pushed_at: "2026-10-03T12:00:00Z", private: false, visibility: "internal" },
    { full_name: "me/old-repo", pushed_at: "2026-10-01T00:00:00Z", private: false, visibility: "public" },
  ];
  const events = [
    { type: "PushEvent", created_at: "2026-10-03T09:00:00Z", repo: { name: "someone-else/their-repo" } },
    { type: "PushEvent", created_at: "2026-10-01T09:00:00Z", repo: { name: "out/of-window" } },
    { type: "IssuesEvent", created_at: "2026-10-03T09:00:00Z", repo: { name: "ignored/wrong-type" } },
  ];
  const queue = selectScanRepos(events, ownRepos, win, "me");
  const names = queue.map((q) => q.full);
  return [
    ["payloadPublic", repoPayloadIsPublic({ private: false, visibility: "public" })],
    ["payloadPrivate", !repoPayloadIsPublic({ private: true, visibility: "private" })],
    ["payloadInternal", !repoPayloadIsPublic({ private: false, visibility: "internal" })],
    ["payloadNull", !repoPayloadIsPublic(null)],
    ["filterKeepsPublic", filterPublicRepos(ownRepos).map((r) => r.full_name).join(",") === "me/public-repo,me/old-repo"],
    ["queueNoPrivate", !names.includes("me/secret-repo")],
    ["queueNoInternal", !names.includes("me/internal-repo")],
    ["queueNoOld", !names.includes("me/old-repo")],
    ["queueHasPublic", names.includes("me/public-repo")],
    ["queueHasPushedEvent", names.includes("someone-else/their-repo")],
    ["queueNoOutOfWindow", !names.includes("out/of-window")],
    ["queueNoWrongType", !names.includes("ignored/wrong-type")],
    ["queueShape", queue.every((q) => q.owner && q.repoName && q.full === `${q.owner}/${q.repoName}`)],
  ];
});

// ---------------------------------------------------------------- 汇总
await Promise.all(pending); // 等异步用例收口，保证汇总数字正确
console.log(`\n${passed}/${cases.length} cases passed`);
process.exit(passed === cases.length ? 0 : 1);
