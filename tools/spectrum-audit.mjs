#!/usr/bin/env node
/**
 * spectrum-audit — the frequency-domain acceptance checks of
 * docs/fractal-texture-math.md §7, run against real painted marks.
 *
 *   node tools/spectrum-audit.mjs brushes/oil-sponge-50.json [...]
 *   node tools/spectrum-audit.mjs brushes/ --out out/audit
 *
 * For each brush this paints (CPU renderer, fixed seeds):
 *
 * - one long flat stroke — the mark a viewer sees;
 * - a filled patch: parallel strokes at randomized row phase, the way a
 *   painter actually covers a region. Row placement is jittered so the fill
 *   procedure cannot inject a lattice of its own.
 *
 * and reports, from the patch's central square:
 *
 * - the radially averaged power spectrum with a fitted slope β over the
 *   texture band (2–30 cycles/diameter);
 * - spectral spikes: per-annulus max/median power, flagged when a bin
 *   stands far above its own annulus (a periodic artifact is a line; the
 *   texture floor is broadband);
 * - anisotropy: sector power spread over the texture band;
 * - patch and stroke coverage for the record.
 *
 * Artifacts land in --out (default out/audit): 1:1 crops of the stroke and
 * patch, and a log-power image of the centred 2-D spectrum.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { binFreq, encodeGrayPng, fft2d, mulberry32 } from './lib/dsp.mjs';
import { loadDocs } from './lib/docs.mjs';
import { loadCpuHarness } from './lib/harness.mjs';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : 'out/audit';
const paths = argv.filter((a) => !a.startsWith('--'));
if (!paths.length) {
  console.error('usage: node tools/spectrum-audit.mjs <brush.json | dir> [--out dir]');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const h = await loadCpuHarness();
const { docs, assets } = loadDocs(paths);
const resolved = await h.resolvedSettings(docs, assets);

const INK_FLOOR = 8;
const FFT_N = 1024;

/** Paint one long flat stroke; returns {alpha, w, h}. */
async function paintStroke(settings, d) {
  const pad = Math.ceil(d * 2 + 40);
  const runLen = Math.ceil(Math.max(d * 12, 1400));
  const w = runLen + pad * 2;
  const hh = Math.ceil(d * 4 + 80);
  const surface = await h.Surface.create(w, hh);
  const pts = [];
  const step = Math.max(1.5, d / 14);
  for (let x = pad; x <= pad + runLen; x += step) {
    pts.push({ x, y: hh / 2, pressure: 0.8, tiltX: 0, tiltY: 0, twist: 0 });
  }
  surface.paint(settings, pts, { seed: 1 });
  return { alpha: await surface.readAlpha(), w, h: hh };
}

/**
 * Fill a region with parallel strokes. Rows sit ~0.55·d apart with their
 * y jittered and their x phase randomized per row, alternating direction —
 * covering the canvas the way a hand would, without a row lattice.
 */
async function paintPatch(settings, d) {
  const size = FFT_N + Math.ceil(d * 3);
  const surface = await h.Surface.create(size, size);
  const rng = mulberry32(97);
  const step = Math.max(1.5, d / 14);
  const rowGap = 0.42 * d;
  let row = 0;
  for (let y = d * 0.5; y < size - d * 0.3; y += rowGap * (0.75 + 0.6 * rng())) {
    const dir = row++ % 2 === 0 ? 1 : -1;
    const x0 = dir > 0 ? -d : size + d;
    const pts = [];
    const yy = y + (rng() - 0.5) * 0.5 * d;
    for (let x = 0; x <= size + 2 * d; x += step) {
      pts.push({ x: x0 + dir * x, y: yy, pressure: 0.8, tiltX: 0, tiltY: 0, twist: 0 });
    }
    surface.paint(settings, pts, { seed: 1000 + row });
  }
  return { alpha: await surface.readAlpha(), w: size, h: size };
}

const coverageOf = (alpha) => {
  let inked = 0;
  for (const a of alpha) if (a >= INK_FLOOR) inked++;
  return inked / alpha.length;
};

/** Central n×n window of an alpha buffer as floats 0..1. */
function centerWindow(alpha, w, hh, n) {
  const x0 = Math.floor((w - n) / 2);
  const y0 = Math.floor((hh - n) / 2);
  const out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) out[y * n + x] = alpha[(y0 + y) * w + (x0 + x)] / 255;
  }
  return out;
}

/** Ink-on-paper crop (white ground, dark ink) for looking at 1:1. */
function cropPng(alpha, w, hh, cx, cy, cw, chh) {
  const data = new Uint8Array(cw * chh);
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(w - 1, Math.max(0, cx + x));
      const sy = Math.min(hh - 1, Math.max(0, cy + y));
      data[y * cw + x] = 255 - alpha[sy * w + sx];
    }
  }
  return encodeGrayPng(data, cw, chh);
}

/** Full spectral audit of one n×n field. */
function audit(field, n, d) {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  let mean = 0;
  for (const v of field) mean += v;
  mean /= field.length;
  // Hann window in both axes so the patch boundary does not ring
  for (let y = 0; y < n; y++) {
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (n - 1));
    for (let x = 0; x < n; x++) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (n - 1));
      re[y * n + x] = (field[y * n + x] - mean) * wx * wy;
    }
  }
  fft2d(re, im, n);

  // per-annulus stats in cycles/diameter, log-spaced
  const bins = 64;
  const kMin = 0.5;
  const kMax = 0.5 * n * (d / n) * 2; // Nyquist in c/dia = d/2... kept explicit below
  const kNyq = (0.5 * d); // cycles per diameter at f = 0.5 c/px
  const logMin = Math.log(kMin);
  const span = Math.log(kNyq) - logMin;
  // Bins on the fx/fy axes are excluded from the annuli: the fill's rows
  // put an axis ridge at fx≈0 (each stroke is coherent along x), and the
  // stroke's own mean profile does the same — macro-structure of how the
  // marks were laid, not texture repetition. Combs are detected separately.
  const axis = 3;
  const annuli = Array.from({ length: bins }, () => []);
  for (let y = 0; y < n; y++) {
    const fy = binFreq(y, n);
    for (let x = 0; x < n; x++) {
      if (x === 0 && y === 0) continue;
      if (Math.min(x, n - x) < axis || Math.min(y, n - y) < axis) continue;
      const fx = binFreq(x, n);
      const k = Math.hypot(fx, fy) * d; // cycles per tip diameter
      if (k < kMin || k > kNyq) continue;
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((Math.log(k) - logMin) / span) * bins)));
      const i = y * n + x;
      annuli[b].push({ p: re[i] * re[i] + im[i] * im[i], fx, fy });
    }
  }

  /**
   * Comb detector: a stamp train leaves vertical LINES at fx = k/Δ (docs
   * §2), so integrate power over fy per fx column (axis ridge excluded) and
   * compare each column against the median of its neighbourhood.
   */
  const combScan = (transpose) => {
    const colPower = new Float64Array(n / 2);
    for (let x = axis; x < n / 2; x++) {
      let sum = 0;
      for (let y = axis; y < n - axis; y++) {
        const i = transpose ? x * n + y : y * n + x;
        sum += re[i] * re[i] + im[i] * im[i];
      }
      colPower[x] = sum;
    }
    let worst = { ratio: 0, k: 0 };
    for (let x = axis + 8; x < n / 2 - 8; x++) {
      const hood = [];
      for (let j = -8; j <= 8; j++) if (Math.abs(j) > 2) hood.push(colPower[x + j]);
      hood.sort((a, b) => a - b);
      const med = hood[hood.length >> 1] || 1e-30;
      const ratio = colPower[x] / med;
      if (ratio > worst.ratio) worst = { ratio, k: +((x / n) * d).toFixed(2) };
    }
    return worst;
  };
  const combAlong = combScan(false); // stamp-train direction
  const combAcross = combScan(true); // fill-row direction (procedure sanity)

  const radial = [];
  let worstSpike = { ratio: 0 };
  for (let b = 0; b < bins; b++) {
    const a = annuli[b];
    if (a.length < 16) continue;
    const ps = a.map((e) => e.p).sort((x, y) => x - y);
    const median = ps[ps.length >> 1] || 1e-30;
    const meanP = ps.reduce((s, v) => s + v, 0) / ps.length;
    let top = a[0];
    for (const e of a) if (e.p > top.p) top = e;
    const k = Math.exp(logMin + span * ((b + 0.5) / bins));
    radial.push({ k, power: meanP, n: a.length });
    // the max of m exponential draws sits near ln(m)·mean ≈ 1.44·ln(m)·median;
    // report how far the top bin stands above THAT, so 1 ≈ unremarkable
    const expected = median * 1.4427 * Math.log(a.length);
    const ratio = top.p / Math.max(expected, 1e-30);
    if (k > 1 && ratio > worstSpike.ratio) {
      worstSpike = {
        ratio,
        k: +k.toFixed(2),
        periodPx: +(d / k).toFixed(1),
        angleDeg: +((Math.atan2(top.fy, top.fx) * 180) / Math.PI).toFixed(1),
      };
    }
  }

  // slope fit over the texture band
  const band = radial.filter((r) => r.k >= 2 && r.k <= 30);
  let beta = NaN;
  if (band.length > 4) {
    const xs = band.map((r) => Math.log(r.k));
    const ys = band.map((r) => Math.log(r.power));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    beta = -num / den;
  }

  // anisotropy: sector power over the texture band
  const sectors = new Float64Array(18);
  const counts = new Float64Array(18);
  for (let b = 0; b < bins; b++) {
    for (const e of annuli[b]) {
      const k = Math.hypot(e.fx, e.fy) * d;
      if (k < 3 || k > 30) continue;
      // fold to 180° — the spectrum of a real field is centro-symmetric
      let ang = Math.atan2(e.fy, e.fx);
      if (ang < 0) ang += Math.PI;
      const s = Math.min(17, Math.floor((ang / Math.PI) * 18));
      sectors[s] += e.p;
      counts[s]++;
    }
  }
  const sectorMeans = [...sectors].map((p, i) => (counts[i] ? p / counts[i] : 0)).filter(Boolean);
  const sMean = sectorMeans.reduce((a, b) => a + b, 0) / sectorMeans.length;
  const anisotropyDb =
    10 * Math.log10(Math.max(...sectorMeans) / Math.max(Math.min(...sectorMeans), 1e-30));

  return { radial, beta, worstSpike, combAlong, combAcross, anisotropyDb, spectrumRe: re, spectrumIm: im };
}

/**
 * Centred log-power image of the spectrum, zoomed to the texture band
 * (±kShow cycles/diameter) — at full Nyquist the band is an unreadable dot.
 */
function spectrumPng(re, im, n, d, out, kShow = 32) {
  const half = 512;
  const img = new Float64Array(half * half);
  const fMax = kShow / d; // cycles/px at the edge of the image
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const fx = ((x - half / 2) / (half / 2)) * fMax;
      const fy = ((y - half / 2) / (half / 2)) * fMax;
      let sx = Math.round(fx * n);
      let sy = Math.round(fy * n);
      sx = ((sx % n) + n) % n;
      sy = ((sy % n) + n) % n;
      const i = sy * n + sx;
      img[y * half + x] = Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-12);
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of img) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const data = new Uint8Array(half * half);
  for (let i = 0; i < img.length; i++) {
    data[i] = Math.round(((img[i] - lo) / (hi - lo || 1)) * 255);
  }
  writeFileSync(out, encodeGrayPng(data, half, half));
}

const rows = [];
for (const brush of resolved) {
  const { id, settings } = brush;
  const d = settings.tip.size;
  const name = basename(id);

  const stroke = await paintStroke(settings, d);
  const patch = await paintPatch(settings, d);
  const field = centerWindow(patch.alpha, patch.w, patch.h, FFT_N);
  const a = audit(field, FFT_N, d);

  writeFileSync(
    join(OUT, `${name}.stroke.png`),
    cropPng(stroke.alpha, stroke.w, stroke.h, Math.floor(stroke.w / 2 - 350), Math.floor(stroke.h / 2 - 150), 700, 300),
  );
  writeFileSync(
    join(OUT, `${name}.patch.png`),
    cropPng(patch.alpha, patch.w, patch.h, Math.floor(patch.w / 2 - 256), Math.floor(patch.h / 2 - 256), 512, 512),
  );
  spectrumPng(a.spectrumRe, a.spectrumIm, FFT_N, d, join(OUT, `${name}.spectrum.png`));
  writeFileSync(
    join(OUT, `${name}.radial.json`),
    JSON.stringify({ id: name, beta: a.beta, radial: a.radial.map(({ k, power }) => ({ k: +k.toFixed(3), power })) }, null, 1),
  );

  rows.push({
    brush: name,
    'patch cov': coverageOf(patch.alpha).toFixed(3),
    beta: a.beta.toFixed(2),
    'spike ×': a.worstSpike.ratio.toFixed(1),
    'spike @': a.worstSpike.k ? `${a.worstSpike.k} c/dia ${a.worstSpike.angleDeg}°` : '—',
    'comb ×': a.combAlong.ratio.toFixed(1),
    'comb @': `${a.combAlong.k} c/dia`,
    'rows ×': a.combAcross.ratio.toFixed(1),
    'aniso dB': a.anisotropyDb.toFixed(1),
  });
  console.log(`${name}: β=${a.beta.toFixed(2)}, spike ${a.worstSpike.ratio.toFixed(1)}× @${a.worstSpike.k}c/dia, comb ${a.combAlong.ratio.toFixed(1)}× @${a.combAlong.k}c/dia, aniso ${a.anisotropyDb.toFixed(1)}dB`);
}
console.table(rows);
console.log(`artifacts in ${OUT}/`);
