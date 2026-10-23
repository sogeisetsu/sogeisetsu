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
import {
  CONFIG_PATH,
  ROOT,
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
  if (!slug) throw new Error("用法：add <slug> --endpoint=<ep> --api-model=<id> [--lane=daily] [--yes]");
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

function usage() {
  console.log(
    [
      "用法：node scripts/providers.mjs <命令> [参数]",
      "",
      "  add <slug> --endpoint=<ep> --api-model=<id> [--param k=v]... [--lane=daily] [--note=…]",
      "             [--top|--bottom|--before=<slug>|--after=<slug>] [--prompt=real|small] [--runs=3]",
      "             [--yes] [--push-secret]      加一条腿：diff → 探测 3/3 → 落盘 → secret 预览",
      "  probe <slug> | --lane=<lane> [--prompt=real|small] [--runs=N] [--compare=<slug>]",
      "  status [--json]                          本机 env / repo secret / 配置 三方对照（只读）",
      "  check                                    schema + workflow 接线断言（check.mjs 会跑）",
      "  list [--lane=<lane>] [--json]            列出 model（带 key 状态与所属 lane）",
      "  show <slug|lane|endpoint:NAME>           看一条 model / 一条 lane / 一个 endpoint",
      "  lane add|remove|move <lane> <slug> [--top|--bottom|--before=<slug>|--after=<slug>]",
      "  set <slug|lane|endpoint:NAME> <path>=<value>",
      "  enable|disable <slug>",
      "",
      "所有写操作：先打印 unified diff，--yes 才落盘，--dry-run 显式只读。",
    ].join("\n")
  );
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest.shift();
  if (!cmd || cmd === "help" || flags.help) {
    usage();
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
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${LOG} 错误: ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
