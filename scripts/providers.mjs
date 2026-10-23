#!/usr/bin/env node
/**
 * scripts/providers.mjs
 * ------------------------------------------------------------------
 * provider 配置的薄 CLI（零依赖 ESM）——只做 argv 解析、网络探测与 I/O，逻辑全在
 * `scripts/daily/lib/providers.mjs`（schema / lane 解析 / 写操作 / 接线断言）。
 *
 * 为什么要有它：改链路 / 改参数 / 改预算 = 改一个 JSON + 跑一条命令。所有写操作都
 * **先打印 unified diff，`--yes` 才落盘**（`--dry-run` 显式只读）；加一条腿是一条命令，
 * 但探测门槛在前面：探测不通过就**不写配置、不推密钥**。
 *
 * 命令：
 *   node scripts/providers.mjs add <slug> --endpoint=<ep> --api-model=<id> \
 *        [--param k=v]... [--lane=daily] [--note=...] [--top|--bottom|--before=<slug>|--after=<slug>] \
 *        [--prompt=real|small] [--runs=3] [--yes] [--push-secret] [--config=<path>]
 *      ① 打印配置 diff（不带 --yes 只干跑，不联网）
 *      ② --yes：真实探测 3/3（单次 ≤90s + 非空输出）—— 不通过就停，不写配置、不推密钥
 *      ③ 落盘（diff 已经打印过）
 *      ④ secret 只做干跑预览（name / 长度 / sha256 前 8 位）；`--push-secret` 才真的 `gh secret set`（值走 stdin）
 *
 *   node scripts/providers.mjs probe <slug> [--prompt=small|real] [--runs=3] [--compare=<slug>]
 *   node scripts/providers.mjs probe --lane=<lane> [--prompt=...] [--runs=1]
 *   node scripts/providers.mjs status [--json]        # 本机 env / repo secret / 配置 三方对照（只读）
 *   node scripts/providers.mjs check                  # schema + workflow 接线断言（check.mjs 会跑它）
 *   node scripts/providers.mjs list [--lane=<lane>] [--json]
 *   node scripts/providers.mjs show <slug|lane|endpoint:NAME|model:SLUG|lane:LANE>
 *   node scripts/providers.mjs lane add|remove|move <lane> <slug> [--top|--bottom|--before=<slug>|--after=<slug>]
 *   node scripts/providers.mjs set <slug|lane|endpoint:NAME> <path>=<value>   # 例：set nvidia-minimax-flash params.reasoningEffort=low
 *   node scripts/providers.mjs enable|disable <slug>
 *   node scripts/providers.mjs help [命令] | <命令> --help | -h
 *       内置帮助：不带参数就是总览，`add --help` / `help add` 是那条命令的完整用法
 *        （每个参数的语义、门槛、示例、退出码都在里面；本文件头只留一行摘要）
 *
 * 安全：key 只从 env / stdin 进入，**输出里永不出现明文**；`gh secret set NAME` 不带 `--body`（值走 stdin）。
 *
 * 探测口径（P0 实测的门槛）：3/3 出合法结果 + 单次 ≤90s + 输出非空。`--prompt=real` 走与生产完全相同的
 * 代码路径（`generateNarrative` + 真实 fixture），`--prompt=small` 只发一个 30 字的探活 prompt。
 * `--compare=<slug>` 会把另一条腿在同一份数据上的输出并排打出来 —— **事实/中英对称/格式这三项要比稿人工判定**，
 * 脚本能自动挡住的只有结构合法与耗时。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { generateNarrative, generateStructured } from "./daily/lib/ai.mjs";
import { ROOT } from "./lib/paths.mjs";
import {
  CONFIG_PATH,
  addProvider,
  catalogue,
  checkWorkflowWiring,
  laneAdd,
  laneBudgetMs,
  laneMove,
  laneOrder,
  laneRemove,
  loadConfig,
  previewAdd,
  providerForSlug,
  providersForLane,
  resolveApiKey,
  resolveTarget,
  serializeConfig,
  setEnabled,
  setPath,
  statusReport,
  unifiedDiff,
  validateConfig,
  writeConfig,
} from "./daily/lib/providers.mjs";

const LOG = "[providers]";
const PROBE_LIMIT_MS = 90000; // 单次探测上限（P0 门槛：minimax ≈10s、ultra ≈30s）
const PROBE_RUNS = 3; // 门槛要求 3/3

const PROBE_SYSTEM = "You reply with ONE strict JSON object only: no prose, no markdown fences.";
const PROBE_USER = 'Return exactly {"ok":true,"note":"probe"} and nothing else.';
const probeValidate = (parsed) =>
  parsed && parsed.ok === true ? { ok: true, value: parsed } : { ok: false, reason: "缺少 ok:true" };

// ---------------------------------------------------------------- 参数解析

/**
 * `--k=v` / `--k v` / `--flag`（布尔）/ 位置参数。
 * `--param` 可重复，收进数组（其余同名 flag 后者覆盖前者）。
 */
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    let value;
    if (eq !== -1) {
      value = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) value = true;
      else {
        value = next;
        i += 1;
      }
    }
    if (key === "param") flags.param = [...(flags.param || []), String(value)];
    else flags[key] = value;
  }
  return { flags, rest };
}

function configPathOf(flags) {
  return flags.config ? path.resolve(String(flags.config)) : CONFIG_PATH;
}

function resolvePosition(flags) {
  const given = ["top", "bottom", "before", "after"].filter((k) => flags[k] !== undefined);
  if (given.length > 1) throw new Error(`位置参数只能给一个（现在给了 ${given.map((k) => `--${k}`).join(" / ")}）`);
  if (given.length === 0) return { where: "bottom" };
  const k = given[0];
  if (k === "top" || k === "bottom") return { where: k };
  return { where: k, ref: String(flags[k]) };
}

/** `--param k=v` → { k: parseValue(v) }（嵌套用点号：`extraBody.thinking.type=disabled`）。 */
function parseParams(pairs = []) {
  const params = {};
  for (const pair of pairs) {
    const eq = String(pair).indexOf("=");
    if (eq <= 0) throw new Error(`--param 需要 k=v（收到 ${JSON.stringify(pair)}）`);
    const key = String(pair).slice(0, eq);
    const raw = String(pair).slice(eq + 1);
    const segs = key.split(".").filter(Boolean);
    let node = params;
    for (const seg of segs.slice(0, -1)) {
      if (!node[seg] || typeof node[seg] !== "object") node[seg] = {};
      node = node[seg];
    }
    const last = segs[segs.length - 1];
    if (raw === "true") node[last] = true;
    else if (raw === "false") node[last] = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(raw)) node[last] = Number(raw);
    else node[last] = raw;
  }
  return params;
}

// ---------------------------------------------------------------- 网络探测

/** 最新一份日报数据（`docs/data/<date>.json`）—— real prompt 的 fixture。 */
function latestDataFile() {
  const dir = path.join(ROOT, "docs", "data");
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  return files.length ? path.join(dir, files.at(-1)) : null;
}

function loadProbeData() {
  const file = latestDataFile();
  if (!file) return null;
  try {
    return { file, data: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return null;
  }
}

/**
 * 真实探测：跑 `runs` 次，每次都走 `ai.mjs` 的同一条代码路径。
 *   prompt=real  → `generateNarrative`（生产同一套 prompt + 校验）
 *   prompt=small → `generateStructured` + 一个探活校验器
 * 返回 { ok, runs:[{ok,ms,chars,error}], error, preview }（preview 只在 real 时有内容，供比稿打印）。
 */
async function probeProvider(provider, { runs = PROBE_RUNS, prompt = "real", data = null } = {}) {
  const out = { ok: false, runs: [], error: "", preview: null };
  const total = Math.max(1, Number(runs) || 1);
  const fixture = prompt === "real" ? data || loadProbeData() : null;
  if (prompt === "real" && !fixture) {
    return { ...out, error: "没有可用的 docs/data/<date>.json，改跑 --prompt=small" };
  }
  for (let i = 0; i < total; i += 1) {
    const started = Date.now();
    let ok = false;
    let chars = 0;
    let error = "";
    let preview = null;
    if (prompt === "real") {
      const res = await generateNarrative({ data: fixture.data, providers: [provider] });
      if (res) {
        ok = true;
        chars = String(res.en?.summary || "").length + String(res.zh?.summary || "").length;
        preview = { en: res.en, zh: res.zh, model: res.model };
      } else {
        error = "generateNarrative 返回 null（详见上面的 provider 日志）";
      }
    } else {
      const res = await generateStructured({
        system: PROBE_SYSTEM,
        user: PROBE_USER,
        validate: probeValidate,
        providers: [provider],
      });
      if (res) {
        ok = true;
        chars = JSON.stringify(res.value).length;
      } else {
        error = "generateStructured 返回 null（详见上面的 provider 日志）";
      }
    }
    const ms = Date.now() - started;
    const withinLimit = ms <= PROBE_LIMIT_MS;
    out.runs.push({ ok: ok && withinLimit, ms, chars, error: withinLimit ? error : `耗时 ${ms}ms > ${PROBE_LIMIT_MS}ms` });
    if (preview) out.preview = preview;
  }
  out.ok = out.runs.length > 0 && out.runs.every((r) => r.ok);
  return out;
}

// ---------------------------------------------------------------- gh

const ghImpl = {
  secretList() {
    const res = spawnSync("gh", ["secret", "list"], { encoding: "utf8" });
    return res.status === 0 ? res.stdout : null;
  },
  /** 值只走 stdin：绝不 `--body`，也绝不进日志。 */
  secretSet({ name, value }) {
    return spawnSync("gh", ["secret", "set", name], { input: value, encoding: "utf8" });
  },
};

// ---------------------------------------------------------------- 输出格式

const mark = (v) => (v ? "✓" : "✗");

function printProbe(name, probe) {
  console.log(`${name}:`);
  if (probe.error) console.log(`  ✗ ${probe.error}`);
  for (const [i, r] of (probe.runs || []).entries()) {
    console.log(`  run ${i + 1}: ${r.ok ? "✓" : "✗"} ${r.ms}ms${r.chars ? ` · ${r.chars} 字符` : ""}${r.error ? ` · ${r.error}` : ""}`);
  }
  console.log(`  判定：${probe.ok ? `✓ 通过（${(probe.runs || []).length}/${(probe.runs || []).length}，单次 ≤${PROBE_LIMIT_MS / 1000}s）` : "✗ 不通过"}`);
}

function commitDiff(label, beforeText, nextConfig, { yes, configPath }) {
  const afterText = serializeConfig(nextConfig);
  const diff = unifiedDiff(beforeText, afterText, { file: path.relative(ROOT, configPath) || configPath });
  if (!diff) {
    console.log(`${label}：配置没有变化`);
    return false;
  }
  console.log(diff);
  if (!yes) {
    console.log(`\n（干跑：${label} 未落盘。确认后加 --yes 重跑）`);
    return false;
  }
  writeConfig(nextConfig, configPath);
  console.log(`\n已写入 ${path.relative(ROOT, configPath) || configPath}`);
  return true;
}

// ---------------------------------------------------------------- 命令

function cmdList(flags) {
  const configPath = configPathOf(flags);
  const rows = catalogue(process.env, { configPath });
  const lane = flags.lane ? String(flags.lane) : null;
  let filtered = rows;
  if (lane) {
    const order = laneOrder(lane, { configPath });
    filtered = order.flatMap((slug) => rows.filter((r) => r.name === slug));
    if (filtered.length === 0) {
      console.error(`${LOG} lane \`${lane}\` 里没有可用 model（先 \`show ${lane}\` 看配置）`);
      process.exitCode = 1;
      return;
    }
  }
  if (flags.json) {
    console.log(JSON.stringify(filtered.map(({ apiKey, ...rest }) => rest), null, 2));
    return;
  }
  const head = lane ? `lane ${lane}（按链顺序）：` : "配置里的全部 model：";
  console.log(head);
  const rowsOut = filtered.map((r) => ({
    slug: r.name,
    endpoint: r.endpoint,
    apiModel: r.model,
    enabled: mark(r.enabled && r.endpointEnabled),
    key: `${mark(r.configured)}${r.keyEnvUsed ? ` (${r.keyEnvUsed})` : r.configured ? "" : ` (缺 ${r.keyEnv})`}`,
    lanes: r.lanes.length ? r.lanes.join(",") : "—",
  }));
  const cols = [
    ["slug", "slug"],
    ["endpoint", "endpoint"],
    ["apiModel", "apiModel"],
    ["enabled", "enabled"],
    ["key", "key"],
    ["lanes", "lanes"],
  ];
  const width = Object.fromEntries(
    cols.map(([k, title]) => [k, Math.max(title.length, ...rowsOut.map((r) => String(r[k]).length))])
  );
  console.log(cols.map(([, title]) => title.padEnd(width[title])).join("  "));
  for (const r of rowsOut) console.log(cols.map(([k]) => String(r[k]).padEnd(width[k])).join("  "));
  if (lane) {
    const budget = laneBudgetMs(lane, { configPath });
    console.log(`\n预算：${budget ? `${budget}ms（${Math.round(budget / 60000)} 分钟）` : "不设上限"}`);
  }
}

function cmdShow(flags, rest) {
  const target = rest[0];
  if (!target) throw new Error("用法：show <slug|lane|endpoint:NAME>");
  const loaded = loadConfig(configPathOf(flags));
  if (!loaded.ok) throw new Error(`配置不可用：${loaded.errors.join("；")}`);
  const resolved = resolveTarget(loaded.config, target);
  const bucket = { model: loaded.config.models, lane: loaded.config.lanes, endpoint: loaded.config.endpoints }[resolved.kind];
  const node = bucket[resolved.id];
  const extra =
    resolved.kind === "model"
      ? {
          lanes: Object.entries(loaded.config.lanes)
            .filter(([, def]) => Array.isArray(def.order) && def.order.includes(resolved.id))
            .map(([name]) => name),
          endpointDef: loaded.config.endpoints[node.endpoint],
          ...(() => {
            const { value, envVar } = resolveApiKey(loaded.config.endpoints[node.endpoint], process.env);
            return { keyPresent: Boolean(value), keyEnvUsed: envVar };
          })(),
        }
      : {};
  console.log(JSON.stringify({ kind: resolved.kind, id: resolved.id, ...node, ...extra }, null, 2));
}

function cmdStatus(flags) {
  const secretList = ghImpl.secretList();
  const { rows, errors } = statusReport({ env: process.env, configPath: configPathOf(flags), secretList });
  if (flags.json) {
    console.log(JSON.stringify({ rows: rows.map(({ apiKey, ...rest }) => rest), errors }, null, 2));
    return;
  }
  console.log("本机 env / repo secret / 配置 三方对照：");
  for (const row of rows) {
    const envText = row.envSource ? `✓ ${row.envSource}` : `✗ 缺 ${row.keyEnv}${row.keyEnvAliases.length ? ` / ${row.keyEnvAliases.join(" / ")}` : ""}`;
    const secretText = row.secretStatus === "present" ? "✓ 已设置" : row.secretStatus === "missing" ? "✗ 未设置" : "? 未知";
    const laneText = row.lanes.length ? row.lanes.join(",") : "未入链";
    console.log(
      `- ${row.name}（${row.endpoint} / ${row.model}）enabled=${mark(row.enabled && row.endpointEnabled)} · lanes=${laneText} · env=${envText} · repo secret=${secretText}`
    );
  }
  for (const err of errors) console.log(`\n注意：${err}`);
  console.log("\n（env 只看变量是否存在，secret 只看名字；任何 key 值都不会打印）");
}

function cmdCheck(flags) {
  let failed = 0;
  const configPath = configPathOf(flags);
  const loaded = loadConfig(configPath);
  const rel = path.relative(ROOT, configPath) || configPath;
  if (!loaded.ok) {
    console.log(`FAIL 配置 schema（${rel}）`);
    for (const e of loaded.errors) console.log(`  - ${e}`);
    failed += 1;
  } else {
    console.log(`OK   配置 schema（${rel}，${Object.keys(loaded.config.models).length} 个 model / ${Object.keys(loaded.config.lanes).length} 条 lane）`);
  }

  const wiring = checkWorkflowWiring({ configPath });
  if (wiring.ok) {
    console.log(`OK   workflow 接线（${wiring.checked.map((c) => `${c.file.split(/[\\/]/).pop()}[${c.rules.join("")}]`).join(" ")}）`);
  } else {
    console.log("FAIL workflow 接线");
    for (const e of wiring.errors) console.log(`  - ${e}`);
    failed += 1;
  }
  if (failed > 0) {
    console.log(`\nproviders check FAILED（${failed} 项）`);
    process.exitCode = 1;
  } else {
    console.log("\nproviders check OK");
  }
}

async function cmdProbe(flags, rest) {
  const prompt = flags.prompt === "small" ? "small" : "real";
  const data = prompt === "real" ? loadProbeData() : null;
  if (prompt === "real" && !data) {
    throw new Error("没有可用的 docs/data/<date>.json；用 --prompt=small 做探活");
  }
  const runs = Number(flags.runs || 1);
  const targets = [];

  if (flags.lane) {
    const lane = String(flags.lane);
    const providers = providersForLane(lane, process.env, { configPath: configPathOf(flags) });
    if (providers.length === 0) throw new Error(`lane \`${lane}\` 没有可用 provider（缺 key？看 status）`);
    for (const p of providers) targets.push({ provider: p, runs });
  } else {
    const slug = rest[0];
    if (!slug) throw new Error("用法：probe <slug> | --lane=<lane>");
    const { provider, reason } = providerForSlug(slug, process.env, { configPath: configPathOf(flags) });
    if (!provider) throw new Error(`探测不了 \`${slug}\`：${reason}`);
    targets.push({ provider, runs: Number(flags.runs || PROBE_RUNS) });
  }

  if (data) console.log(`fixture：${path.relative(ROOT, data.file)}（--prompt=real，与生产同一套 prompt/校验）\n`);
  let allOk = true;
  for (const t of targets) {
    const probe = await probeProvider(t.provider, { runs: t.runs, prompt, data });
    printProbe(`${t.provider.name}（${t.provider.model}）`, probe);
    console.log("");
    allOk = allOk && probe.ok;
    if (flags.compare && probe.preview) {
      const other = providerForSlug(String(flags.compare), process.env, { configPath: configPathOf(flags) });
      if (!other.provider) {
        console.log(`比稿：拿不到 \`${flags.compare}\`（${other.reason}），跳过\n`);
      } else {
        const cmp = await probeProvider(other.provider, { runs: 1, prompt, data });
        console.log(`比稿（同一份数据，人工判定事实 / 中英对称 / 格式）：`);
        console.log(`  新腿 ${t.provider.name}: ${probe.preview.en?.headline || "?"} / ${probe.preview.zh?.headline || "?"}`);
        console.log(`  对照 ${other.provider.name}: ${cmp.preview?.en?.headline || "?"} / ${cmp.preview?.zh?.headline || "?"}`);
        console.log(`  新腿英文正文：${String(probe.preview.en?.summary || "").slice(0, 400)}`);
        console.log(`  对照英文正文：${String(cmp.preview?.en?.summary || "").slice(0, 400)}\n`);
      }
    }
  }
  if (!allOk) process.exitCode = 1;
}

async function cmdAdd(flags, rest) {
  const slug = rest[0];
  if (!slug) throw new Error("用法：add <slug> --endpoint=<ep> --api-model=<id> [--lane=<lane>] [--yes]（完整参数：providers.mjs add --help）");
  const spec = {
    slug,
    endpoint: flags.endpoint && String(flags.endpoint),
    apiModel: flags["api-model"] && String(flags["api-model"]),
    params: parseParams(flags.param),
    note: flags.note ? String(flags.note) : "",
    lane: flags.lane ? String(flags.lane) : "",
    position: resolvePosition(flags),
  };
  const configPath = configPathOf(flags);
  const preview = await previewAdd(spec, { configPath });
  console.log(preview.diff || "（配置没有变化）");

  if (flags["dry-run"] || !flags.yes) {
    console.log(
      "\n干跑：未探测、未落盘。加 --yes 会依次执行 真实探测 3/3（≤90s/次）→ 落盘 → secret 干跑预览。"
    );
    return;
  }

  console.log("\n① 真实探测（3/3 + 单次 ≤90s + 输出非空）……");
  const res = await addProvider(spec, {
    configPath,
    env: process.env,
    yes: true,
    prompt: flags.prompt === "small" ? "small" : "real",
    runs: Number(flags.runs || PROBE_RUNS),
    probeImpl: (provider, opts) => probeProvider(provider, opts),
    ghImpl,
    pushSecret: Boolean(flags["push-secret"]),
  });
  if (res.probe) printProbe(`${slug}（探测）`, res.probe);
  if (!res.ok) {
    console.error(`\n${LOG} ✗ ${res.stage}：${res.errors.join("；") || "失败"}`);
    console.error(`${LOG} 配置未改动，secret 未推送`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n② 已落盘（${path.relative(ROOT, configPath) || configPath}）`);
  if (res.secret) {
    const how = res.secret.dryRun ? "干跑（--push-secret 才真推）" : res.secret.ok ? "已推送" : "推送失败";
    console.log(
      `③ repo secret ${res.secret.name}：${how} · 长度 ${res.secret.length} · sha256 ${res.secret.sha}`
    );
    if (!res.secret.dryRun && !res.secret.ok) console.error(`${LOG} ${res.secret.error}`);
  }
  const loaded = loadConfig(configPath);
  const model = loaded.ok ? loaded.config.models[slug] : null;
  const ep = loaded.ok && model ? loaded.config.endpoints[model.endpoint] : null;
  if (ep) {
    console.log(`\n④ workflow 接线（缺了 \`providers check\` 会红）——在运行相关脚本的 step 的 \`env:\` 里抄这一行：`);
    console.log(`   ${ep.keyEnv}: \${{ secrets.${ep.keyEnv} }}`);
    console.log("   需要加在哪些文件/哪一步：node scripts/providers.mjs check");
  }
  console.log(`\n最后：node scripts/daily/check.mjs（全量预检，含 providers check 与 test-providers.mjs）`);
}

function cmdMutate(label, flags, mutate) {
  const configPath = configPathOf(flags);
  const loaded = loadConfig(configPath);
  if (!loaded.ok) throw new Error(`配置不可用，先修它：${loaded.errors.join("；")}`);
  if (flags["dry-run"]) {
    const next = mutate(loaded.config);
    const diff = unifiedDiff(serializeConfig(loaded.config), serializeConfig(next), {
      file: path.relative(ROOT, configPath) || configPath,
    });
    console.log(diff || `${label}：配置没有变化`);
    console.log("\n（--dry-run：未落盘）");
    return;
  }
  const next = mutate(loaded.config);
  commitDiff(label, serializeConfig(loaded.config), next, { yes: Boolean(flags.yes), configPath });
}

function cmdLane(flags, rest) {
  const [action, lane, slug] = rest;
  if (!action || !lane) throw new Error("用法：lane add|remove|move <lane> <slug> [--before|--after <slug>|--top|--bottom]");
  if (action !== "add" && action !== "remove" && action !== "move") throw new Error(`未知 lane 子命令：${action}`);
  const position = resolvePosition(flags);
  cmdMutate(`lane ${action} ${lane} ${slug}`, flags, (config) => {
    if (action === "add") return laneAdd(config, lane, slug, position);
    if (action === "move") return laneMove(config, lane, slug, position);
    return laneRemove(config, lane, slug);
  });
}

function cmdSet(flags, rest) {
  const [target, assignment] = rest;
  if (!target || !assignment) throw new Error("用法：set <slug|lane|endpoint:NAME> <path>=<value>");
  const eq = assignment.indexOf("=");
  if (eq <= 0) throw new Error("赋值要写成 path=value（例：params.reasoningEffort=low）");
  const pathExpr = assignment.slice(0, eq);
  const value = assignment.slice(eq + 1);
  cmdMutate(`set ${target} ${pathExpr}=${value}`, flags, (config) => setPath(config, target, pathExpr, value));
}

function cmdToggle(flags, rest, enabled) {
  const slug = rest[0];
  if (!slug) throw new Error(`用法：${enabled ? "enable" : "disable"} <slug>`);
  cmdMutate(`${enabled ? "enable" : "disable"} ${slug}`, flags, (config) => setEnabled(config, slug, enabled));
}

// ---------------------------------------------------------------- 帮助

const GLOBAL_HELP = `用法：node scripts/providers.mjs <命令> [参数]

provider 配置（config/providers.json）的 CLI：改链路 / 换模型 / 调参数 / 加一条腿。
所有写操作都是「先打印 unified diff，--yes 才落盘」；key 只从环境变量进，输出里不出现明文。

命令：
  add <slug> --endpoint=<ep> --api-model=<id>   加一条腿：diff → 真实探测 3/3 → 落盘 → secret 预览
  probe <slug> | --lane=<lane>                  按生产 prompt 真跑一遍（联网，要 key）
  status                                        本机 env / repo secret / 配置 三方对照
  check                                         配置 schema + workflow 接线断言
  list [--lane=<lane>] [--json]                 链顺序 + 每条腿的 key 状态
  show <slug|lane|endpoint:NAME>                看一个节点的完整 JSON
  lane add|remove|move <lane> <slug>            改链顺序
  set <target> <path>=<value>                   改参数 / 预算 / 端点
  enable|disable <slug>                         临时停用 / 恢复一条腿
  help [命令]                                   这条命令的完整用法（等价 <命令> --help）

全局参数（所有命令都认）：
  -h, --help        看帮助（放在命令后面就是该命令的帮助，例：add --help）
  --yes             写操作真正落盘（不带只打印 diff）
  --dry-run         显式只读（优先于 --yes）
  --config=<path>   改一份临时配置副本，不碰 config/providers.json

例子：
  node scripts/providers.mjs list --lane=daily
  node scripts/providers.mjs help add
  node scripts/providers.mjs disable nvidia-minimax-flash --yes
  node scripts/providers.mjs add my-leg --endpoint=nvidia --api-model=vendor/model-id --lane=daily --top --yes
  node scripts/daily/check.mjs          # 改完必须跑的全量预检（含 providers check）
`;

const COMMAND_HELP = {
  help: `用法：node scripts/providers.mjs help [命令]
等价于 \`<命令> --help\`；不带命令就是这份总览。
示例：node scripts/providers.mjs help add`,

  add: `用法：
  node scripts/providers.mjs add <slug> --endpoint=<endpoint> --api-model=<apiModel>
      [--param k=v]... [--lane=<lane>] [--note=<text>]
      [--top | --bottom | --before=<slug> | --after=<slug>]
      [--prompt=real|small] [--runs=3] [--yes] [--push-secret] [--config=<path>]

做什么（四段）：
  ① 打印候选配置与磁盘配置的 unified diff（不联网、不落盘）
  ② --yes：走生产同一套 prompt/校验真跑 --runs 次（默认 3）；
     门槛 = 每次都过校验 + 单次 ≤90s + 输出非空；不通过 → 不写配置、不推 secret，退出码 1
  ③ 落盘（tmp + rename），写完立刻做 schema 校验
  ④ secret 默认只预览 name / 长度 / sha256 前 8 位；--push-secret 才 gh secret set（值走 stdin）

参数：
  --endpoint          必填。config/providers.json 里已存在的 endpoints 名
  --api-model         必填。上游真实模型 id（不是 slug）
  --param k=v         可重复；点号表示嵌套：
                        reasoningEffort=low / responseFormat=false / extraBody.thinking.type=disabled
                      （params 只允许这三个字段，写 temperature 会被 schema 拒绝）
  --lane=<lane>       同时加进哪条链；不给就只写 model、不进任何链
  --note=<text>       写清「为什么它在链里 / 为什么不在」—— 半年后只有它能回答
  --top / --bottom / --before=<slug> / --after=<slug>   进链位置（默认 bottom）
  --prompt=real|small real 用 docs/data/<最新>.json 走生产路径；small 只探活（没有 fixture 时用）
  --runs=N            探测次数（默认 3）
  --yes               真正探测并落盘；不带只打印 diff
  --push-secret       真的推 repo secret（默认干跑）
  --dry-run           显式只读

示例：
  # ① 只看 diff
  node scripts/providers.mjs add nvidia-nemotron-lightning --endpoint=nvidia ^
    --api-model=nvidia/nemotron-3.5-lightning-30b-a3b --param reasoningEffort=none --lane=daily --top
  # ② 确认后末尾加 --yes 真跑；③ 要推 secret 再加 --push-secret

注意：脚本只能挡住「结构合法 + 耗时」，挡不住「说得对不对」——
      入链前用 probe <slug> --compare=<稳定腿> 人工比稿（事实 / 中英对称 / 格式）。`,

  probe: `用法：
  node scripts/providers.mjs probe <slug> [--prompt=real|small] [--runs=N] [--compare=<slug>]
  node scripts/providers.mjs probe --lane=<lane> [--prompt=real|small] [--runs=N]

做什么：走 ai.mjs 与生产完全相同的代码路径真跑一遍（联网，需要该 endpoint 的 key）。
  --prompt=real（默认）  generateNarrative + docs/data/<最新>.json 作为 fixture，结果还要过 validateNarrative
  --prompt=small         只发一个探活 prompt（几十 token），确认端点 / 鉴权活着

门槛：每次都必须过校验、单次 ≤90s、输出非空；任何一次失败 → 退出码 1。
默认次数：单条腿 3 次（--runs 改）；整条 lane 每条腿 1 次。

参数：
  --lane=<lane>      探整条链（daily / summary）
  --runs=N           覆盖次数
  --compare=<slug>   把另一条腿在同一份数据上的输出并排打出来（同 prompt）
  --prompt=real|small

示例：
  node scripts/providers.mjs probe nvidia-minimax-flash
  node scripts/providers.mjs probe --lane=daily --prompt=real
  node scripts/providers.mjs probe my-leg --compare=opencode-go-deepseek

注意：--compare 只负责打印，事实准确性 / 中英对称 / 反引号与加粗要自己读。
      免费层连续快调会 429（会等 2s 重试一次再换腿），别把 --runs 开很大。
      只读：不写任何文件。`,

  status: `用法：node scripts/providers.mjs status [--json]

做什么：本机 env / repo secret / 配置 三方对照，回答「配置里有这条腿，为什么没生效」。
  env 列         显示实际命中的变量名（可能是 keyEnvAliases 里的别名）
  repo secret 列 靠 gh secret list；未登录 / 无网时显示 "? 未知"（不报错退出）
  配置坏了会回落到内置 FALLBACK_CHAIN，这里看到的就是回落后的目录

只读；任何 key 值都不打印（只看变量是否存在、secret 名是否存在）。
示例：node scripts/providers.mjs status --json`,

  check: `用法：node scripts/providers.mjs check

做什么：
  ① 配置 schema：version / endpoints（baseUrl+keyEnv）/ models（endpoint 存在、apiModel 不重复）/
     lanes（order 只引用存在的 slug、不重复、budgetMs 为正）/ params（只允许三个字段）
  ② workflow 接线硬断言（纯文本扫描，先剔掉以 # 开头的注释行）

接线规则：
  A  跑 scripts/daily/index.mjs 的 workflow      → daily 链里每个 endpoint 的 secrets.<KEY_ENV>
  B  跑 scripts/summary/index.mjs 的 workflow    → summary 链里每个 endpoint 的
  C  跑 scripts/diagnose-providers.mjs 的 workflow → 每个 enabled endpoint 的
     （诊断会探所有 /models，缺 key 会误报「未配置」）

失败时打印 文件 / 缺哪个 secrets.X / 该加在哪一步，退出码 1。
node scripts/daily/check.mjs 与 CI 的 check.yml 都会跑它。只读，不联网。`,

  list: `用法：node scripts/providers.mjs list [--lane=<lane>] [--json]

列：
  slug       稳定身份（attempts[].provider、页面 AI 徽章、历史数据都用它，别随便改）
  endpoint   走哪个端点（决定 baseUrl / keyEnv）
  apiModel   发给上游的真实模型 id
  enabled    是否被 disable（model 或 endpoint 级）
  key        ✓ 当前 shell 有 / ✗ 缺，括号里是变量名
  lanes      它进了哪些链

--lane=<lane>  只列这条链，按链顺序（末尾打印该 lane 的预算）
--json         机器可读，已剔除 apiKey

示例：
  node scripts/providers.mjs list --lane=daily
  node scripts/providers.mjs list --json

注意：key 列只反映当前 shell；CI 以 repo secret 为准，那用 status 看。`,

  show: `用法：node scripts/providers.mjs show <slug|lane|endpoint:NAME|model:SLUG|lane:LANE>

目标解析：显式前缀（model: / lane: / endpoint:）优先；否则按 model → lane → endpoint 找。
  sensenova 既是 model 也是 endpoint —— 默认命中 model；要看 endpoint 写 endpoint:sensenova。

输出：该节点的完整 JSON。看 model 时额外给：
  lanes           它进了哪些链
  endpointDef     它所属 endpoint 的完整配置
  keyPresent / keyEnvUsed   当前 shell 有没有 key（只给布尔与变量名，不给值）

示例：
  node scripts/providers.mjs show nvidia-minimax-flash
  node scripts/providers.mjs show daily
  node scripts/providers.mjs show endpoint:nvidia

只读。`,

  lane: `用法：node scripts/providers.mjs lane add|remove|move <lane> <slug> [位置]

  add     把已有 model 加进链（已在链里会报错 —— 换位置用 move）
  remove  从链里摘掉（model 本身保留；要彻底删还得手工删 models.<slug> 那段）
  move    换位置（必须先在这条链里）

位置（默认 --bottom）：
  --top | --bottom | --before=<slug> | --after=<slug>

写操作：先打印 diff，--yes 才落盘；--dry-run 显式只读。

示例：
  node scripts/providers.mjs lane move daily sensenova --top
  node scripts/providers.mjs lane add summary nvidia-minimax-flash --before=sensenova --yes
  node scripts/providers.mjs lane remove daily my-leg --yes

注意：lane 预算用 \`set <lane> budgetMs=…\`，不在这里改。`,

  set: `用法：node scripts/providers.mjs set <slug|lane|endpoint:NAME> <path>=<value>

目标解析：显式前缀 model: / lane: / endpoint: 优先；否则 model → lane → endpoint。
取值：true / false / null / 数字 / JSON 字面量，其余按字符串。
  =null 是删掉该字段（例：set daily budgetMs=null 取消预算）
路径相对目标对象，可建中间层：params.extraBody.thinking.type=disabled

常见用法：
  node scripts/providers.mjs set nvidia-minimax-flash params.reasoningEffort=low
  node scripts/providers.mjs set nvidia-minimax-flash params.responseFormat=false
  node scripts/providers.mjs set daily budgetMs=600000
  node scripts/providers.mjs set endpoint:nvidia baseUrl=https://integrate.api.nvidia.com/v1
  node scripts/providers.mjs set sensenova params.extraBody.thinking.type=disabled

限制：params 只允许 reasoningEffort / extraBody / responseFormat —— 写 temperature 会被拒。
写操作：先打印 diff，--yes 才落盘；会让 schema 不合法的改动直接抛错，不落盘。`,

  enable: `用法：node scripts/providers.mjs enable <slug> [--yes]

作用：删掉 models.<slug>.enabled（恢复进链）。被 disable 过的腿重新出现在 providersForLane 里。
写操作：先打印 diff，--yes 才落盘。
示例：node scripts/providers.mjs enable nvidia-minimax-flash --yes`,

  disable: `用法：node scripts/providers.mjs disable <slug> [--yes]

作用：写入 models.<slug>.enabled = false。被停用的腿不会出现在 providersForLane 里，
      但仍出现在 list / status / 诊断目录中（便于查看与恢复）。
回滚：这是推荐的「只改往后」的降级方式 —— 不要让已定稿日期用 --force 重跑。

写操作：先打印 diff，--yes 才落盘。
注意：disable 后 node scripts/daily/check.mjs 仍应全绿（测试断言 lane 顺序，不依赖某条腿 enabled）。
示例：node scripts/providers.mjs disable nvidia-minimax-flash --yes`,
};

/**
 * 打印帮助。`name` 为空 → 总览；给命令名 → 该命令的完整用法。
 * 未知命令：打印总览 + 报错行，退出码 1（绝不静默当成空操作）。
 */
function printHelp(name) {
  if (!name) {
    console.log(GLOBAL_HELP);
    return true;
  }
  const key = String(name).replace(/^-+/, "");
  const text = COMMAND_HELP[key];
  if (!text) {
    console.log(GLOBAL_HELP);
    console.error(`\n${LOG} 未知命令：${key}（上面是全部命令；看某条用法：providers.mjs help <命令>）`);
    process.exitCode = 1;
    return false;
  }
  console.log(text);
  return true;
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest.shift();
  if (!cmd) {
    printHelp();
    return;
  }
  if (cmd === "help") {
    printHelp(rest[0]);
    return;
  }
  if (flags.help) {
    printHelp(cmd);
    return;
  }
  switch (cmd) {
    case "list":
      return cmdList(flags);
    case "show":
      return cmdShow(flags, rest);
    case "status":
      return cmdStatus(flags);
    case "check":
      return cmdCheck(flags);
    case "probe":
      return cmdProbe(flags, rest);
    case "add":
      return cmdAdd(flags, rest);
    case "lane":
      return cmdLane(flags, rest);
    case "set":
      return cmdSet(flags, rest);
    case "enable":
      return cmdToggle(flags, rest, true);
    case "disable":
      return cmdToggle(flags, rest, false);
    default:
      console.error(`${LOG} 未知命令：${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${LOG} 错误: ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
