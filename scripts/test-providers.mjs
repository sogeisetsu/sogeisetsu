#!/usr/bin/env node
/**
 * scripts/test-providers.mjs
 * ------------------------------------------------------------------
 * `config/providers.json` + `scripts/daily/lib/providers.mjs` + `scripts/providers.mjs` 的确定性回归
 * （零依赖、**不触网**、不需要任何真实 key）。
 *
 * 覆盖：
 *   1 schema          缺 version / endpoints / lanes 报错；model 指向不存在的 endpoint 报错；
 *                     lane 引用不存在的 slug 报错；同 endpoint 下 apiModel 重复报错
 *   2 lane 解析        顺序、enabled:false 过滤、缺 key 跳过、keyEnvAliases 命中、
 *                     `${session}` 展开且一次调用只产生一个会话
 *   3 坏配置           非法 JSON / schema 不合法 → 回落 FALLBACK_CHAIN 且 warn
 *   4 写操作往返        add / lane add|move|remove / set / enable|disable → 写→读→断言；
 *                     CLI 的 --dry-run 不落盘、--yes 才落盘（用临时副本，不碰真配置）
 *   5 add 的探测门槛   注入 probeImpl 失败 → 配置文件未变、ghImpl 未被调用
 *   6 接线断言         fixture 里缺 secrets.X → 报出；有 → 通过；注释行内的 secrets.X 不算数
 *   7 lane 预算        假服务器挂住 + budgetMs → 不再发起新请求、合成 attempt 数量正确、走全失败路径
 *   8 安全线           配置里没有明文 key 形态；gh 调用不带 --body；CLI 输出不含 key 值
 *   9 内置帮助         `--help` / `-h` / 不带参数 → 总览；`add --help` / `help add` → 该命令的完整用法；
 *                     未知命令 → 退出码 1；帮助不执行任何写操作
 *
 * 用法：node scripts/test-providers.mjs
 * 输出：每个用例一行 PASS/FAIL，结尾 N/M；有失败时退出码 1。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { ROOT, SCRIPTS_DIR } from "./lib/paths.mjs";

const CONFIG_FILE = path.join(ROOT, "config", "providers.json");
const CLI = path.join(SCRIPTS_DIR, "providers.mjs");

const providers = await import(new URL("./daily/lib/providers.mjs", import.meta.url).href);
const { generateStructured } = await import(new URL("./daily/lib/ai.mjs", import.meta.url).href);

const TMP = mkdtempSync(path.join(os.tmpdir(), "providers-test-"));
let tmpSeq = 0;

function tmpPath(name = "providers.json") {
  tmpSeq += 1;
  const dir = path.join(TMP, `case-${tmpSeq}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function writeTmpConfig(config, name) {
  const file = tmpPath(name);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}

const realConfig = () => JSON.parse(readFileSync(CONFIG_FILE, "utf8"));

/**
 * 规范配置 = 真实配置去掉所有 `enabled` 标记。
 * 回归测试要断言的是「链的结构」（顺序 / 参数 / slug），不该被一次临时的回滚演练
 * （`disable <slug>`）弄红 —— 过滤行为另外用专门 fixture 测。
 */
const canonicalConfig = () => {
  const cfg = realConfig();
  for (const model of Object.values(cfg.models)) delete model.enabled;
  return cfg;
};

/** 每个用例一行 PASS/FAIL；checks 是 [名字, 布尔] 数组。 */
let passed = 0;
let total = 0;
function check(name, checks) {
  total += 1;
  const ok = checks.every(([, v]) => v);
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  [${checks.map(([k, v]) => `${k}=${v}`).join(", ")}]`);
}

// 屏蔽被测模块的调试日志（需要看 warn 的用例自己捕获）
const origError = console.error;
let stderrBuf = "";
console.error = (...args) => {
  stderrBuf += `${args.join(" ")}\n`;
};
const drainStderr = () => {
  const s = stderrBuf;
  stderrBuf = "";
  return s;
};

try {
  // ------------------------------------------------------------ 1 schema
  {
    const base = realConfig();
    const noVersion = { ...base };
    delete noVersion.version;
    const noEndpoints = { ...base };
    delete noEndpoints.endpoints;
    const noLanes = { ...base };
    delete noLanes.lanes;
    const badEndpointRef = JSON.parse(JSON.stringify(base));
    badEndpointRef.models["nvidia-minimax-flash"].endpoint = "nope";
    const badLaneRef = JSON.parse(JSON.stringify(base));
    badLaneRef.lanes.daily.order = ["ghost-model"];
    const dupApiModel = JSON.parse(JSON.stringify(base));
    dupApiModel.models["nvidia-clone"] = {
      endpoint: "nvidia",
      apiModel: base.models["nvidia-minimax-flash"].apiModel,
    };
    const unknownParam = JSON.parse(JSON.stringify(base));
    unknownParam.models["nvidia-minimax-flash"].params.temperature = 0.1;
    const has = (cfg, needle) => providers.validateConfig(cfg).errors.some((e) => e.includes(needle));
    check("schema-errors", [
      ["realConfigValid", providers.validateConfig(base).ok === true],
      ["noVersion", has(noVersion, "version")],
      ["noEndpoints", has(noEndpoints, "endpoints")],
      ["noLanes", has(noLanes, "lanes")],
      ["badEndpointRef", has(badEndpointRef, "不存在的 endpoint")],
      ["badLaneRef", has(badLaneRef, "不存在的 model")],
      ["dupApiModel", has(dupApiModel, "同一个 apiModel")],
      ["unknownParam", has(unknownParam, "不是已知字段")],
    ]);
  }

  // ------------------------------------------------------------ 2 lane 解析
  {
    const env = { OPENCODE_API_KEY: "go-key", SENSENOVA_API_KEY: "sense-key", NVIDIA_API_KEY: "nv-key" };
    const canonFile = writeTmpConfig(canonicalConfig());
    const daily = providers.providersForLane("daily", env, { configPath: canonFile });
    const summary = providers.providersForLane("summary", env, { configPath: canonFile });
    const ordered = daily.map((p) => p.name).join(",");

    // enabled:false / 缺 key / 别名
    const cfg = canonicalConfig();
    cfg.models["nvidia-minimax-flash"].enabled = false;
    const disabledFile = writeTmpConfig(cfg);
    const withoutMinimax = providers.providersForLane("daily", env, { configPath: disabledFile });

    const noNvidiaKey = providers.providersForLane("daily", { OPENCODE_API_KEY: "go-key", SENSENOVA_API_KEY: "s" }, { configPath: canonFile });
    const alias = providers.providersForLane("daily", { Nvidia: "alias-key", OPENCODE_API_KEY: "go-key", SENSENOVA_API_KEY: "s" }, { configPath: canonFile });

    // `${session}`：同一 endpoint 上挂两条腿，一次调用必须共用一个会话 id
    const sessionCfg = canonicalConfig();
    sessionCfg.models["opencode-go-second"] = { endpoint: "opencode-go", apiModel: "another-model" };
    sessionCfg.lanes.daily.order = ["opencode-go-deepseek", "opencode-go-second"];
    const sessionFile = writeTmpConfig(sessionCfg);
    const sessionProviders = providers.providersForLane("daily", env, { configPath: sessionFile });
    const sessions = new Set(sessionProviders.map((p) => p.headers?.["x-opencode-session"]));
    const secondCallSessions = new Set(
      providers.providersForLane("daily", env, { configPath: sessionFile }).map((p) => p.headers?.["x-opencode-session"])
    );

    check("lane-resolution", [
      ["dailyOrder", ordered === "nvidia-minimax-flash,nvidia-nemotron-ultra,opencode-go-deepseek,sensenova"],
      ["summaryOrder", summary.map((p) => p.name).join(",") === "opencode-go-deepseek,sensenova"],
      ["minimaxReasoningLow", daily[0]?.reasoningEffort === "low"],
      ["ultraNoReasoning", daily[1]?.reasoningEffort === undefined],
      ["senseThinkingOff", daily.at(-1)?.extraBody?.thinking?.type === "disabled"],
      ["slugIsName", daily[0]?.name === "nvidia-minimax-flash" && daily[0]?.model === "minimaxai/minimax-m3.1-flash"],
      ["endpointField", daily[0]?.endpoint === "nvidia" && daily.at(-1)?.endpoint === "sensenova"],
      ["disabledSkipped", !withoutMinimax.some((p) => p.name === "nvidia-minimax-flash")],
      ["missingKeySkipped", !noNvidiaKey.some((p) => p.endpoint === "nvidia")],
      ["aliasHit", alias[0]?.name === "nvidia-minimax-flash" && alias[0]?.apiKey === "alias-key"],
      ["singleSessionPerCall", sessions.size === 1 && String([...sessions][0] || "").length > 8],
      [
        "sessionIncludesSession",
        String([...sessions][0] || "").startsWith("sogeisetsu-daily-report-"),
      ],
      ["newSessionPerCall", secondCallSessions.size === 1 && [...secondCallSessions][0] !== [...sessions][0]],
      ["paramsNotLeaked", daily[0]?.params === undefined && daily[1]?.model === "nvidia/nemotron-3-ultra-550b-a55b"],
    ]);
  }

  // ------------------------------------------------------------ 3 坏配置回落
  {
    providers.resetFallbackWarning();
    drainStderr();
    const brokenFile = tmpPath();
    writeFileSync(brokenFile, "{ this is not json", "utf8");
    const env = { OPENCODE_API_KEY: "go-key", SENSENOVA_API_KEY: "sense-key" };
    const list = providers.providersForLane("daily", env, { configPath: brokenFile });
    const warn1 = drainStderr();

    providers.resetFallbackWarning();
    const invalidFile = writeTmpConfig({ version: 1, endpoints: {}, models: {}, lanes: {} });
    const list2 = providers.providersForLane("daily", env, { configPath: invalidFile });
    const warn2 = drainStderr();

    const missingFile = path.join(TMP, "nope", "providers.json");
    const list3 = providers.providersForLane("daily", env, { configPath: missingFile });
    drainStderr();

    check("bad-config-fallback", [
      ["brokenJsonFallback", list.map((p) => p.name).join(",") === "opencode-go-deepseek,sensenova"],
      ["brokenJsonWarns", /FALLBACK_CHAIN/.test(warn1)],
      ["invalidSchemaFallback", list2.map((p) => p.name).join(",") === "opencode-go-deepseek,sensenova"],
      ["invalidSchemaWarns", /FALLBACK_CHAIN/.test(warn2)],
      ["missingFileFallback", list3.map((p) => p.name).join(",") === "opencode-go-deepseek,sensenova"],
      ["fallbackKeepsParams", list3.at(-1)?.extraBody?.thinking?.type === "disabled"],
      [
        "fallbackCatalogueLanes",
        providers
          .catalogue(env, { configPath: missingFile })
          .every((r) => r.lanes.join(",") === "daily,summary" && r.configured === true),
      ],
      ["warnOnce", providers.providersForLane("daily", env, { configPath: brokenFile }).length === 2 && drainStderr() === ""],
    ]);
  }

  // ------------------------------------------------------------ 4 写操作往返
  {
    const file = writeTmpConfig(realConfig());
    const before = readFileSync(file, "utf8");

    // add + 进 lane（纯函数）→ 落盘 → 读回
    let next = providers.addModel(JSON.parse(before), {
      slug: "nvidia-nemotron-lightning",
      endpoint: "nvidia",
      apiModel: "nvidia/nemotron-3.5-lightning-30b-a3b",
      params: { reasoningEffort: "none" },
      note: "P0 淘汰：low 3/3 超时、none 事实错配 + 格式不合规",
      lane: "daily",
      position: { where: "top" },
    });
    providers.writeConfig(next, file);
    const reloaded = providers.loadConfig(file);
    const added = reloaded.config?.models["nvidia-nemotron-lightning"];

    // lane add / move / remove
    let cfg = reloaded.config;
    cfg = providers.laneAdd(cfg, "summary", "nvidia-nemotron-lightning", { where: "before", ref: "sensenova" });
    providers.writeConfig(cfg, file);
    const summaryAfterAdd = providers.loadConfig(file).config.lanes.summary.order.join(",");
    cfg = providers.laneMove(cfg, "summary", "nvidia-nemotron-lightning", { where: "top" });
    providers.writeConfig(cfg, file);
    const summaryAfterMove = providers.loadConfig(file).config.lanes.summary.order.join(",");
    cfg = providers.laneRemove(cfg, "summary", "nvidia-nemotron-lightning");
    providers.writeConfig(cfg, file);
    const summaryAfterRemove = providers.loadConfig(file).config.lanes.summary.order.join(",");

    // set / enable / disable
    cfg = providers.setPath(cfg, "nvidia-nemotron-lightning", "params.reasoningEffort", "low");
    providers.writeConfig(cfg, file);
    const effort = providers.loadConfig(file).config.models["nvidia-nemotron-lightning"].params.reasoningEffort;
    cfg = providers.setPath(cfg, "daily", "budgetMs", "600000");
    providers.writeConfig(cfg, file);
    const budget = providers.loadConfig(file).config.lanes.daily.budgetMs;
    cfg = providers.setEnabled(cfg, "nvidia-nemotron-lightning", false);
    providers.writeConfig(cfg, file);
    const disabled = providers.loadConfig(file).config.models["nvidia-nemotron-lightning"].enabled;
    cfg = providers.setEnabled(cfg, "nvidia-nemotron-lightning", true);
    providers.writeConfig(cfg, file);
    const enabledAgain = providers.loadConfig(file).config.models["nvidia-nemotron-lightning"].enabled;

    // diff 有内容、无差异时为空
    const diff = providers.unifiedDiff(before, readFileSync(file, "utf8"));
    const noDiff = providers.unifiedDiff(before, before);

    // CLI：--dry-run 不落盘，--yes 才落盘（同一份临时副本）
    const cliFile = writeTmpConfig(realConfig());
    const cliBefore = readFileSync(cliFile, "utf8");
    const dry = spawnSync(
      process.execPath,
      [CLI, "set", "nvidia-minimax-flash", "params.reasoningEffort=none", "--dry-run", `--config=${cliFile}`],
      { encoding: "utf8" }
    );
    const afterDry = readFileSync(cliFile, "utf8");
    const wrote = spawnSync(
      process.execPath,
      [CLI, "set", "nvidia-minimax-flash", "params.reasoningEffort=none", "--yes", `--config=${cliFile}`],
      { encoding: "utf8" }
    );
    const afterYes = readFileSync(cliFile, "utf8");
    const cliEffort = providers.loadConfig(cliFile).config.models["nvidia-minimax-flash"].params.reasoningEffort;

    // 干跑（不带 --yes）也必须不落盘
    const cliFile2 = writeTmpConfig(realConfig());
    const cliBefore2 = readFileSync(cliFile2, "utf8");
    spawnSync(process.execPath, [CLI, "disable", "sensenova", `--config=${cliFile2}`], { encoding: "utf8" });
    const afterNoYes = readFileSync(cliFile2, "utf8");

    check("write-roundtrip", [
      ["added", added?.apiModel === "nvidia/nemotron-3.5-lightning-30b-a3b" && added?.params?.reasoningEffort === "none"],
      ["addedTopOfLane", reloaded.config.lanes.daily.order[0] === "nvidia-nemotron-lightning"],
      ["laneAddBefore", summaryAfterAdd === "opencode-go-deepseek,nvidia-nemotron-lightning,sensenova"],
      ["laneMoveTop", summaryAfterMove === "nvidia-nemotron-lightning,opencode-go-deepseek,sensenova"],
      ["laneRemove", summaryAfterRemove === "opencode-go-deepseek,sensenova"],
      ["setNested", effort === "low"],
      ["setNumber", budget === 600000],
      ["disableWritesFalse", disabled === false],
      ["enableRemovesFlag", enabledAgain === undefined],
      ["diffHasHunk", diff.includes("@@ -") && diff.includes("+++ b/config/providers.json")],
      ["diffEmptyWhenSame", noDiff === ""],
      ["cliDryRunNoWrite", dry.status === 0 && afterDry === cliBefore && dry.stdout.includes("未落盘")],
      ["cliYesWrites", /已写入/.test(wrote.stdout) && afterYes !== cliBefore && cliEffort === "none"],
      ["cliNoYesNoWrite", afterNoYes === cliBefore2],
    ]);
  }

  // ------------------------------------------------------------ 5 add 的探测门槛
  {
    const file = writeTmpConfig(realConfig());
    const before = readFileSync(file, "utf8");
    let ghCalls = 0;
    const ghImpl = {
      secretList: () => "",
      secretSet: () => {
        ghCalls += 1;
        return { status: 0 };
      },
    };
    const spec = {
      slug: "nvidia-rejected",
      endpoint: "nvidia",
      apiModel: "nvidia/nemotron-3.5-lightning-30b-a3b",
      params: { reasoningEffort: "none" },
      lane: "daily",
      position: { where: "top" },
    };
    const failed = await providers.addProvider(spec, {
      configPath: file,
      env: { NVIDIA_API_KEY: "nv-key" },
      yes: true,
      probeImpl: async () => ({ ok: false, runs: [{ ok: false, ms: 5, error: "格式不合规" }] }),
      ghImpl,
      pushSecret: true,
    });
    const afterFail = readFileSync(file, "utf8");

    // 探测通过 → 落盘；secret 只做干跑预览（gh 不调用）
    const passedProbe = await providers.addProvider(spec, {
      configPath: file,
      env: { NVIDIA_API_KEY: "nv-key" },
      yes: true,
      probeImpl: async () => ({ ok: true, runs: [{ ok: true, ms: 10 }, { ok: true, ms: 11 }, { ok: true, ms: 12 }] }),
      ghImpl,
      pushSecret: false,
    });
    const afterPass = readFileSync(file, "utf8");
    const secret = passedProbe.secret;
    const afterPassConfig = JSON.parse(afterPass);

    check("add-probe-gate", [
      ["failNotOk", failed.ok === false && failed.stage === "probe-failed"],
      ["failNoWrite", afterFail === before],
      ["failNoGh", ghCalls === 0],
      ["failMentions", failed.errors.join(" ").includes("不写配置")],
      ["passWrites", passedProbe.ok === true && passedProbe.wrote === true && afterPass !== before],
      ["passAddsModel", Boolean(afterPassConfig.models["nvidia-rejected"])],
      ["passLaneTop", afterPassConfig.lanes.daily.order[0] === "nvidia-rejected"],
      ["secretDryRun", secret?.dryRun === true && secret?.name === "NVIDIA_API_KEY"],
      ["secretNoPlaintext", !JSON.stringify(secret).includes("nv-key") && secret?.length === "nv-key".length],
      ["stillNoGh", ghCalls === 0],
    ]);
  }

  // ------------------------------------------------------------ 6 接线断言
  {
    const dir = path.join(TMP, "workflows");
    mkdirSync(dir, { recursive: true });
    const missing = path.join(dir, "missing.yml");
    writeFileSync(
      missing,
      [
        "jobs:",
        "  a:",
        "    steps:",
        "      - name: gen",
        "        run: node scripts/daily/index.mjs",
        "        env:",
        "          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}",
        "          # NVIDIA_API_KEY: ${{ secrets.NVIDIA_API_KEY }}   ← 注释不算数",
        "          SENSENOVA_API_KEY: ${{ secrets.SENSENOVA_API_KEY }}",
        "",
      ].join("\n"),
      "utf8"
    );
    const bad = providers.checkWorkflowWiring({ workflowDir: dir });
    const errText = bad.errors.join("\n");

    const okFile = path.join(TMP, "workflows-ok", "ok.yml");
    mkdirSync(path.dirname(okFile), { recursive: true });
    writeFileSync(
      okFile,
      [
        "jobs:",
        "  a:",
        "    steps:",
        "      - name: gen",
        "        run: node scripts/daily/index.mjs",
        "        env:",
        "          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}",
        "          SENSENOVA_API_KEY: ${{ secrets.SENSENOVA_API_KEY }}",
        "          NVIDIA_API_KEY: ${{ secrets.NVIDIA_API_KEY }}",
        "      - name: diag",
        "        run: node scripts/diagnose-providers.mjs",
        "        env:",
        "          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}",
        "          SENSENOVA_API_KEY: ${{ secrets.SENSENOVA_API_KEY }}",
        "          NVIDIA_API_KEY: ${{ secrets.NVIDIA_API_KEY }}",
        "",
      ].join("\n"),
      "utf8"
    );
    const good = providers.checkWorkflowWiring({ workflowDir: path.dirname(okFile) });

    // 规则覆盖面：只跑 daily 的 fixture 不该要求 opencode.yml 那种只有诊断的文件
    const onlyDiag = path.join(TMP, "only-diag");
    mkdirSync(onlyDiag, { recursive: true });
    writeFileSync(
      path.join(onlyDiag, "d.yml"),
      "steps:\n  - run: node scripts/diagnose-providers.mjs\n    env:\n      OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}\n      SENSENOVA_API_KEY: ${{ secrets.SENSENOVA_API_KEY }}\n",
      "utf8"
    );
    const diag = providers.checkWorkflowWiring({ workflowDir: onlyDiag });

    check("workflow-wiring", [
      ["missingReported", bad.ok === false && errText.includes("missing.yml")],
      ["missingNamesKey", errText.includes("secrets.NVIDIA_API_KEY")],
      ["missingHasStepHint", errText.includes("scripts/daily/index.mjs")],
      ["commentNotCounted", errText.includes("secrets.NVIDIA_API_KEY")],
      ["goodPasses", good.ok === true],
      ["checkedListsRules", good.checked?.some((c) => c.file.endsWith("ok.yml") && c.rules.includes("A"))],
      ["diagRuleMissing", diag.ok === false && diag.errors.join(" ").includes("secrets.NVIDIA_API_KEY")],
      ["stripComments", providers.stripYamlComments("# secrets.X\nreal # tail").includes("real # tail")],
    ]);
  }

  // ------------------------------------------------------------ 7 lane 预算
  {
    let requests = 0;
    const server = http.createServer(() => {
      requests += 1; // 故意不响应：挂在半路，靠 lane 预算收敛
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const legs = ["leg-one", "leg-two"].map((name) => ({
      name,
      endpoint: "mock",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "k",
      model: `${name}-model`,
      shape: "chat",
    }));
    const attempts = [];
    const small = await generateStructured({
      system: "s",
      user: "u",
      validate: () => ({ ok: false, reason: "x" }),
      providers: legs,
      budgetMs: 300,
      onProviderFailure: (a) => attempts.push(a),
    });
    const requestsSmall = requests;
    const attemptsSmall = [...attempts];

    // 预算 1.2s：第一条腿真的发一次请求（然后被 abort），第二条腿记合成 attempt
    requests = 0;
    attempts.length = 0;
    const started = Date.now();
    const partial = await generateStructured({
      system: "s",
      user: "u",
      validate: () => ({ ok: false, reason: "x" }),
      providers: legs,
      budgetMs: 1200,
      onProviderFailure: (a) => attempts.push(a),
    });
    const elapsed = Date.now() - started;
    const attemptsPartial = [...attempts];
    const requestsPartial = requests;
    server.close();

    check("lane-budget", [
      ["smallAllFail", small === null && requestsSmall === 0],
      ["smallSynthBoth", attemptsSmall.length === 2],
      ["smallReason", /未尝试（超出 lane 预算/.test(attemptsSmall[0]?.reason || "")],
      ["smallNames", attemptsSmall.map((a) => a.provider).join(",") === "leg-one,leg-two"],
      ["smallModels", attemptsSmall[0]?.model === "leg-one-model"],
      ["partialSpentOneRequest", requestsPartial === 1],
      ["partialOneRealOneSynth", attemptsPartial.length === 2],
      ["partialFirstIsNetwork", /网络异常/.test(attemptsPartial[0]?.reason || "")],
      ["partialSecondIsSynth", /超出 lane 预算/.test(attemptsPartial[1]?.reason || "")],
      ["partialAllFail", partial === null],
      ["boundedByBudget", elapsed < 6000],
    ]);
  }

  // ------------------------------------------------------------ 8 安全线
  {
    const configText = readFileSync(CONFIG_FILE, "utf8");
    const cliText = readFileSync(CLI, "utf8");
    const secretValue = "nvapi-SUPERSECRETVALUE0123456789";

    const listed = spawnSync(process.execPath, [CLI, "list", "--json"], {
      encoding: "utf8",
      env: { ...process.env, NVIDIA_API_KEY: secretValue, OPENCODE_API_KEY: "oc-secret-value", SENSENOVA_API_KEY: "sn-secret-value" },
    });
    const statusRows = providers.statusReport({
      env: { NVIDIA_API_KEY: secretValue },
      secretList: "NAME  UPDATED\nNVIDIA_API_KEY  2026-10-23\n",
    });
    const statusJson = JSON.stringify(statusRows.rows.map(({ apiKey, ...rest }) => rest));
    const secretPreview = providers.pushSecretValue({ name: "NVIDIA_API_KEY", value: secretValue, dryRun: true });

    check("security-lines", [
      ["noPlainKeyInConfig", !/(sk-[A-Za-z0-9]{8,}|nvapi-[A-Za-z0-9]{8,}|Bearer\s+\S+)/.test(configText)],
      ["configOnlyKeyEnv", JSON.stringify(realConfig().endpoints).includes("keyEnv")],
      ["ghNoBody", !cliText.includes('"--body"') && !cliText.includes("'--body'") && /input:\s*value/.test(cliText)],
      ["cliNoSecretInOutput", !listed.stdout.includes(secretValue) && !listed.stderr.includes(secretValue)],
      ["statusNoSecret", !statusJson.includes(secretValue)],
      ["statusReportsSecret", statusRows.rows[0]?.secretStatus === "present" && statusRows.rows[0]?.envSource === "NVIDIA_API_KEY"],
      ["secretPreviewHashed", !JSON.stringify(secretPreview).includes("SUPERSECRET") && secretPreview.sha.length === 8],
      ["noKeyValueInConfigNotes", !Object.values(realConfig().models).some((m) => /nvapi-|sk-/.test(String(m.note || "")))],
    ]);
  }

  // ------------------------------------------------------------ 9 内置帮助
  {
    const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    const global = runCli(["--help"]);
    const short = runCli(["-h"]);
    const noArgs = runCli([]);
    const addHelp = runCli(["add", "--help"]);
    const helpAdd = runCli(["help", "add"]);
    const unknown = runCli(["help", "nope"]);
    const commands = ["add", "probe", "status", "check", "list", "show", "lane", "set", "enable", "disable", "help"];

    check("cli-help", [
      ["globalOk", global.status === 0],
      ["listsAllCommands", commands.every((c) => global.stdout.includes(c))],
      ["shortFlagSame", short.status === 0 && short.stdout === global.stdout],
      ["noArgsSame", noArgs.status === 0 && noArgs.stdout === global.stdout],
      [
        "commandHelp",
        addHelp.status === 0 &&
          addHelp.stdout.includes("--api-model") &&
          addHelp.stdout.includes("--push-secret") &&
          addHelp.stdout.includes("不写配置"),
      ],
      ["helpSubcommandSame", helpAdd.status === 0 && helpAdd.stdout === addHelp.stdout],
      ["unknownFails", unknown.status === 1 && unknown.stderr.includes("未知命令")],
      ["helpWritesNothing", !addHelp.stdout.includes("已写入") && !global.stdout.includes("已写入")],
    ]);
  }
} finally {
  console.error = origError;
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed}/${total} cases passed`);
process.exit(passed === total ? 0 : 1);
