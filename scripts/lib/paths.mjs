#!/usr/bin/env node
/**
 * scripts/lib/paths.mjs
 * ------------------------------------------------------------------
 * 仓库根目录的**唯一**来源（零依赖 ESM，Node 20+；只 import node:path / node:url）。
 *
 * 为什么单独成文件：`ROOT` 原来在 9 个文件里各算一遍（days / lib/providers / github ×2 /
 * generate-activity / verify / check / test-providers / test-attribution / preview），
 * 每处都是一串 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", …)`。
 * 文件一旦搬家，那串相对层级就静默指向别处（github.mjs 的 loadDataFile() 就是现存例子）。
 *
 * 也不许让 days.mjs 兼任「ROOT 的提供者」：providers 需要 ROOT，而 providers 又在
 * days 的传递闭包里 —— 让 days 提供 ROOT 只会把 `providers → days → render → ai → providers`
 * 绕成环。零依赖的 paths.mjs 是唯一不成环的落点。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（scripts/lib/ → 上两级）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** scripts/ 根目录（递归扫描语法、边界测试从它起步）。 */
export const SCRIPTS_DIR = path.join(ROOT, "scripts");
