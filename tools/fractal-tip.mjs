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
  makeWorley,
  mulberry32,
  radialSpectrum,
  worley,
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
 * One spectral band at k cycles per tip width (docs §5). Matérn-style:
 * flat below the shoulder (the texture is stationary beyond the
 * pore-cluster scale — a pure power law would pour all the variance into
 * the two or three coarsest modes and the tip would be one blob), falling
 * as k^-β from shoulder to knee, and steeper past the pore knee.
 */
function bandPower(b, k) {
  if (k < b.bandLoCyclesPerDia) return 0;
  const sh = b.shoulderCyclesPerDia;
  let s =
    Math.pow(sh * sh + k * k, -b.beta / 2) *
    Math.pow(1 + (k / b.kneeCyclesPerDia) ** 2, -(b.beta2 - b.beta) / 2);
  // Roll power DOWN below the shoulder rather than plateauing: sub-cluster
  // wavelengths (≳ half a diameter) survive the union nearly intact (H ≈ 1
  // is mild there), so plateau power at k ≈ 1–2 beads the stroke into
  // clouds at 1–1.5 diameter intervals — the exact ripple measure flags.
  if (k < sh && b.lowSlope) s *= Math.pow(k / sh, b.lowSlope);
  if (k > b.cutCyclesPerDia) {
    if (k >= b.taperCyclesPerDia) return 0;
    const t = (k - b.cutCyclesPerDia) / (b.taperCyclesPerDia - b.cutCyclesPerDia);
    s *= Math.cos((t * Math.PI) / 2) ** 2;
  }
  return s;
}

/**
 * Target power: a single band, or a weighted sum of them. A material with
 * two characteristic populations — rust's spread patches and its fine
 * pitting, say — is two bands with independent weights; each is normalized
 * at its own shoulder so `weight` compares like with like.
 */
const COMPONENTS = (sp.components ?? [sp]).map((b) => {
  // Normalize each band by its per-OCTAVE variance (2-D: ∝ k²·S) at its own
  // shoulder, so `weight` compares the variance the eye sees. Per-mode
  // normalization overweights high-frequency bands by the annulus mode
  // count — a 0.35-weight pit band at k≈22 buried a unit bloom band at
  // k≈2.5 under 27× its variance.
  const anchor = Math.max(b.shoulderCyclesPerDia, b.bandLoCyclesPerDia);
  return { ...b, norm: 1 / Math.max(bandPower(b, anchor) * anchor * anchor, 1e-30) };
});
function targetPower(k) {
  let s = 0;
  for (const b of COMPONENTS) s += (b.weight ?? 1) * b.norm * bandPower(b, k);
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
  // stretchX > 1 squeezes the passband in fx, elongating structure along x:
  // the anisotropy of brushed metal, drag marks, striated stone. The tip
  // rotates at paint time (or the pattern is laid once), so one axis serves.
  const stretch = sp.stretchX ?? 1;
  for (let y = 0; y < N; y++) {
    const fy = binFreq(y, N);
    for (let x = 0; x < N; x++) {
      const f = Math.hypot(binFreq(x, N) * stretch, fy);
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

function makePhases(seed) {
  const g = gaussians(mulberry32(seed));
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    re[i] = g();
    im[i] = g();
  }
  return { re, im };
}

/** One fixed set of spectral phases: the whole family is one field. */
const phases = makePhases(spec.seed);

/** Gaussian field with spectrum amp², phases fixed; normalized to μ0 σ1. */
function synthField(amp, ph = phases) {
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);
  for (let i = 0; i < amp.length; i++) {
    re[i] = ph.re[i] * amp[i];
    im[i] = ph.im[i] * amp[i];
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

/**
 * Cellular survival field (field.kind: "cellular"): a weighted sum of
 * per-cell random values over several Worley scales, plus an fbm term, minus
 * a dip along the coarsest scale's cell walls. Thresholding drops whole
 * cells — angular flakes with mixed sizes — the fbm clusters the damage,
 * and the wall dip keeps hairline cracks below threshold even at high
 * coverage. Gaussian level sets cannot make any of that (docs §4: phase);
 * this generator exists for the fracture/fragment family of materials.
 */
function cellularField(f) {
  const rng = mulberry32(spec.seed + 101);
  const scales = f.scales.map((s) => ({ w: makeWorley(rng, s.cells), weight: s.weight }));
  const fbm = synthField(buildAmp(null), makePhases(spec.seed + 7));
  let wx = null;
  let wy = null;
  if (f.warp) {
    const warpAmp = new Float64Array(N * N);
    for (let y = 0; y < N; y++) {
      const fy = binFreq(y, N);
      for (let x = 0; x < N; x++) {
        const k = Math.hypot(binFreq(x, N), fy) * N;
        if (k > 0 && k <= 5) warpAmp[y * N + x] = 1 / (1 + k * k);
      }
    }
    wx = synthField(warpAmp, makePhases(spec.seed + 13));
    wy = synthField(warpAmp, makePhases(spec.seed + 17));
  }
  const wallIdx = f.wallScaleIndex ?? 0;
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const v0 = y / N;
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = x / N + (wx ? f.warp * wx[i] : 0);
      const v = v0 + (wy ? f.warp * wy[i] : 0);
      let s = f.fbmWeight * fbm[i];
      for (let sc = 0; sc < scales.length; sc++) {
        const hit = worley(scales[sc].w, u, v);
        s += (scales[sc].weight * (hit.v - 0.5)) / 0.2887;
        // dimple term: deeper toward cell edges, a dome per cell — hammered
        // metal, orange peel, per-pebble shading on leather
        if (scales[sc].f1Weight) s -= scales[sc].f1Weight * hit.f1;
        if (sc === wallIdx && f.wallDepth) {
          s -= f.wallDepth * smoothstep(f.wallWidth, 0, hit.f2 - hit.f1);
        }
      }
      out[i] = s;
    }
  }
  let mean = 0;
  for (const v of out) mean += v;
  mean /= out.length;
  let vari = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    vari += out[i] * out[i];
  }
  const inv = 1 / Math.sqrt(vari / out.length || 1);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Pore/foam wallness field (field.kind: "pores"): bubbles at Worley feature
 * points over several scales, radii heavy-tailed per cell, and the field is
 * how far a point sits OUTSIDE the deepest bubble claiming it. Thresholds
 * of this field are foam: high coverage = thick Plateau borders around
 * small round holes, low coverage = a thin connected lace along the wall
 * medials — the walls between bubbles are connected by construction, which
 * is the thin-network structure a Gaussian level set cannot make.
 */
function poresField(f) {
  const rng = mulberry32(spec.seed + 211);
  const scales = f.scales.map((s) => ({ ...s, w: makeWorley(rng, s.cells) }));
  const fbm = f.fbmWeight ? synthField(buildAmp(null), makePhases(spec.seed + 7)) : null;
  let wxF = null;
  let wyF = null;
  if (f.warp) {
    const warpAmp = new Float64Array(N * N);
    for (let y = 0; y < N; y++) {
      const fy = binFreq(y, N);
      for (let x = 0; x < N; x++) {
        const k = Math.hypot(binFreq(x, N), fy) * N;
        if (k > 0 && k <= 5) warpAmp[y * N + x] = 1 / (1 + k * k);
      }
    }
    wxF = synthField(warpAmp, makePhases(spec.seed + 13));
    wyF = synthField(warpAmp, makePhases(spec.seed + 17));
  }
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const v0 = y / N;
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = x / N + (wxF ? f.warp * wxF[i] : 0);
      const v = v0 + (wyF ? f.warp * wyF[i] : 0);
      // Growth time: how much every bubble must inflate before this point
      // is swallowed — min over bubbles of (f1/r − 1). Thresholding this is
      // UNIFORM bubble growth, so walls thin everywhere and the lace stays
      // connected at low coverage. (Absolute wall distance was tried first
      // and fails: its high quantiles retreat to junction pockets, leaving
      // isolated dots instead of a network.)
      let firstSwallow = 1e9;
      for (const s of scales) {
        const hit = worley(s.w, u, v);
        // per-cell radius in cell units: rBase ± rVar, value^gamma heavy tail
        const r = s.rBase + s.rVar * Math.pow(hit.v, s.gamma ?? 2);
        const g = (hit.f1 / r - 1) / (s.weight ?? 1);
        if (g < firstSwallow) firstSwallow = g;
      }
      out[i] = firstSwallow + (fbm ? f.fbmWeight * fbm[i] : 0);
    }
  }
  let mean = 0;
  for (const v of out) mean += v;
  mean /= out.length;
  let vari = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    vari += out[i] * out[i];
  }
  const inv = 1 / Math.sqrt(vari / out.length || 1);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Vein network field (field.kind: "veins"): veins are the zero contours of
 * band-passed Gaussian fields — smooth, non-repeating curves at each
 * octave's wavelength — lifted into ridges by exp(−(g/w)²) and summed over
 * a hierarchy of octaves (primary veins + finer tributaries), all sampled
 * through one strong low-frequency domain warp: the marble flow. Threshold
 * low quantiles for thin primaries; deeper cuts widen the veins and admit
 * tributaries, toward a breccia-like vein matrix.
 */
function veinsField(f) {
  const bandAmp = (kc, bw) => {
    const amp = new Float64Array(N * N);
    for (let y = 0; y < N; y++) {
      const fy = binFreq(y, N);
      for (let x = 0; x < N; x++) {
        const k = Math.hypot(binFreq(x, N), fy) * N;
        if (k > 0) amp[y * N + x] = Math.exp(-((Math.log(k / kc) / bw) ** 2));
      }
    }
    return amp;
  };
  // Each octave gets a slow amplitude modulation so a vein waxes and wanes
  // along its length. Without it the ridge is a constant-height plateau and
  // a sparse quantile cut lands INSIDE it — the finer octaves then decide
  // which scraps survive, and the "primary veins" come out as chips instead
  // of flowing segments.
  const modAmp = bandAmp(f.modK ?? 1.5, 0.5);
  const octaves = f.octaves.map((o, i) => ({
    ...o,
    g: synthField(bandAmp(o.k, o.bandwidth ?? 0.35), makePhases(spec.seed + 31 * (i + 1))),
    mod: synthField(modAmp, makePhases(spec.seed + 57 * (i + 1))),
  }));
  const warpAmp = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const fy = binFreq(y, N);
    for (let x = 0; x < N; x++) {
      const k = Math.hypot(binFreq(x, N), fy) * N;
      if (k > 0 && k <= (f.warpK ?? 3)) warpAmp[y * N + x] = 1 / (1 + k * k);
    }
  }
  const wx = synthField(warpAmp, makePhases(spec.seed + 13));
  const wy = synthField(warpAmp, makePhases(spec.seed + 17));
  const wrap = (a) => ((a % N) + N) % N;
  const sampleWrapped = (g, px, py) => {
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const fx = px - x0;
    const fy = py - y0;
    const xa = wrap(x0);
    const xb = wrap(x0 + 1);
    const ya = wrap(y0);
    const yb = wrap(y0 + 1);
    const top = g[ya * N + xa] * (1 - fx) + g[ya * N + xb] * fx;
    const bot = g[yb * N + xa] * (1 - fx) + g[yb * N + xb] * fx;
    return top + (bot - top) * fy;
  };
  const out = new Float64Array(N * N);
  const wAmp = (f.warp ?? 0.06) * N;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const px = x + wAmp * wx[i];
      const py = y + wAmp * wy[i];
      let v = 0;
      for (const o of octaves) {
        const g = sampleWrapped(o.g, px, py);
        const m = 0.55 + 0.45 * Math.tanh(sampleWrapped(o.mod, px, py));
        v += o.weight * m * Math.exp(-((g / o.width) ** 2));
      }
      out[i] = v;
    }
  }
  let mean = 0;
  for (const v of out) mean += v;
  mean /= out.length;
  let vari = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    vari += out[i] * out[i];
  }
  const inv = 1 / Math.sqrt(vari / out.length || 1);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Faulting field (field.kind: "faults"): the planar faulting method — sum
 * of random half-plane steps (each fault line raises one side, lowers the
 * other). At low counts the fault lines survive as straight facet edges:
 * level sets are polygonal territories — slate, flagstone, shattered
 * glass. At high counts it converges toward a smooth fractal field. An
 * optional fbm mix erodes the facets' flatness.
 */
function faultsField(f) {
  const rng = mulberry32(spec.seed + 307);
  const out = new Float64Array(N * N);
  const M = f.count ?? 200;
  for (let m = 0; m < M; m++) {
    const th = rng() * Math.PI * 2;
    const nx = Math.cos(th);
    const ny = Math.sin(th);
    const d = nx * (rng() * N) + ny * (rng() * N);
    const a = 1 + (f.ampJitter ?? 0.5) * (rng() * 2 - 1);
    for (let y = 0; y < N; y++) {
      const rowDot = ny * y - d;
      for (let x = 0; x < N; x++) {
        out[y * N + x] += nx * x + rowDot > 0 ? a : -a;
      }
    }
  }
  if (f.fbmWeight) {
    const fbm = synthField(buildAmp(null), makePhases(spec.seed + 7));
    let vari = 0;
    for (const v of out) vari += v * v;
    const sd = Math.sqrt(vari / out.length) || 1;
    for (let i = 0; i < out.length; i++) out[i] = out[i] / sd + f.fbmWeight * fbm[i];
  }
  let mean = 0;
  for (const v of out) mean += v;
  mean /= out.length;
  let vari = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    vari += out[i] * out[i];
  }
  const inv = 1 / Math.sqrt(vari / out.length || 1);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Banded field (field.kind: "banded"): the Perlin-marble construction,
 * cos(carrier + turbulence) — a striped or ringed carrier phase-modulated
 * by a broadband field whose spectrum is this spec's spectrum block. The
 * carrier alone would be a spectral LINE at `bands` c/dia; modulation
 * depth `warp` (in cycles, rms) FM-spreads that line into a broadband
 * ridge — push it past ~1.5 and the audit finds no spike. Linear bands
 * with stretchX are wood figure and damascus; rings are growth rings.
 */
function bandedField(f) {
  const W = synthField(buildAmp(null), makePhases(spec.seed + 7));
  const cx = (f.centerX ?? 0.5) * N;
  const cy = (f.centerY ?? 0.5) * N;
  const oval = f.ovality ?? 1;
  const gamma = f.gamma ?? 1;
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = f.rings ? Math.hypot(x - cx, (y - cy) * oval) / N : x / N;
      const c = Math.cos(2 * Math.PI * (f.bands * u + f.warp * W[i]));
      out[i] = gamma === 1 ? c : Math.sign(c) * Math.pow(Math.abs(c), gamma);
    }
  }
  let mean = 0;
  for (const v of out) mean += v;
  mean /= out.length;
  let vari = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    vari += out[i] * out[i];
  }
  const inv = 1 / Math.sqrt(vari / out.length || 1);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
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
      if (k > 0 && k <= 4) amp[y * N + x] = Math.sqrt(targetPower(k));
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
async function probeCoverage(harness, tipId, level) {
  const s = trainSettings(harness, tipId, level);
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
function trainSettings(harness, tipId, level) {
  // A level may override parts of the train (merged one key deep). The
  // erosion family uses this: its 70–90% masks are near-solid, so they can
  // afford a sparser mask train (no beading variance left to smooth), and
  // need one — at the shared overlap their hairline cracks union shut.
  const o = level?.train ?? {};
  const t = {
    ...spec.train,
    ...o,
    primary: { ...spec.train.primary, ...o.primary },
    dual: { ...spec.train.dual, ...o.dual },
  };
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
console.log(
  `synthesizing ${spec.name}: ${N}px field, ` +
    COMPONENTS.map((b) => `β=${b.beta}@knee ${b.kneeCyclesPerDia}${b.weight ? ` w${b.weight}` : ''}`).join(' + '),
);
const FIELD_KIND = spec.field?.kind ?? 'spectral';
const baseField =
  FIELD_KIND === 'cellular' ? cellularField(spec.field)
  : FIELD_KIND === 'pores' ? poresField(spec.field)
  : FIELD_KIND === 'veins' ? veinsField(spec.field)
  : FIELD_KIND === 'faults' ? faultsField(spec.field)
  : FIELD_KIND === 'banded' ? bandedField(spec.field)
  : synthField(buildAmp(null));

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

// --swatch a,b,c: exploration mode — write the continuous field plus flat
// unvignetted threshold cuts at the given coverages, and stop. For looking
// at candidate textures side by side before any of them earns a family.
const swatchIdx = argv.indexOf('--swatch');
if (swatchIdx >= 0) {
  const covs = argv[swatchIdx + 1].split(',').map((s) => Number(s.trim()));
  const order = Array.from(baseField.keys()).sort((i, j) => baseField[i] - baseField[j]);
  const eq = new Uint8Array(N * N);
  for (let r = 0; r < order.length; r++) eq[order[r]] = Math.round((r / (order.length - 1)) * 255);
  writeFileSync(join(outDir, `${spec.name}.field.png`), encodeGrayPng(eq, N, N));
  const sortedAll = Float64Array.from(baseField).sort();
  for (const pct of covs) {
    const t = sortedAll[clamp(Math.floor((1 - pct / 100) * sortedAll.length), 0, sortedAll.length - 1)];
    const bin = new Float64Array(N * N);
    for (let i = 0; i < bin.length; i++) bin[i] = baseField[i] > t ? 1 : 0;
    const soft = tentBlur(bin, 2);
    const bytes = new Uint8Array(N * N);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(clamp(soft[i], 0, 1) * 255);
    writeFileSync(join(outDir, `${spec.name}.t${pct}.png`), encodeGrayPng(bytes, N, N));
  }
  console.log(`swatches for ${spec.name}: field + t${covs.join(',t')} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
  const corr = spec.spectralCorrection && FIELD_KIND === 'spectral' ? correctionCurve(baseField, baseSorted, level.q) : null;
  const field = corr ? synthField(buildAmp(corr)) : baseField;
  const sorted = corr ? plateauSorted(field) : baseSorted;

  let q = level.q;
  let measured = null;
  let bytes = finishTip(field, sorted, q);

  if (CALIBRATE) {
    for (let iter = 0; iter < 5; iter++) {
      harness.registerTip(name, { size: N, data: bytes });
      measured = await probeCoverage(harness, name, level);
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
