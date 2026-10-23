#!/usr/bin/env node
/**
 * scripts/lib/domain.mjs
 * ------------------------------------------------------------------
 * 数据侧的领域判定（零依赖 ESM，Node 20+；**零 import**）。
 *
 * 为什么单独成文件：`hasVisibleActivity` 是「这一天有没有值得展示/叙述的活动」的口径，
 * 数据侧（scripts/daily/lib/days.mjs 生成归档列表）与表现层（日报页、.md 版）都要用。
 * 它原来住在 scripts/daily/render.mjs，于是 days.mjs 为了一个判定把整层渲染
 * （render + ai + providers）拖进了自己的传递闭包 —— 那是「数据 → 表现」的反向边。
 *
 * 判定口径：commits 要按「用户本人提交数」判定 —— 混合日会把只有机器人提交的仓库
 * 也放进 commits[]（count=0），单看数组长度会把「纯机器人跑了一天」误当成有活动；
 * 讨论 / 发布 / 标星 / 回复 / 他人状态变更同样算活动（与 data.empty 的 totals 口径不等价）。
 */

const A = (x) => (Array.isArray(x) ? x : []);

export function hasVisibleActivity(data) {
  const d = data && typeof data === 'object' ? data : {};
  // commits 要按「用户本人提交数」判定：混合日会把只有机器人提交的仓库也放进 commits[]（count=0），
  // 单看数组长度会把「纯机器人跑了一天」误当成有活动。
  const hasUserCommits = A(d.commits).some((c) => Number(c && c.count) > 0);
  return (
    hasUserCommits ||
    A(d.pullRequests).length > 0 ||
    A(d.reviews).length > 0 ||
    A(d.issues).length > 0 ||
    A(d.stateChanges).length > 0 ||
    A(d.discussions).length > 0 ||
    A(d.releases).length > 0 ||
    A(d.stars).length > 0 ||
    A(d.replies).length > 0
  );
}
