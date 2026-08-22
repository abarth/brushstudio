#!/usr/bin/env node
/**
 * Do the two renderers paint the same mark?
 *
 * The CPU renderer is a transliteration of the WGSL shaders, and a
 * transliteration drifts unless something keeps checking. This paints the
 * same strokes with both, inside one browser page so neither has an excuse,
 * and reports how far apart the pixels ended up.
 *
 * They are not expected to be identical. Both accumulate into 8-bit buffers,
 * but WGSL works in f32 where JavaScript works in f64, and a couple of
 * hundred overlapping dabs let a half-a-level rounding difference show up as
 * a level or two. What matters is that the difference stays at that scale
 * and does not depend on the brush.
 *
 *   npm run test:parity
 */
import { openHarness } from '../tools/lib/page.mjs';

const verbose = process.argv.includes('--verbose');
const { page, close } = await openHarness({ verbose });

const CASES = [
  { name: 'soft round', settings: { tip: { size: 40, spacing: 0.12, hardness: 0 } } },
  { name: 'hard round', settings: { tip: { size: 40, spacing: 0.1, hardness: 1 } } },
  { name: 'tiny round', settings: { tip: { size: 6, spacing: 0.2 } } },
  {
    name: 'sampled tip, rotated',
    settings: { tip: { shape: 'chalk', size: 90, spacing: 0.08, angle: -20, roundness: 0.85 } },
  },
  {
    name: 'shape dynamics + scatter',
    settings: {
      tip: { shape: 'spatter', size: 50, spacing: 0.3 },
      shape: { enabled: true, sizeJitter: 0.5, angleJitter: 1, minDiameter: 0.2 },
      scatter: { enabled: true, scatter: 2, bothAxes: true, count: 3, countJitter: 0.3 },
    },
  },
  {
    name: 'whole-stroke texture',
    settings: {
      tip: { size: 80, spacing: 0.08 },
      texture: { enabled: true, pattern: 'canvas', depth: 0.6, scale: 0.8, contrast: 0.2 },
    },
  },
  {
    name: 'texture each tip',
    settings: {
      tip: { size: 80, spacing: 0.08 },
      texture: { enabled: true, pattern: 'paper', depth: 0.5, textureEachTip: true },
    },
  },
  {
    name: 'dual brush',
    settings: {
      tip: { shape: 'bristle-chisel', size: 120, spacing: 0.07, roundness: 0.55 },
      dual: { enabled: true, shape: 'fiber-drag', size: 130, spacing: 0.2, scatter: 0.75 },
    },
  },
  {
    name: 'wet edges + low flow',
    settings: { tip: { size: 60, spacing: 0.05 }, flow: 0.15, wetEdges: true },
  },
  {
    name: 'multiply blend at 60%',
    settings: { tip: { size: 50, spacing: 0.1 }, blendMode: 'multiply', opacity: 0.6 },
  },
];

const rows = await page.evaluate(async (cases) => {
  const BS = window.__brushstudio;
  const W = 900;
  const H = 320;

  const path = () => {
    const pts = [];
    for (let t = 0; t <= 1.0001; t += 0.004) {
      pts.push({
        x: 80 + t * (W - 160),
        y: H / 2 + Math.sin(t * Math.PI * 2) * 60,
        pressure: 0.35 + 0.6 * Math.sin(t * Math.PI),
        tiltX: 0,
        tiltY: 0,
        twist: 0,
      });
    }
    return pts;
  };

  const render = async (settings, backend) => {
    const surface = await BS.Surface.create(W, H, BS.backendFactory(backend));
    surface.fill([0.95, 0.94, 0.9, 1]);
    surface.paint(BS.makeBrush(settings), path(), { seed: 4 });
    const rgba = await surface.readAlpha.call(surface);
    const full = await surface.read();
    surface.destroy();
    return { alpha: Array.from(rgba), rgb: Array.from(full) };
  };

  const out = [];
  for (const c of cases) {
    const cpu = await render(c.settings, 'cpu');
    const gpu = await render(c.settings, 'gpu');
    let sum = 0;
    let max = 0;
    let big = 0;
    let samples = 0;
    let cpuInk = 0;
    let gpuInk = 0;
    for (let i = 0; i < cpu.rgb.length; i += 4) {
      // compare the painted colour, which carries every stage of the pipeline
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs(cpu.rgb[i + ch] - gpu.rgb[i + ch]);
        sum += d;
        if (d > max) max = d;
        if (d > 8) big++;
        samples++;
      }
      cpuInk += cpu.rgb[i];
      gpuInk += gpu.rgb[i];
    }
    out.push({
      name: c.name,
      meanDelta: sum / samples,
      maxDelta: max,
      bigFraction: big / samples,
      inkRatio: gpuInk > 0 ? cpuInk / gpuInk : 1,
    });
  }
  return out;
}, CASES);

await close();

/*
 * Tolerances.
 *
 * `max Δ` is deliberately not one of them. The two rasterisers decide
 * differently about pixels whose centre falls on the very edge of a dab —
 * the GPU snaps the quad to a subpixel grid in f32, this one inverts the
 * transform in f64 — so a hard-edged tip can disagree completely on a
 * handful of boundary pixels while agreeing everywhere else. What would
 * signal a real divergence is a difference that is *widespread*: a blend
 * mode transcribed wrong moves the whole mark, not its rim. So the limits
 * are on the mean, on how many pixels differ appreciably at all, and on the
 * total ink, which is what every measurement is built from.
 */
const MEAN_LIMIT = 0.5; // levels, out of 255
const BIG_LIMIT = 0.01; // fraction of samples differing by more than 8 levels
const INK_LIMIT = 0.02;

let failed = 0;
console.log('  case                          mean Δ   max Δ   >8 levels   ink ratio');
for (const r of rows) {
  const bad =
    r.meanDelta > MEAN_LIMIT ||
    r.bigFraction > BIG_LIMIT ||
    Math.abs(r.inkRatio - 1) > INK_LIMIT;
  if (bad) failed++;
  console.log(
    `  ${bad ? 'FAIL' : 'ok  '} ${r.name.padEnd(24)} ${r.meanDelta.toFixed(3).padStart(7)} ` +
      `${String(r.maxDelta).padStart(7)} ${(r.bigFraction * 100).toFixed(3).padStart(10)}% ` +
      `${r.inkRatio.toFixed(4).padStart(11)}`,
  );
}
console.log(
  `\n${rows.length - failed}/${rows.length} within tolerance ` +
    `(mean <= ${MEAN_LIMIT}, under ${BIG_LIMIT * 100}% of samples off by >8, ` +
    `ink within ${INK_LIMIT * 100}%)`,
);
process.exit(failed ? 1 : 0);
