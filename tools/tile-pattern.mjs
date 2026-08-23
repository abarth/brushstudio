#!/usr/bin/env node
/**
 * tile-pattern — synthesize a seamless texture pattern whose repeat cannot
 * be seen, and say by how much.
 *
 *   node tools/tile-pattern.mjs patterns/paper-tooth.spec.json
 *
 * A texture pattern is a bitmap and a bitmap tiles, so a canvas-registered
 * texture repeats every `native x scale` px no matter what is in it. That is
 * not the complaint people actually have. What they see is a *motif* coming
 * back — a blotch they recognise, landing on a grid — and recognition needs
 * a shape, which needs energy at a scale the eye can hold. Fine grain has no
 * shape: one patch of 3px tooth is indistinguishable from the next, so the
 * field can repeat every hundred pixels and read as unbroken paper.
 *
 * So this synthesizes the pattern in the frequency domain with a hard floor
 * under the band: no energy at all below `band.loPx` canvas pixels, which
 * puts an exact zero on every tile-lattice line coarse enough to recognise.
 * The FFT grid is periodic by construction, so the result is seamless with
 * no blending or mirroring — the two properties come from the same place.
 *
 * The cost is real and worth stating: paper's own cloudiness IS low-frequency
 * content, so a pattern that cannot repeat visibly also cannot be cloudy.
 * Large-scale variation has to come from somewhere that does not tile, which
 * in a drawing is the hand — pressure, overlap, where the strokes went.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { encodeGrayPng, fft2d, gaussians, mulberry32, patternTile } from './lib/dsp.mjs';

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node tools/tile-pattern.mjs <spec.json>');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const outDir = resolve(dirname(resolve(specPath)), spec.outDir ?? '.');
mkdirSync(outDir, { recursive: true });

const N = spec.native;
if (N & (N - 1)) {
  console.error(`native ${N} is not a power of two`);
  process.exit(1);
}
const scale = spec.scale;
const periodPx = N * scale;

// --- the band, stated in canvas pixels at the intended scale ----------------
const { loPx, hiPx, beta = 0.8, shoulderOctaves = 0.4 } = spec.band;
const kLo = periodPx / loPx; // cycles per tile
const kHi = periodPx / hiPx;
const smoothstep = (a, b, x) => {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Amplitude at k cycles/tile: a power law inside the band, zero outside it. */
function amplitude(k) {
  if (k <= kLo || k >= kHi) return 0;
  const shoulder = 2 ** shoulderOctaves;
  const gate = smoothstep(kLo, kLo * shoulder, k) * (1 - smoothstep(kHi / shoulder, kHi, k));
  return gate * k ** (-beta / 2);
}

// --- white noise, shaped, back to the spatial domain ------------------------
// Shaping a real white field rather than drawing coefficients directly keeps
// the Hermitian symmetry exact, so the inverse transform is real to rounding.
const rng = mulberry32(spec.seed);
const re = new Float64Array(N * N);
const im = new Float64Array(N * N);
const noise = gaussians(rng);
for (let i = 0; i < N * N; i++) re[i] = noise();
fft2d(re, im, N);
const binK = (i) => (i > N / 2 ? i - N : i);
for (let y = 0; y < N; y++) {
  const fy = binK(y);
  for (let x = 0; x < N; x++) {
    const a = amplitude(Math.hypot(binK(x), fy));
    const i = y * N + x;
    re[i] *= a;
    im[i] *= a;
  }
}
fft2d(re, im, N, true);

// --- tone: mean and contrast, then 8 bits -----------------------------------
let mean = 0;
for (let i = 0; i < N * N; i++) mean += re[i];
mean /= N * N;
let varr = 0;
for (let i = 0; i < N * N; i++) varr += (re[i] - mean) ** 2;
const sd = Math.sqrt(varr / (N * N)) || 1;
const gain = spec.tone.contrast / sd;
const data = new Uint8Array(N * N);
let clipped = 0;
for (let i = 0; i < N * N; i++) {
  const v = spec.tone.mean + (re[i] - mean) * gain;
  if (v <= 0 || v >= 1) clipped++;
  data[i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
}

const out = join(outDir, spec.out);
writeFileSync(out, encodeGrayPng(data, N, N));

// --- what it came out as ----------------------------------------------------
const map = { size: N, data };
const t8 = patternTile(map, scale, 8);
const t16 = patternTile(map, scale, 16);
let m2 = 0;
for (const v of data) m2 += v / 255;
m2 /= data.length;
let s2 = 0;
for (const v of data) s2 += (v / 255 - m2) ** 2;
console.log(
  `wrote ${out}  ${N}x${N}\n` +
    `  at scale ${scale}: tile ${periodPx.toFixed(0)}px, tooth ${hiPx}–${loPx}px\n` +
    `  variance at 8px and coarser  ${t8.coarsePct.toFixed(3)}%   (this is what repeats visibly)\n` +
    `  variance at 16px and coarser ${t16.coarsePct.toFixed(3)}%\n` +
    `  mean ${m2.toFixed(3)}  std ${Math.sqrt(s2 / data.length).toFixed(3)}  ` +
    `clipped ${((100 * clipped) / (N * N)).toFixed(2)}%`,
);
