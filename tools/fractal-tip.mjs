#!/usr/bin/env node
/**
 * fractal-tip — synthesize spectrally-shaped texture tips for a coverage
 * family, and calibrate each level's ink fraction against the harness.
 *
 *   node tools/fractal-tip.mjs tips/oil-sponge.spec.json
 *   node tools/fractal-tip.mjs tips/oil-sponge.spec.json --calibrate
 *   node tools/fractal-tip.mjs tips/oil-sponge.spec.json --levels 10,50
 *
 * The pipeline is §6 of docs/fractal-texture-math.md, executed literally:
 * shape a radial power law in the frequency domain, divide by the scatter
 * transfer function H = 1 − Λ² (the deconvolution), inverse-FFT with seeded
 * phases, threshold at each coverage level's quantile, correct the
 * post-threshold spectrum once, antialias, and close with a torn vignette.
 * `--calibrate` then paints real strokes through the CPU engine and walks
 * each level's ink fraction until measured stroke coverage hits its target,
 * writing the calibrated fractions back into the spec so the tips are
 * reproducible from the file alone.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  binFreq,
  encodeGrayPng,
  fft2d,
  gaussians,
  makeLambda,
  mulberry32,
  radialSpectrum,
} from './lib/dsp.mjs';
import { loadCpuHarness } from './lib/harness.mjs';

const argv = process.argv.slice(2);
const specPath = argv.find((a) => !a.startsWith('--'));
if (!specPath) {
  console.error('usage: node tools/fractal-tip.mjs <spec.json> [--calibrate] [--levels 10,50]');
  process.exit(1);
}
const CALIBRATE = argv.includes('--calibrate');
const levelsArg = (() => {
  const i = argv.indexOf('--levels');
  if (i < 0) return null;
  return new Set(argv[i + 1].split(',').map((s) => Number(s.trim())));
})();

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const specDir = dirname(resolve(specPath));
const outDir = resolve(specDir, spec.outDir ?? '.');
mkdirSync(outDir, { recursive: true });

const N = spec.native;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smoothstep = (a, b, x) => {
  if (a === b) return x < a ? 0 : 1;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// --- target spectrum and deconvolution --------------------------------------

const sp = spec.spectrum;
/**
 * Radial target power at k cycles per tip width (docs §5). Matérn-style:
 * flat below the shoulder (the texture is stationary beyond the
 * pore-cluster scale — a pure power law would pour all the variance into
 * the two or three coarsest modes and the tip would be one blob), falling
 * as k^-β from shoulder to knee, and steeper past the pore knee.
 */
function targetPower(k) {
  if (k < sp.bandLoCyclesPerDia) return 0;
  const sh = sp.shoulderCyclesPerDia;
  let s =
    Math.pow(sh * sh + k * k, -sp.beta / 2) *
    Math.pow(1 + (k / sp.kneeCyclesPerDia) ** 2, -(sp.beta2 - sp.beta) / 2);
  // Roll power DOWN below the shoulder rather than plateauing: sub-cluster
  // wavelengths (≳ half a diameter) survive the union nearly intact (H ≈ 1
  // is mild there), so plateau power at k ≈ 1–2 beads the stroke into
  // clouds at 1–1.5 diameter intervals — the exact ripple measure flags.
  if (k < sh && sp.lowSlope) s *= Math.pow(k / sh, sp.lowSlope);
  if (k > sp.cutCyclesPerDia) {
    if (k >= sp.taperCyclesPerDia) return 0;
    const t = (k - sp.cutCyclesPerDia) / (sp.taperCyclesPerDia - sp.cutCyclesPerDia);
    s *= Math.cos((t * Math.PI) / 2) ** 2;
  }
  return s;
}

const lambda = makeLambda();
/**
 * Max scatter offset in tip pixels: S = scatter × (tip diameter)/2, scaled
 * to native. The tip rides the DUAL train in a gated family — the mask is
 * what carries the texture — so its kernel is the dual scatter. A pattern
 * spec (`output: "pattern"`) is canvas-anchored: no train, no kernel,
 * H ≡ 1.
 */
const S_TIP = spec.train?.dual ? spec.train.dual.scatter * (N / 2) : 0;
/** Scatter transfer H(f) = 1 − Λ(2πfS)² — the kernel we deconvolve by. */
function scatterTransfer(fPerPx) {
  if (!S_TIP) return 1;
  const L = lambda(2 * Math.PI * fPerPx * S_TIP);
  return Math.max(1e-4, 1 - L * L);
}

/**
 * Amplitude filter over the FFT grid: √(S★/H), times an optional measured
 * correction curve (log-k → gain) from the post-threshold audit.
 */
function buildAmp(correction) {
  const amp = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const fy = binFreq(y, N);
    for (let x = 0; x < N; x++) {
      const f = Math.hypot(binFreq(x, N), fy);
      const k = f * N;
      const p = targetPower(k);
      if (p <= 0) continue;
      let a = Math.sqrt(p / scatterTransfer(f));
      if (correction) a *= correction(k);
      amp[y * N + x] = a;
    }
  }
  return amp;
}

// --- synthesis ---------------------------------------------------------------

/** One fixed set of spectral phases: the whole family is one field. */
const phases = (() => {
  const g = gaussians(mulberry32(spec.seed));
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    re[i] = g();
    im[i] = g();
  }
  return { re, im };
})();

/** Gaussian field with spectrum amp², phases fixed; normalized to μ0 σ1. */
function synthField(amp) {
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  for (let i = 0; i < amp.length; i++) {
    re[i] = phases.re[i] * amp[i];
    im[i] = phases.im[i] * amp[i];
  }
  fft2d(re, im, N, true);
  let mean = 0;
  for (let i = 0; i < re.length; i++) mean += re[i];
  mean /= re.length;
  let vari = 0;
  for (let i = 0; i < re.length; i++) {
    re[i] -= mean;
    vari += re[i] * re[i];
  }
  const inv = 1 / Math.sqrt(vari / re.length || 1);
  for (let i = 0; i < re.length; i++) re[i] *= inv;
  return re;
}

/** Values inside the vignette plateau (r ≤ 0.6), sorted — the quantile table. */
function plateauSorted(field) {
  const c = (N - 1) / 2;
  const r2max = (0.6 * (N / 2)) ** 2;
  const vals = [];
  for (let y = 0; y < N; y++) {
    const dy = y - c;
    for (let x = 0; x < N; x++) {
      const dx = x - c;
      if (dx * dx + dy * dy <= r2max) vals.push(field[y * N + x]);
    }
  }
  vals.sort((a, b) => a - b);
  return vals;
}

const quantile = (sorted, q) =>
  sorted[clamp(Math.floor((1 - q) * sorted.length), 0, sorted.length - 1)];

/** Separable tent blur; halfWidth in tip px sets the antialiased rim. */
function tentBlur(field, halfWidth) {
  const w = Math.max(1, Math.round(halfWidth));
  const kernel = [];
  let sum = 0;
  for (let i = -w; i <= w; i++) {
    const v = w + 1 - Math.abs(i);
    kernel.push(v);
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let i = -w; i <= w; i++) acc += kernel[i + w] * field[y * N + clamp(x + i, 0, N - 1)];
      tmp[y * N + x] = acc;
    }
  }
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let i = -w; i <= w; i++) acc += kernel[i + w] * tmp[clamp(y + i, 0, N - 1) * N + x];
      out[y * N + x] = acc;
    }
  }
  return out;
}

/**
 * Torn radial falloff riding the family's own coarse field, with the hard
 * guard that forces zero before the bitmap frame (the raggedVignette rule:
 * ink at the border stamps rectangles into the mark).
 */
const coarseField = (() => {
  const amp = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const fy = binFreq(y, N);
    for (let x = 0; x < N; x++) {
      const k = Math.hypot(binFreq(x, N), fy) * N;
      if (k > 0 && k <= 4) amp[y * N + x] = Math.sqrt(targetPower(Math.max(k, sp.bandLoCyclesPerDia)));
    }
  }
  return synthField(amp);
})();

const vignette = (() => {
  if (!spec.vignette) return null; // pattern specs never stamp, never tear
  const { inner, rag } = spec.vignette;
  const out = new Float64Array(N * N);
  const c = (N - 1) / 2;
  const R = N / 2;
  for (let y = 0; y < N; y++) {
    const dy = (y - c) / R;
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const r = Math.hypot((x - c) / R, dy);
      const d = r * (1 + rag * clamp(coarseField[i] * 0.4, -0.5, 0.5) * 2);
      out[i] = smoothstep(1, inner, d) * smoothstep(1, 0.92, r);
    }
  }
  return out;
})();

/** Threshold + AA + vignette → final byte map. */
function finishTip(field, sorted, q) {
  const t = quantile(sorted, q);
  const bin = new Float64Array(N * N);
  for (let i = 0; i < bin.length; i++) bin[i] = field[i] > t ? 1 : 0;
  const aaHalf = ((spec.aaCanvasPx ?? 0.7) * N) / spec.train.size;
  const soft = tentBlur(bin, aaHalf);
  const data = new Uint8Array(N * N);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(clamp(soft[i] * vignette[i], 0, 1) * 255);
  }
  return data;
}

/**
 * One spectral correction pass (docs §6.5): compare the thresholded field's
 * radial spectrum to the target shape and return a smoothed gain curve.
 * Thresholding whitens sparse levels; this puts the slope back.
 */
function correctionCurve(field, sorted, q) {
  const t = quantile(sorted, q);
  const bin = new Float64Array(N * N);
  for (let i = 0; i < bin.length; i++) bin[i] = field[i] > t ? 1 : 0;
  const rs = radialSpectrum(bin, N, 96);
  const ks = rs.freq.map((f) => f * N);
  const lo = 1.2;
  const hi = sp.cutCyclesPerDia * 0.8;
  const anchor = { num: 0, den: 0, n: 0 };
  const raw = ks.map((k, i) => {
    if (k < lo || k > hi || rs.power[i] <= 0) return null;
    const g = Math.sqrt(targetPower(k) / rs.power[i]);
    if (k >= 3 && k <= 15) {
      anchor.num += Math.log(g);
      anchor.n++;
    }
    return Math.log(g);
  });
  const norm = anchor.n ? anchor.num / anchor.n : 0;
  const pts = [];
  for (let i = 0; i < ks.length; i++) {
    if (raw[i] === null) continue;
    pts.push({ k: ks[i], g: clamp(Math.exp(raw[i] - norm), 0.55, 1.8) });
  }
  // 3-tap smoothing in bin order, then log-k linear interpolation
  const sm = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)].g;
    const b = pts[Math.min(pts.length - 1, i + 1)].g;
    return { k: p.k, g: (a + p.g + b) / 3 };
  });
  return (k) => {
    if (!sm.length || k <= sm[0].k) return sm.length ? sm[0].g : 1;
    if (k >= sm[sm.length - 1].k) return sm[sm.length - 1].g;
    let i = 0;
    while (sm[i + 1].k < k) i++;
    const t01 = (Math.log(k) - Math.log(sm[i].k)) / (Math.log(sm[i + 1].k) - Math.log(sm[i].k));
    return sm[i].g + (sm[i + 1].g - sm[i].g) * t01;
  };
}

// --- stroke-coverage probe (the calibration loop's measurement) --------------

const INK_FLOOR = 8;

/**
 * Flat-stroke coverage, two readings per seed:
 *
 * - `box`: over the full ink bounding band with metrics.ts's 8% inset —
 *   the number `measure` reports. A torn-edged mark can never fill this to
 *   ~1: the ragged rim zone is inside the box and bare by design.
 * - `core`: over the FWHM band of the mean transverse profile — interior
 *   fill, excluding the ragged edge zone. This is what the family's
 *   coverage labels grade, and what calibration targets.
 */
async function probeCoverage(harness, tipId) {
  const s = trainSettings(harness, tipId);
  const d = spec.train.size;
  const pad = Math.ceil(d * 2 + 40);
  const runLen = Math.ceil(Math.max(d * 12, 700));
  const w = runLen + pad * 2;
  const h = Math.ceil(d * 4 + 80);
  const step = Math.max(1.5, d / 14);
  const surface = await harness.Surface.create(w, h);
  let box = 0;
  let core = 0;
  const seeds = [100, 101];
  for (const seed of seeds) {
    surface.clear();
    const pts = [];
    for (let x = pad; x <= pad + runLen; x += step) {
      pts.push({ x, y: h / 2, pressure: 0.8, tiltX: 0, tiltY: 0, twist: 0 });
    }
    surface.paint(s, pts, { seed });
    const alpha = await surface.readAlpha();
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] >= INK_FLOOR) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < x0) continue;
    const inset = Math.round((x1 - x0) * 0.08);
    const covIn = (yLo, yHi) => {
      let inked = 0;
      let total = 0;
      for (let y = yLo; y <= yHi; y++) {
        for (let x = x0 + inset; x <= x1 - inset; x++) {
          total++;
          if (alpha[y * w + x] >= INK_FLOOR) inked++;
        }
      }
      return total ? inked / total : 0;
    };
    box += covIn(y0, y1) / seeds.length;

    // mean transverse profile, lightly smoothed, then its FWHM band
    const prof = new Float64Array(y1 - y0 + 1);
    for (let y = y0; y <= y1; y++) {
      let sum = 0;
      for (let x = x0 + inset; x <= x1 - inset; x++) sum += alpha[y * w + x];
      prof[y - y0] = sum;
    }
    const sm = prof.map((_, i) => {
      let acc = 0;
      let n = 0;
      for (let j = -3; j <= 3; j++) {
        const k = i + j;
        if (k >= 0 && k < prof.length) {
          acc += prof[k];
          n++;
        }
      }
      return acc / n;
    });
    let peakAt = 0;
    for (let i = 1; i < sm.length; i++) if (sm[i] > sm[peakAt]) peakAt = i;
    const half = sm[peakAt] / 2;
    let lo = peakAt;
    let hi = peakAt;
    while (lo > 0 && sm[lo - 1] >= half) lo--;
    while (hi < sm.length - 1 && sm[hi + 1] >= half) hi++;
    core += covIn(y0 + lo, y0 + hi) / seeds.length;
  }
  return { box, core };
}

/**
 * The family's shared train — the same numbers the brush documents carry.
 * Dual-gate architecture: a solid round primary lays the paint; the
 * synthesized sponge tip rides the DUAL slot as a mask whose holes gate the
 * finished stroke (docs/fractal-texture-math.md §9 — the mask multiplies
 * once, so its labyrinth survives however densely the primary accumulates).
 */
function trainSettings(harness, tipId) {
  const t = spec.train;
  return harness.makeBrush({
    tip: { shape: 'round', size: t.size, hardness: t.primary.hardness, spacing: t.primary.spacing },
    shape: {
      enabled: true,
      sizeJitter: t.primary.sizeJitter,
      sizeControl: { source: 'pressure', fadeSteps: 25 },
      minDiameter: t.primary.minDiameter,
    },
    dual: {
      enabled: true,
      shape: tipId,
      size: Math.round(t.size * t.dual.sizeRatio),
      spacing: t.dual.spacing,
      scatter: t.dual.scatter,
      bothAxes: true,
      count: t.dual.count,
      mode: 'multiply',
    },
    flow: t.flow,
  });
}

// --- main --------------------------------------------------------------------

const t0 = Date.now();
console.log(`synthesizing ${spec.name}: ${N}px field, β=${sp.beta}, knee ${sp.kneeCyclesPerDia} c/dia`);
const baseAmp = buildAmp(null);
const baseField = synthField(baseAmp);

if (spec.output === 'pattern') {
  // A texture-channel pattern: tileable by FFT construction, no vignette,
  // no threshold. Rank-equalize the field to a uniform histogram so the
  // subtract-mode contact model (docs §9: inked where v > 1 − a) turns the
  // pattern's value distribution into an identity — stroke coverage then
  // tracks accumulated alpha directly, and the pressure curve is designed
  // entirely in the brush document's flow mapping.
  const order = Array.from(baseField.keys()).sort((i, j) => baseField[i] - baseField[j]);
  const data = new Uint8Array(N * N);
  for (let rank = 0; rank < order.length; rank++) {
    data[order[rank]] = Math.round((rank / (order.length - 1)) * 255);
  }
  const out = join(outDir, `${spec.name}.png`);
  writeFileSync(out, encodeGrayPng(data, N, N));
  console.log(`  ${out}  (tileable pattern, equalized)  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

const baseSorted = plateauSorted(baseField);

const harness = CALIBRATE ? await loadCpuHarness() : null;
const report = [];

for (const level of spec.levels) {
  const pct = Math.round(level.coverage * 100);
  if (levelsArg && !levelsArg.has(pct)) continue;
  const name = `${spec.name}-${pct}`;

  // Optional spectral correction pass at this level's threshold. Off by
  // default: a thresholded print NEEDS the edge-generated high-frequency
  // tail a Gaussian target lacks, so "correcting" the binary field toward
  // the Gaussian target deletes the pore band. The design surface is the
  // pre-threshold spectrum; the stroke audit measures what actually ships.
  const corr = spec.spectralCorrection ? correctionCurve(baseField, baseSorted, level.q) : null;
  const field = corr ? synthField(buildAmp(corr)) : baseField;
  const sorted = corr ? plateauSorted(field) : baseSorted;

  let q = level.q;
  let measured = null;
  let bytes = finishTip(field, sorted, q);

  if (CALIBRATE) {
    for (let iter = 0; iter < 5; iter++) {
      harness.registerTip(name, { size: N, data: bytes });
      measured = await probeCoverage(harness, name);
      if (Math.abs(measured.core - level.coverage) <= 0.012) break;
      // Poisson-model update (docs §4): C = 1 − e^(−n·q) ⇒ n from the
      // measurement, then q for the target — converges in 1–2 steps.
      const nEff = -Math.log(1 - Math.min(measured.core, 0.995)) / q;
      q = clamp(-Math.log(1 - level.coverage) / nEff, 0.002, 0.95);
      bytes = finishTip(field, sorted, q);
    }
    level.q = +q.toFixed(4);
  }

  writeFileSync(join(outDir, `${name}.png`), encodeGrayPng(bytes, N, N));
  let inkSum = 0;
  for (const b of bytes) inkSum += b;
  report.push({
    level: `${pct}%`,
    q: q.toFixed(4),
    tipInk: (inkSum / 255 / bytes.length).toFixed(4),
    core: measured === null ? '—' : measured.core.toFixed(4),
    box: measured === null ? '—' : measured.box.toFixed(4),
  });
  console.log(
    `  ${name}.png  q=${q.toFixed(4)}  ` +
      (measured === null
        ? ''
        : `core ${measured.core.toFixed(3)} (target ${level.coverage}) · box ${measured.box.toFixed(3)}`),
  );
}

if (CALIBRATE) {
  writeFileSync(resolve(specPath), JSON.stringify(spec, null, 2) + '\n');
  console.log(`calibrated ink fractions written back to ${specPath}`);
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.table(report);
