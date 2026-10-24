#!/usr/bin/env node
/**
 * scripts/lib/rules.mjs
 * ------------------------------------------------------------------
 * 三条产品线共用的**叙述口径**（零依赖 ESM，Node 20+；**零 import**）。
 *
 * 这里放的是「不是格式问题、而是事实口径」的规则：AI 正文里本人提交与自动提交
 * 必须是**相加**关系，不能写成包含关系。日报叙述、30 天总结、verify 都引用同一份
 * 正则，任何一处放宽都会让另两处漂移。
 *
 * 注意：本文件只做**判定**，不做**改写**；长度收敛的**算法**在 daily/lib/ai/prose.mjs，
 * 但「多长算超长」这种共享标尺在下面（两个消费者：日报叙述的校验、30 天总结的校验）。
 */

/** headline 硬上限（字符数）；超出按分隔符 / 词界截断。日报与总结共用同一把尺子。 */
export const HEADLINE_MAX_CHARS = 80;

/**
 * 「自动提交是相加项」的包含式误用检测 —— 日报叙述、30 天总结、verify 共用一份正则。
 *
 * 口径：`count`（本人提交）与 `automated`（机器人提交）互不相交，相加才等于总提交数。
 * 模型偶发写成包含关系（线上实证：zh 总结「368 次提交……其中提交数包含 336 次自动提交」，
 * en 同名句 "the commit figure includes 336 automated commits"；10-24 的日报 headline
 * 「三个仓库共 24 次提交，其中 13 次由 github-actions[bot] 自动提交」）。只拦「提交数紧邻
 * 其中/包含/包括…自动提交」这一族说法，不拦正常的中文「其中」（如「若干 issue 已关闭，其中…」）。
 * 反向的「自动提交不计入总数」是正确说法，故「计入」前必须不是「不」。
 *
 * 两处窗口刻意放宽 / 补齐（2026-10-24 修复）：
 *   · 中文连接词后的窗口 12 → 40：真实句子里中间要塞下「13 次由 github-actions[bot] 」共 27 字符，
 *     12 字符的窗口永远够不着。放宽后用 `另有|之外` 的负向前瞻兜住合规写法
 *     （「其中 1 个 issue 已关闭；另有 13 次自动提交」不许误伤）。
 *   · 英文补 `commits|total … with N automated`：`with 13 automated` 在英文里同样被读成
 *     of which，此前完全不在规则覆盖内。
 */
export const AUTOMATED_OVERLAP_RE = new RegExp(
  [
    String.raw`(?:其中|包含|包括)(?![^。\n]{0,40}(?:另有|之外))[^。\n]{0,40}(?:\d+\s*)?(?:次)?自动提交`,
    String.raw`自动提交[^。\n]{0,12}(?<!不)(?:计入|包含在|算在|并入|已包含)`,
    String.raw`\b(?:includes?|including|contains?|containing)\b[^.\n]{0,24}automated\s+commits?`,
    String.raw`\bautomated\s+commits?\b[^.\n]{0,24}(?:(?<!not )(?:included in|counted in)|part of)\b`,
    String.raw`\bcommits?\b[^.\n]{0,24}\bof which\b`,
    String.raw`\b(?:commits?|total)\b[^.\n]{0,40}\bwith\s+\d+\s+automated\b`,
  ].join("|"),
  "i"
);

/**
 * 旧的日报叙述能否安全沿用（`index.mjs` 的「AI 失败 + 数据未变」分支用）。
 *
 * 目的：让措辞规则对**已发布**的叙述也生效 —— 旧规则下写出的「其中…自动提交」
 * 不能因为这次 AI 全挂而被原样带回页面。headline / summary / 任一 releaseNotes
 * 命中包含式就返回 false，调用方宁可出失败卡也不沿用。
 *
 * headline 必须一起查：10-24 的线上事故就是「summary 写对了（另有）、headline 写错了（其中）」，
 * 当时这条闸门只查 summary，等于对 headline 完全放行。
 */
export function narrativeWordingOk(ai) {
  for (const lang of ["en", "zh"]) {
    const sec = (ai && ai[lang]) || {};
    if (AUTOMATED_OVERLAP_RE.test(String(sec.headline ?? ""))) return false;
    if (AUTOMATED_OVERLAP_RE.test(String(sec.summary ?? ""))) return false;
    const notes = Array.isArray(sec.releaseNotes) ? sec.releaseNotes : [];
    for (const note of notes) {
      if (AUTOMATED_OVERLAP_RE.test(String((note && note.summary) ?? ""))) return false;
    }
  }
  return true;
}
