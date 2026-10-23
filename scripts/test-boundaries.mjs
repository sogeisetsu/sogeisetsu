#!/usr/bin/env node
/**
 * scripts/test-boundaries.mjs
 * ------------------------------------------------------------------
 * 分层边界测试（零依赖，不触网、不需要 key）：把「谁可以 import 谁」锁成七条禁边。
 *
 * 为什么这样写：扁平脚本「扫真实目录 + 断言」有个致命假阴性 —— 解析器一坏
 * （正则漏匹配 / 注释没剔干净），边集变空，断言当然全过、测试永远绿。
 * 所以这里把**规则判定**与**文件扫描**分开：
 *   checkGraph({ files, edges })  纯函数，零 IO，返回违规描述
 *   scanScripts(dir)              先剔注释（含字符串感知）再抽 import/export-from
 *   selfTest()                    八条规则各一正一反的合成图（含故意违规）
 * main() 先跑 selfTest，它红就整条命令失败；扫描结果再空（files/edges 过少）也判红。
 *
 * 七条禁边（详见 codemap / 计划 §2.2；只锁方向，不锁层级编号）：
 *   a 说明符只允许 `node:` 前缀或相对路径，且相对路径必须解析到仓内文件
 *   b 无环
 *   c 契约叶子（cst / lib/paths / lib/domain / lib/rules / lib/dataset / daily/lib/ai/prose）
 *     零内部依赖；例外只有 lib/paths.mjs（只许 node:path + node:url）
 *   d lib/** 不得 import render* / site/** / summary/**
 *   e 表现层（render*.mjs / site/**）不得 import 采集/IO/AI 传输层（见 PRESENTATION_BANNED）
 *   f daily/render.mjs 与 summary/render.mjs 双向禁止
 *   g fileURLToPath 只许出现在 scripts/lib/paths.mjs（ROOT 的唯一来源）
 *
 * 允许的方向（写在这里免得实施时自作聪明）：编排层可以依赖表现层；
 * 测试可以 import 任何东西；编排层可以 import scripts/daily/lib/ai.mjs 这个桶。
 *
 * 用法：node scripts/test-boundaries.mjs
 * 输出：每个合成用例一行 PASS/FAIL + 真实扫描结果；有失败退出码 1。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { SCRIPTS_DIR } from "./lib/paths.mjs";

// ---------------------------------------------------------------- 角色

/** 表现层：各线的 render*.mjs 与 scripts/site/**（数据 → 字符串的纯函数）。 */
const isPresentation = (file) => file.startsWith("site/") || /(^|\/)render[^/]*\.mjs$/.test(file);

/** 适配器 / 共享规则层：scripts/lib/** 与 scripts/daily/lib/**。 */
const isLib = (file) => file.startsWith("lib/") || file.startsWith("daily/lib/");

/** 契约叶子：仓内零依赖（例外只有 lib/paths.mjs 的 node:path / node:url）。 */
const CONTRACT_LEAVES = [
  "cst.mjs",
  "lib/paths.mjs",
  "lib/domain.mjs",
  "lib/rules.mjs",
  "lib/dataset.mjs",
  "daily/lib/ai/prose.mjs",
];

/** 契约叶子 lib/paths.mjs 唯一允许的内置模块。 */
const PATHS_LEAF_ALLOWED = ["node:path", "node:url"];

/** 表现层不得触达的模块：采集 / IO / AI 传输 / 叙述（否则搬走渲染层等于白搬）。 */
const PRESENTATION_BANNED = [
  "daily/lib/github.mjs",
  "daily/lib/days.mjs",
  "daily/lib/providers.mjs",
  "daily/lib/ai.mjs",
  "daily/lib/ai/transport.mjs",
  "daily/lib/ai/structured.mjs",
  "daily/lib/ai/narrative.mjs",
];

/** 两条「独立产品线」的渲染模块不许互引（共享外壳走 site/）。 */
const RENDER_PAIR = ["daily/render.mjs", "summary/render.mjs"];

/** fileURLToPath 唯一归属（ROOT 的唯一来源）。 */
const FILEURL_OWNER = "lib/paths.mjs";

/**
 * 名称级归属：这些符号只许在**归属文件**里声明，别处只能 import 引用。
 *
 * 为什么要锁：它们是「同一口径的多消费者」—— 复制一份到别处不会有报错，
 * 只会让两处慢慢漂移（例如 headline 上限一处 80 一处 120，页面上看不出来）。
 * 阈值类（TODO 里的字面量上限）不锁：本仓有大量同值字面量（如 dataHash 取前 10 位），
 * 锁字面量只会误伤。
 */
const DECLARATION_OWNERS = {
  HEADLINE_MAX_CHARS: "lib/rules.mjs",
  AUTOMATED_OVERLAP_RE: "lib/rules.mjs",
  narrativeWordingOk: "lib/rules.mjs",
  fitHeadline: "daily/lib/ai/prose.mjs",
  fitText: "daily/lib/ai/prose.mjs",
  countSentences: "daily/lib/ai/prose.mjs",
};

// ---------------------------------------------------------------- 规则判定（纯函数）

/**
 * 七条规则逐条判定。
 * @param {{ files?: string[], edges?: Array<{from: string, to: string|null, spec: string, names?: string[]}> }} graph
 *   `files` 是相对 scripts/ 的 posix 路径；`edges[].to` 是解析后的仓内路径（`node:` 内置为 null）。
 * @returns {string[]} 违规描述（每条形如 `[b] …`）；空数组 = 全部规则通过。
 */
export function checkGraph({ files = [], edges = [] } = {}) {
  const out = [];
  const fileSet = new Set(files);

  for (const edge of edges) {
    const { from, to, spec } = edge;
    const where = `${from} → ${spec}`;

    // a) 说明符只允许 node: 前缀或相对路径；相对路径必须解析到仓内文件
    if (!(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"))) {
      out.push(`[a] ${from}: 说明符 "${spec}" 不是 node: 或相对路径（零依赖硬约束）`);
    } else if (spec.startsWith(".") && (!to || !fileSet.has(to))) {
      out.push(`[a] ${from}: 说明符 "${spec}" 没解析到仓内文件（解析结果 ${to || "null"}）`);
    }

    // c) 契约叶子零内部依赖（lib/paths.mjs 只许 node:path / node:url）
    if (CONTRACT_LEAVES.includes(from)) {
      const allowed =
        from === "lib/paths.mjs" && to === null && PATHS_LEAF_ALLOWED.includes(spec);
      if (!allowed) out.push(`[c] ${where}：契约叶子必须零内部依赖`);
    }

    // d) lib/** 不得回头依赖渲染 / 站点外壳 / 总结线
    if (isLib(from) && to && (isPresentation(to) || to.startsWith("summary/"))) {
      out.push(`[d] ${where}：lib/** 不得 import 表现层或 summary/**`);
    }

    // e) 表现层不得触达采集 / IO / AI 传输层（桶也算，桶会把它们拖回来）
    if (isPresentation(from) && to && PRESENTATION_BANNED.includes(to)) {
      out.push(`[e] ${where}：表现层不得 import ${to}（走 site/ 或 ai/prose.mjs / lib/rules.mjs）`);
    }

    // f) 两个 render 模块双向禁止
    if (from === RENDER_PAIR[0] && to === RENDER_PAIR[1]) {
      out.push(`[f] ${where}：daily/render.mjs 不得 import summary/render.mjs`);
    }
    if (from === RENDER_PAIR[1] && to === RENDER_PAIR[0]) {
      out.push(`[f] ${where}：summary/render.mjs 不得 import daily/render.mjs`);
    }

    // g) fileURLToPath 只许出现在 scripts/lib/paths.mjs
    const names = Array.isArray(edge.names) ? edge.names : [];
    if (names.includes("fileURLToPath") && from !== FILEURL_OWNER) {
      out.push(`[g] ${where}：fileURLToPath 只许出现在 ${FILEURL_OWNER}`);
    }
  }

  // b) 无环（只沿解析到仓内文件的边）
  for (const cycle of findCycles(files, edges)) {
    out.push(`[b] 依赖成环：${cycle.join(" → ")}`);
  }

  return out;
}

/** 找出所有（去重后的）环，返回每条环的路径（首尾同一文件）。 */
function findCycles(files, edges) {
  const adj = new Map();
  for (const file of files) adj.set(file, []);
  for (const edge of edges) {
    if (!edge.to || !adj.has(edge.from) || !adj.has(edge.to)) continue;
    adj.get(edge.from).push(edge.to);
  }
  const state = new Map(); // file -> 1 访问中 / 2 已完成
  const stack = [];
  const seen = new Set();
  const cycles = [];

  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) || []) {
      const s = state.get(next);
      if (s === 1) {
        const at = stack.indexOf(next);
        const cycle = [...stack.slice(at), next];
        const key = cycle.join(" → ");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (s === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const file of files) {
    if (!state.has(file)) visit(file);
  }
  return cycles;
}

// ---------------------------------------------------------------- 名称级归属（纯函数）

/**
 * 名称级归属判定：归属符号只许在归属文件里声明。
 * @param {Array<{file: string, source: string}>} units 已剔注释的源码
 * @returns {string[]} 违规描述（空数组 = 通过）
 */
export function checkDeclarations(units = []) {
  const out = [];
  for (const [name, owner] of Object.entries(DECLARATION_OWNERS)) {
    const re = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`
    );
    for (const { file, source } of units) {
      if (file === owner) continue;
      if (re.test(source)) out.push(`[decl] ${file}: ${name} 只许在 ${owner} 里声明（别处只能引用）`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 扫描（唯一有 IO 的部分）

/**
 * 去掉 `//` 与 `/* *\/` 注释，但**保留字符串内容**（`"https://…"` 里的 `//` 不是注释）。
 * 字符串/模板/转义都按状态机走；注释换行保留，便于报行号时不出偏移。
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | ' | " | `
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        i += 2;
      } else if (ch === "/" && next === "*") {
        state = "block";
        i += 2;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        state = ch;
        out += ch;
        i += 1;
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
      } else {
        if (ch === "\n") out += ch;
        i += 1;
      }
      continue;
    }
    // 字符串 / 模板内：原样保留，只处理转义与收尾
    if (ch === "\\") {
      out += ch + (next == null ? "" : next);
      i += 2;
      continue;
    }
    if (ch === state) {
      state = "code";
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 静态 import / export-from 语句（动态 `import()` 不算边：它不参与分层方向）。 */
const FROM_RE = /(?:^|\n)[ \t]*(?:import|export)\s+([^;'"]*?)\s*from\s*(['"])([^'"\n]+)\2/g;

/** 从子句里抠出被引入的标识符（`{ a, b as c }` → a, b, c；默认导入 → 名字）。 */
function importedNames(clause) {
  const names = [];
  const braces = /\{([\s\S]*?)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const id = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) names.push(id);
    }
  } else {
    const id = clause.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(id)) names.push(id);
  }
  return names;
}

/** 递归收集 scripts/** 下的 .mjs，返回 { files, edges }（files 是相对 scripts/ 的 posix 路径）。 */
export function scanScripts(dir = SCRIPTS_DIR) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        files.push(path.relative(dir, abs).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  files.sort();

  const edges = [];
  const sources = [];
  for (const file of files) {
    const src = stripComments(readFileSync(path.join(dir, file), "utf8"));
    sources.push({ file, source: src });
    FROM_RE.lastIndex = 0;
    let m;
    while ((m = FROM_RE.exec(src))) {
      const spec = m[3];
      const to = spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : null;
      edges.push({ from: file, to, spec, names: importedNames(m[1]) });
    }
  }
  return { files, edges, sources };
}

// ---------------------------------------------------------------- 合成图自测

/** 一颗合成边：便于自测里少写样板。 */
const E = (from, to, spec, names = []) => ({ from, to, spec, names });

/** 每条规则一正一反：`bad` 必须红（且命中指定规则码），`good` 必须全绿。 */
const SELF_CASES = [
  {
    rule: "a",
    bad: { files: ["x.mjs"], edges: [E("x.mjs", null, "axios")] },
    good: { files: ["x.mjs", "y.mjs"], edges: [E("x.mjs", null, "node:fs"), E("x.mjs", "y.mjs", "./y.mjs")] },
  },
  {
    rule: "a",
    note: "相对说明符解析不到文件（路径拼错 / 解析器坏了）",
    bad: { files: ["x.mjs"], edges: [E("x.mjs", "gone.mjs", "./gone.mjs")] },
    good: { files: ["x.mjs", "y.mjs"], edges: [E("x.mjs", "y.mjs", "./y.mjs")] },
  },
  {
    rule: "b",
    bad: { files: ["x.mjs", "y.mjs"], edges: [E("x.mjs", "y.mjs", "./y.mjs"), E("y.mjs", "x.mjs", "./x.mjs")] },
    good: { files: ["x.mjs", "y.mjs"], edges: [E("x.mjs", "y.mjs", "./y.mjs")] },
  },
  {
    rule: "c",
    bad: {
      files: ["lib/domain.mjs", "lib/helper.mjs"],
      edges: [E("lib/domain.mjs", "lib/helper.mjs", "./helper.mjs")],
    },
    good: { files: ["lib/domain.mjs"], edges: [] },
  },
  {
    rule: "c",
    note: "lib/paths.mjs 只许 node:path / node:url",
    bad: {
      files: ["lib/paths.mjs", "lib/x.mjs"],
      edges: [E("lib/paths.mjs", "lib/x.mjs", "./x.mjs")],
    },
    good: {
      files: ["lib/paths.mjs"],
      edges: [E("lib/paths.mjs", null, "node:path"), E("lib/paths.mjs", null, "node:url")],
    },
  },
  {
    rule: "d",
    bad: {
      files: ["daily/lib/days.mjs", "daily/render.mjs"],
      edges: [E("daily/lib/days.mjs", "daily/render.mjs", "../render.mjs")],
    },
    good: {
      files: ["daily/lib/days.mjs", "cst.mjs", "lib/paths.mjs"],
      edges: [E("daily/lib/days.mjs", "cst.mjs", "../../cst.mjs"), E("daily/lib/days.mjs", "lib/paths.mjs", "../../lib/paths.mjs")],
    },
  },
  {
    rule: "e",
    bad: {
      files: ["daily/render.mjs", "daily/lib/ai.mjs"],
      edges: [E("daily/render.mjs", "daily/lib/ai.mjs", "./lib/ai.mjs")],
    },
    good: {
      files: ["daily/render.mjs", "daily/lib/ai/prose.mjs", "site/shell.mjs"],
      edges: [
        E("daily/render.mjs", "daily/lib/ai/prose.mjs", "./lib/ai/prose.mjs"),
        E("daily/render.mjs", "site/shell.mjs", "../site/shell.mjs"),
      ],
    },
  },
  {
    rule: "f",
    bad: {
      files: ["daily/render.mjs", "summary/render.mjs"],
      edges: [E("summary/render.mjs", "daily/render.mjs", "../daily/render.mjs")],
    },
    good: {
      files: ["daily/render.mjs", "summary/render.mjs", "site/shell.mjs"],
      edges: [E("summary/render.mjs", "site/shell.mjs", "../site/shell.mjs")],
    },
  },
  {
    rule: "g",
    bad: {
      files: ["daily/lib/days.mjs"],
      edges: [E("daily/lib/days.mjs", null, "node:url", ["fileURLToPath"])],
    },
    good: { files: ["lib/paths.mjs"], edges: [E("lib/paths.mjs", null, "node:url", ["fileURLToPath"])] },
  },
];

/** 跑合成图自测，返回失败描述（空数组 = 全绿）。 */
export function selfTest() {
  const failures = [];
  for (const [i, c] of SELF_CASES.entries()) {
    const badHits = checkGraph(c.bad);
    if (!badHits.some((v) => v.startsWith(`[${c.rule}]`))) {
      failures.push(`[自测 ${i + 1}] 规则 ${c.rule} 的违规样本没被判红${c.note ? `（${c.note}）` : ""}`);
    }
    const goodHits = checkGraph(c.good);
    if (goodHits.length > 0) {
      failures.push(`[自测 ${i + 1}] 规则 ${c.rule} 的合法样本被误判：${goodHits.join("；")}`);
    }
  }

  // 名称级归属：一正一反
  const goodDecl = checkDeclarations([
    { file: "lib/rules.mjs", source: "export const HEADLINE_MAX_CHARS = 80;\n" },
    { file: "daily/lib/ai/narrative.mjs", source: "import { HEADLINE_MAX_CHARS } from '../../../lib/rules.mjs';\n" },
  ]);
  if (goodDecl.length > 0) failures.push(`[自测 decl] 合法样本被误判：${goodDecl.join("；")}`);
  const badDecl = checkDeclarations([
    { file: "lib/rules.mjs", source: "export function fitText() {}\n" },
    { file: "summary/validate-summary.mjs", source: "const HEADLINE_MAX_CHARS = 80;\n" },
  ]);
  if (!badDecl.some((v) => v.includes("HEADLINE_MAX_CHARS"))) {
    failures.push("[自测 decl] 归属外声明没被判红");
  }
  return failures;
}

// ---------------------------------------------------------------- CLI

function main() {
  const selfFailures = selfTest();
  if (selfFailures.length) {
    console.log("FAIL 合成图自测（规则本身或解析器有问题，先修测试再信任下面的扫描）");
    for (const f of selfFailures) console.log(`  ${f}`);
    process.exit(1);
    return;
  }

  const { files, edges, sources } = scanScripts();
  const unique = new Set(edges.map((e) => `${e.from} -> ${e.to ?? e.spec}`));
  const violations = [...checkGraph({ files, edges }), ...checkDeclarations(sources)];

  // 扫描结果的健全性：解析器坏掉时边集会塌成空集，那样「无违规」毫无意义
  if (files.length < 20 || edges.length < 20) {
    violations.push(`[scan] 扫描结果异常：${files.length} 个文件 / ${edges.length} 条边（解析器可能坏了）`);
  }

  if (violations.length) {
    console.log(`FAIL 分层边界（${violations.length} 处违规 / ${files.length} 文件 / ${unique.size} 唯一模块对）`);
    for (const v of violations) console.log(`  ${v}`);
    process.exit(1);
    return;
  }

  console.log(
    `OK 分层边界：${files.length} 文件 / ${edges.length} 条 import 语句 / ${unique.size} 唯一模块对；七条禁边 + 名称级归属全部通过（合成自测 ${SELF_CASES.length} 例 + 归属 2 例）`
  );
}

main();
