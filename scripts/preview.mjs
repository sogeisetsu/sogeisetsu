/**
 * preview.mjs — render the fixtures to standalone SVG files for eyeballing /
 * browser screenshots.
 *
 *   node scripts/preview.mjs
 *
 * Writes:
 *   fixtures/real.json   → scripts/preview-real.svg    (真实数据，来自 --dump-data)
 *   fixtures/sample.json → scripts/preview-normal.svg  (常规形态，分布均匀)
 *   fixtures/empty.json  → scripts/preview-empty.svg   (空态)
 *
 * A missing fixture is reported and skipped instead of crashing the run, so the
 * script stays usable in a checkout that only ships some of them.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderActivityCard } from './render-svg.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

const jobs = [
  { src: 'real.json', out: 'preview-real.svg' },
  { src: 'sample.json', out: 'preview-normal.svg' },
  { src: 'empty.json', out: 'preview-empty.svg' },
];

let wrote = 0;
let skipped = 0;

for (const job of jobs) {
  const from = join(fixturesDir, job.src);
  if (!existsSync(from)) {
    console.log(`skip  ${job.src} (fixture not found)`);
    skipped += 1;
    continue;
  }
  const data = JSON.parse(readFileSync(from, 'utf8'));
  const svg = renderActivityCard(data);
  writeFileSync(join(here, job.out), svg, 'utf8');
  console.log(`wrote ${job.out}  <- ${job.src}  (${Buffer.byteLength(svg, 'utf8')} bytes)`);
  wrote += 1;
}

console.log(`done: ${wrote} written, ${skipped} skipped`);
