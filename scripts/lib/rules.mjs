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
 * 注意：本文件只做**判定**，不做**改写**；长度收敛等文本标尺在 daily/lib/ai/prose.mjs。
 */

/**
 * 「自动提交是相加项」的包含式误用检测 —— 日报叙述、30 天总结、verify 共用一份正则。
 *
 * 口径：`count`（本人提交）与 `automated`（机器人提交）互不相交，相加才等于总提交数。
 * 模型偶发写成包含关系（线上实证：zh 总结「368 次提交……其中提交数包含 336 次自动提交」，
 * en 同名句 "the commit figure includes 336 automated commits"）。只拦「提交数紧邻
 * 其中/包含/包括…自动提交」这一族说法，不拦正常的中文「其中」（如「若干 issue 已关闭，其中…」）。
 * 反向的「自动提交不计入总数」是正确说法，故「计入」前必须不是「不」。
 */
export const AUTOMATED_OVERLAP_RE = new RegExp(
  [
    String.raw`(?:其中|包含|包括)[^。\n]{0,12}(?:\d+\s*)?(?:次)?自动提交`,
    String.raw`自动提交[^。\n]{0,12}(?<!不)(?:计入|包含在|算在|并入|已包含)`,
    String.raw`\b(?:includes?|including|contains?|containing)\b[^.\n]{0,24}automated\s+commits?`,
    String.raw`\bautomated\s+commits?\b[^.\n]{0,24}(?:(?<!not )(?:included in|counted in)|part of)\b`,
    String.raw`\bcommits?\b[^.\n]{0,24}\bof which\b`,
  ].join("|"),
  "i"
);

/**
 * 旧的日报叙述能否安全沿用（`index.mjs` 的「AI 失败 + 数据未变」分支用）。
 *
 * 目的：让措辞规则对**已发布**的叙述也生效 —— 旧规则下写出的「其中…自动提交」
 * 不能因为这次 AI 全挂而被原样带回页面。summary 或任一 releaseNotes 命中包含式
 * 就返回 false，调用方宁可出失败卡也不沿用。
 */
export function narrativeWordingOk(ai) {
  for (const lang of ["en", "zh"]) {
    const sec = (ai && ai[lang]) || {};
    if (AUTOMATED_OVERLAP_RE.test(String(sec.summary ?? ""))) return false;
    const notes = Array.isArray(sec.releaseNotes) ? sec.releaseNotes : [];
    for (const note of notes) {
      if (AUTOMATED_OVERLAP_RE.test(String((note && note.summary) ?? ""))) return false;
    }
  }
  return true;
}
