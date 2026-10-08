/**
 * sogeisetsu 定时任务 watchdog（Cloudflare Worker + Cron Trigger）
 * ------------------------------------------------------------------
 * 兜的是两个 workflow，它们的时间表**不一样**，必须各算各的、不能互相顶替：
 *
 *   [daily]    update-daily-report.yml   分钟 17，小时步长 2  → 日报（AI 生成，时间敏感）
 *   [activity] update-activity.yml       分钟 30，小时步长 2  → 近 30 天活动卡片（无 AI，滚动窗口）
 *
 * cron 表达式不写进这个块注释：`星号 + 斜杠` 会提前把它闭合。见 README。
 *
 * 为什么需要它：GitHub Actions 的 `schedule` 是 best-effort 投递，实测本仓单日 12 个
 * 时点只中 3~4 个，且丢掉的时点不会产生任何 failed run、没有任何通知。这个 Worker 每
 * 10 分钟对每个 target 分别看一眼「它最近那个该跑的时点到底有没有跑」，没有就补一次
 * workflow_dispatch —— GitHub 健康时它什么都不做，不产生重复 run。
 *
 * 需要的 secret：
 *   GITHUB_TOKEN  fine-grained PAT，仅 sogeisetsu/sogeisetsu 一个仓库，
 *                 Repository permissions → Actions: Read and write
 *                 （两个 workflow 在同一个仓，权限不需要改）
 *
 * 日志：Cloudflare Dashboard → 该 Worker → Settings → Trigger Events → View events
 *       （console.log / console.error 都会出现在这里，最近 100 次）
 *
 * 失败可见性：任何 API 调用失败都不吞错，打完日志直接抛异常 —— 这次 invocation 会被
 *       Cloudflare 记为失败，dashboard 的 Invocations 成功率会掉，等于自带告警；
 *       避免出现「成功率 100% 但每次都在 401」这种只有翻日志才看得见的状态。
 *       两个 target 互不影响：一个失败另一个照常判断，但只要有一个失败，这次
 *       invocation 仍记为失败。
 */

const OWNER = "sogeisetsu";
const REPO = "sogeisetsu";
const REF = "main"; // dispatch 端点接受文件名或数字 ID

/**
 * 每个 target 一份自己的时间表 —— 两个 workflow 的 cron 不同，共用一个 slot 会错位。
 * slotMinute / hourStep 必须与各自 workflow 里的 cron 对齐；
 * graceMinutes 是宽限期：GitHub 自己的 schedule 会迟到（本仓实测 +1 ~ +47 分钟），
 * 早于 slot + grace 就补，会在它稍后到达时变成两个 run。重复 run 不花钱也不重复调 AI
 * （index.mjs 有 dataHash 跳过；活动卡片重跑无 diff 也不会 commit），只是多占一个
 * runner 分钟。想少重复就调大 grace，想让页面更快追上就调小。
 */
const TARGETS = [
  {
    label: "daily",
    workflow: "update-daily-report.yml",
    slotMinute: 17,
    hourStep: 2,
    graceMinutes: 30,
  },
  {
    label: "activity",
    workflow: "update-activity.yml",
    slotMinute: 30,
    hourStep: 2,
    graceMinutes: 30,
  },
];

const API = "https://api.github.com";
const UA = "sogeisetsu-daily-watchdog";
const MINUTE_MS = 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

/** 最近的、属于该 target 调度表的时点（ms，UTC）。 */
function lastDueSlot(nowMs, { slotMinute, hourStep }) {
  const d = new Date(nowMs);
  let ms = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    slotMinute,
    0,
    0
  );
  if (ms > nowMs) ms -= 60 * MINUTE_MS; // 本小时时点还没到 → 退到上一个小时
  while (new Date(ms).getUTCHours() % hourStep !== 0) ms -= 60 * MINUTE_MS;
  return ms;
}

function ghFetch(path, token, init = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": UA,
      ...(init.headers || {}),
    },
  });
}

async function checkAndFill(token, nowMs, target) {
  const { label, workflow, graceMinutes } = target;
  const tag = `[${label}] ${workflow}`;
  const slot = lastDueSlot(nowMs, target);
  const ageMin = Math.round((nowMs - slot) / MINUTE_MS);

  if (nowMs - slot < graceMinutes * MINUTE_MS) {
    console.log(
      `${tag} 时点 ${iso(slot)} 才过 ${ageMin} 分钟，未到宽限期(${graceMinutes}min)，跳过`
    );
    return { label, action: "skip-grace", slot };
  }

  // 该时点之后（留 60 秒时钟余量）有没有任何 run？有就说明这一趟不用补。
  const since = iso(slot - MINUTE_MS);
  const listPath =
    `/repos/${OWNER}/${REPO}/actions/workflows/${workflow}/runs` +
    `?per_page=20&created=${encodeURIComponent(`>=${since}`)}`;
  const res = await ghFetch(listPath, token);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error(`${tag} 查询 runs 失败 HTTP ${res.status}: ${detail}`);
    // 不吞错：抛出去让 Cloudflare 把这次 invocation 记成失败（Invocations 成功率会掉），
    // 这样即使没人看日志，dashboard 上也能一眼看出问题。
    throw new Error(`${label}: 查询 runs 失败 HTTP ${res.status}: ${detail}`);
  }
  const body = await res.json();
  const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  if (runs.length > 0) {
    const head = runs[0];
    console.log(
      `${tag} 时点 ${iso(slot)} 已有 ${runs.length} 个 run，跳过` +
        `（最新 ${head.event}/${head.status}/${head.conclusion ?? "-"} @ ${head.created_at}）`
    );
    return { label, action: "skip-exists", slot, runs: runs.length };
  }

  const postRes = await ghFetch(
    `/repos/${OWNER}/${REPO}/actions/workflows/${workflow}/dispatches`,
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: REF }),
    }
  );
  if (postRes.status === 204) {
    console.log(`${tag} 时点 ${iso(slot)} 没有 run，已补一次 workflow_dispatch`);
    return { label, action: "dispatched", slot };
  }
  const detail = (await postRes.text()).slice(0, 300);
  console.error(`${tag} dispatch 失败 HTTP ${postRes.status}: ${detail}`);
  throw new Error(`${label}: dispatch 失败 HTTP ${postRes.status}: ${detail}`);
}

export default {
  async scheduled(controller, env, ctx) {
    // trim() 兼作防御：secret 若被带 BOM / 首尾空白的管道写进来（Windows 下很常见），
    // 原样拼进 Authorization 头会变成非 ASCII，GitHub 直接 401 Bad credentials。
    // JS 的 trim 会把 U+FEFF 一起去掉。
    const token = String(env.GITHUB_TOKEN ?? "").trim();
    if (!token) {
      console.error("缺少 GITHUB_TOKEN secret，无法补触发");
      throw new Error("缺少 GITHUB_TOKEN secret");
    }
    const nowMs = controller?.scheduledTime ?? Date.now();
    console.log(`tick @ ${iso(nowMs)}`);

    // 两个 target 并发跑（各 1 次列表查询，需要时才多 1 次 dispatch），互不阻塞；
    // 但只要有一个失败，这次 invocation 就记为失败 → 成功率掉下来。
    const results = await Promise.allSettled(
      TARGETS.map((t) => checkAndFill(token, nowMs, t))
    );
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      throw new Error(
        `${failed.length}/${TARGETS.length} 个 target 失败: ` +
          failed.map((f) => f.reason?.message ?? String(f.reason)).join(" | ")
      );
    }
  },

  // 只是个占位：这个 Worker 只需要 cron，不需要对外 URL。
  // （wrangler.toml 里 workers_dev = false，所以 /cdn-cgi/handler/scheduled 也访问不到；
  //  想手动跑一次 scheduled，用 Dashboard 或临时打开 workers.dev。）
  async fetch() {
    return new Response("sogeisetsu daily-report watchdog: scheduled-only\n", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
