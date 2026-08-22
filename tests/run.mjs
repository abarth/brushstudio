#!/usr/bin/env node
/**
 * The check that the harness still tells the truth.
 *
 * Cases live in cases.mjs and are run against a real renderer — a stub would
 * only ever agree with whatever the test expected. By default that is the
 * CPU renderer, which needs nothing but this process; `--backend gpu` runs
 * the same cases through WebGPU in headless Chromium.
 *
 *   npm test
 *   npm test -- --backend gpu
 */
import { runCases } from './cases.mjs';
import { checkPanel } from './panel.mjs';
import { loadCpuHarness } from '../tools/lib/harness.mjs';
import { openHarness } from '../tools/lib/page.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--backend');
const backend = at < 0 ? 'cpu' : argv[at + 1];
const verbose = argv.includes('--verbose');

let results;
if (backend === 'gpu') {
  const { page, close } = await openHarness({ verbose });
  try {
    results = await page.evaluate(
      async ([source, backend]) => {
        const fn = new Function(`return ${source}`)();
        return fn(window.__brushstudio, backend);
      },
      [runCases.toString(), backend],
    );
  } finally {
    await close();
  }
} else if (backend === 'cpu') {
  results = await runCases(await loadCpuHarness(), 'cpu');
} else {
  console.error(`unknown backend "${backend}" — expected cpu or gpu`);
  process.exit(1);
}

// the try-out app's coverage of the engine — the same answer either way, so
// it rides along with whichever backend was asked for
results.push(...(await checkPanel()));

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok   ${r.name}`);
  } else {
    failed++;
    console.log(`  FAIL ${r.name}\n       ${r.detail}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed  (${backend} renderer)`);
process.exit(failed ? 1 : 0);
