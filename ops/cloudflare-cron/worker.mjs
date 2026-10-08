/**
 * sogeisetsu 日报 watchdog（Cloudflare Worker + Cron Trigger）
 * ------------------------------------------------------------------
 * 为什么需要它：GitHub Actions 的 `schedule` 是 best-effort 投递，实测本仓
 * 单日 12 个时点只中 3~4 个，且丢掉的时点不会产生任何 failed run、没有任何通知。
 * 这个 Worker 每 10 分钟看一眼「最近该跑的那个时点到底有没有跑」，没有就补一次
 * workflow_dispatch —— GitHub 健康时它什么都不做，不产生重复 run。
 *
 * 需要的 secret：
 *   GITHUB_TOKEN  fine-grained PAT，仅 sogeisetsu/sogeisetsu 一个仓库，
 *                 Repository permissions → Actions: Read and write
 *
 * 配置（Cloudflare 侧）：
 *   Cron Trigger：每 10 分钟（表达式见 README，注意别在注释里写它，`星号+斜杠` 会提前闭合块注释）
 *
 * 日志：Cloudflare Dashboard → 该 Worker → Settings → Trigger Events → View events
 *       （console.log / console.error 都会出现在这里，最近 100 次）
 */

const OWNER = "sogeisetsu";
const REPO = "sogeisetsu";
const WORKFLOW_FILE = "update-daily-report.yml"; // dispatch 端点接受文件名或数字 ID
const REF = "main";

// 与 .github/workflows/update-daily-report.yml 的 cron 对齐：UTC 每 2 小时的 :17
const SLOT_MINUTE = 17;
const SLOT_HOUR_STEP = 2;

// 宽限期：GitHub 自己的 schedule 有延迟（本仓实测 +1 ~ +47 分钟），
// 早于 slot + GRACE 就补，会在它稍后到达时变成两个 run。
// 重复 run 不花钱也不重复调 AI（index.mjs 有 dataHash 跳过），但会多占一个 runner 分钟。
// 想少重复就调大 GRACE，想让页面更快追上就调小。
const GRACE_MINUTES = 30;

const API = "https://api.github.com";
const UA = "sogeisetsu-daily-watchdog";
const MINUTE_MS = 60 * 1000;

/** 最近的、属于调度表的时点（ms，UTC）。 */
function lastDueSlot(nowMs) {
  const d = new Date(nowMs);
  let ms = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    SLOT_MINUTE,
    0,
    0
  );
  if (ms > nowMs) ms -= 60 * MINUTE_MS; // 本小时时点还没到 → 退到上一个小时
  while (new Date(ms).getUTCHours() % SLOT_HOUR_STEP !== 0) ms -= 60 * MINUTE_MS;
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

async function checkAndFill(token, nowMs) {
  const slot = lastDueSlot(nowMs);
  const ageMin = Math.round((nowMs - slot) / MINUTE_MS);

  if (nowMs - slot < GRACE_MINUTES * MINUTE_MS) {
    console.log(`时点 ${new Date(slot).toISOString()} 才过 ${ageMin} 分钟，未到宽限期，跳过`);
    return { action: "skip-grace", slot };
  }

  // 该时点之后（留 60 秒时钟余量）有没有任何 run？有就说明这一趟不用补。
  const since = new Date(slot - MINUTE_MS).toISOString();
  const listPath =
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs` +
    `?per_page=20&created=${encodeURIComponent(`>=${since}`)}`;
  const res = await ghFetch(listPath, token);
  if (!res.ok) {
    console.error(`查询 runs 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { action: "error-list", slot, status: res.status };
  }
  const body = await res.json();
  const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  if (runs.length > 0) {
    const head = runs[0];
    console.log(
      `时点 ${new Date(slot).toISOString()} 已有 ${runs.length} 个 run，跳过` +
        `（最新 ${head.event}/${head.status}/${head.conclusion ?? "-"} @ ${head.created_at}）`
    );
    return { action: "skip-exists", slot, runs: runs.length };
  }

  const postRes = await ghFetch(
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: REF }),
    }
  );
  if (postRes.status === 204) {
    console.log(`时点 ${new Date(slot).toISOString()} 没有 run，已补一次 workflow_dispatch`);
    return { action: "dispatched", slot };
  }
  console.error(`dispatch 失败 HTTP ${postRes.status}: ${(await postRes.text()).slice(0, 300)}`);
  return { action: "error-dispatch", slot, status: postRes.status };
}

export default {
  async scheduled(controller, env, ctx) {
    const token = env.GITHUB_TOKEN;
    if (!token) {
      console.error("缺少 GITHUB_TOKEN secret，无法补触发");
      return;
    }
    const nowMs = controller?.scheduledTime ?? Date.now();
    console.log(`tick @ ${new Date(nowMs).toISOString()}`);
    await checkAndFill(token, nowMs);
  },

  // 只是个占位：这个 Worker 不需要被 HTTP 访问。
  // 想手动跑一次 scheduled handler，可以访问 /cdn-cgi/handler/scheduled。
  async fetch() {
    return new Response("sogeisetsu daily-report watchdog: scheduled-only\n", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
