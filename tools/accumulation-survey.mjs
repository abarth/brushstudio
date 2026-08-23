#!/usr/bin/env node
/**
 * accumulation-survey — can any Photoshop dual-brush mode make a gated
 * stroke's tone independent of how many mask stamps land on a pixel?
 *
 *   node tools/accumulation-survey.mjs
 *
 * The question is worth a tool because the answer is counter-intuitive and
 * keeps coming back (docs/fractal-texture-math.md §6). A tonal mask's value
 * curve assumes a fixed overlap count `n`; where `n` wanders, the tone
 * wanders with it and the mark splotches at stamp scale. The obvious escape
 * is a mean-preserving accumulation function — one where a dab's net
 * contribution leaves the train's average alone.
 *
 * There isn't one, and this prints why, from the engine's own blend code
 * rather than a transliteration of it:
 *
 * - the mask buffer accumulates with `over`, which is not a choosable
 *   function — the Mode list applies the FINISHED mask to the stroke, once,
 *   at merge (`applyDualToAlpha`);
 * - at that one application, with a solid stroke interior, every mode that
 *   can carve tone reduces to `tone = v` (Height to `1 − 1.5(1 − v)`), and
 *   the rest are constant — they cannot darken a saturated stroke at all;
 * - so tone is `f(1 − (1−v)^n)` for a fixed monotone `f`: strictly
 *   increasing in `n` unless `v` is 0 or 1.
 *
 * Exact count-invariance therefore needs a channel applied ONCE per pixel —
 * the Texture panel with Texture Each Tip off — at the cost of canvas
 * anchoring. Within the dual gate, scatter is bought with overlap instead
 * (§6's scatter budget).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const CACHE = join(ROOT, 'node_modules', '.brushstudio');
const OUT = join(CACHE, 'blend-survey.mjs');
mkdirSync(CACHE, { recursive: true });
if (!existsSync(OUT) || process.env.FORCE_BUILD) {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [join(ROOT, 'src/engine/cpu/blend.ts')],
    outfile: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
  });
}
const { applyDualToAlpha } = await import(pathToFileURL(OUT).href);
const { TEXTURE_BLEND_INDEX } = await (async () => {
  const out = join(CACHE, 'types-survey.mjs');
  const { build } = await import('esbuild');
  await build({
    entryPoints: [join(ROOT, 'src/brush/types.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
  });
  return import(pathToFileURL(out).href);
})();

/** The mask buffer after `n` over-composited stamps each carrying `v`. */
const accumulate = (v, n) => 1 - Math.pow(1 - v, n);

const NBAR = 3.5;
const NLO = 2;
const NHI = 6;
const COV = 1; // a gated family paints a solid primary; this is its interior

const rows = [];
for (const [mode, idx] of Object.entries(TEXTURE_BLEND_INDEX)) {
  const tone = (v, n) => applyDualToAlpha(COV, accumulate(v, n), idx);
  // how many distinct tones the mode can even produce at the design count
  const distinct = new Set();
  let worst = 0;
  for (let v = 0.02; v < 1; v += 0.02) {
    distinct.add(tone(v, NBAR).toFixed(3));
    worst = Math.max(worst, Math.abs(tone(v, NHI) - tone(v, NLO)));
  }
  // solve for the mask value that lands mid-tone at the design count
  let v = NaN;
  if ((tone(0, NBAR) - 0.5) * (tone(1, NBAR) - 0.5) <= 0) {
    let lo = 0;
    let hi = 1;
    const rising = tone(1, NBAR) > tone(0, NBAR);
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (tone(mid, NBAR) < 0.5 === rising) lo = mid;
      else hi = mid;
    }
    v = (lo + hi) / 2;
  }
  const carries = distinct.size > 1;
  rows.push({
    mode,
    'carries tone': carries ? 'yes' : 'no — constant on a solid stroke',
    'v for mid-tone': carries && Number.isFinite(v) ? v.toFixed(3) : '—',
    [`tone n=${NLO}`]: carries ? tone(v, NLO).toFixed(3) : '—',
    [`n=${NBAR}`]: carries ? tone(v, NBAR).toFixed(3) : '—',
    [`n=${NHI}`]: carries ? tone(v, NHI).toFixed(3) : '—',
    'worst drift': carries ? worst.toFixed(3) : '0.000',
  });
}

console.log(
  `Dual gate on a solid stroke (cov=${COV}); mask value v over-composited n times.\n` +
    `"worst drift" is max |tone(n=${NHI}) − tone(n=${NLO})| over v — the splotch, in tone.\n`,
);
console.table(rows);
const carriers = rows.filter((r) => r['carries tone'] === 'yes');
console.log(
  `${carriers.length} of ${rows.length} modes can carve tone; every one of them drifts ` +
    `${Math.min(...carriers.map((r) => +r['worst drift'])).toFixed(2)}–` +
    `${Math.max(...carriers.map((r) => +r['worst drift'])).toFixed(2)} in tone as n goes ${NLO}→${NHI}.`,
);
console.log('No mode is both tone-carrying and count-invariant — see docs/fractal-texture-math.md §6.');
