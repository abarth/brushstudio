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
 * Angular window for a band confined to a wedge (`sectorDeg`, the Gaussian
 * half-width in degrees, about `sectorAxisDeg`).
 *
 * `stretchX` squeezes the passband affinely, which turns round blobs into
 * ellipses — elongated lobes, all orientations still present. A wedge
 * instead deletes every orientation but one, and THAT is what makes
 * parallel crests: ripples, drapery folds, combed clay. The axis is the
 * direction of the wavevector, so `sectorAxisDeg: 0` gives crests running
 * vertically (the field varies along x). The spectrum of a real field is
 * centro-symmetric, so the window folds onto a half turn.
 */
function sectorWeight(fx, fy, b) {
  if (fx === 0 && fy === 0) return 0;
  let d = Math.atan2(fy, fx) - ((b.sectorAxisDeg ?? 0) * Math.PI) / 180;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  if (d > Math.PI / 2) d -= Math.PI;
  if (d < -Math.PI / 2) d += Math.PI;
  const t = d / ((b.sectorDeg * Math.PI) / 180);
  return Math.exp(-t * t);
}

const COMPONENTS = (sp.components ?? [sp]).map((b) => {
  // Normalize each band by its per-OCTAVE variance (2-D: ∝ k²·S) at its own
  // shoulder, so `weight` compares the variance the eye sees. Per-mode
  // normalization overweights high-frequency bands by the annulus mode
  // count — a 0.35-weight pit band at k≈22 buried a unit bloom band at
  // k≈2.5 under 27× its variance.
  const anchor = Math.max(b.shoulderCyclesPerDia, b.bandLoCyclesPerDia);
  let norm = 1 / Math.max(bandPower(b, anchor) * anchor * anchor, 1e-30);
  // a wedge keeps only a fraction of the annulus, so divide that fraction
  // out too — otherwise `weight` stops comparing like with like the moment
  // one band is directional and another is not
  if (b.sectorDeg) {
    let acc = 0;
    const STEPS = 720;
    for (let i = 0; i < STEPS; i++) {
      const th = -Math.PI / 2 + (Math.PI * (i + 0.5)) / STEPS;
      acc += sectorWeight(Math.cos(th), Math.sin(th), { ...b, sectorAxisDeg: 0 });
    }
    norm /= Math.max(acc / STEPS, 1e-6);
  }
  return { ...b, norm };
});
/**
 * Target power: a single band, or a weighted sum of them. A material with
 * two characteristic populations — rust's spread patches and its fine
 * pitting, say — is two bands with independent weights; each is normalized
 * at its own shoulder so `weight` compares like with like. Radial only, for
 * the generators that want a plain isotropic curve; `targetPowerAt` is the
 * one the synthesis filter uses.
 */
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
 *
 * `scatterDeconv` decides whether to divide by H at all. It defaults on for
 * a coverage cut and OFF for a tonal mask, because the two shipped trains
 * differ: a tonal mask rides a near-rigid train (docs §6), which does not
 * smear, so 1/H would only pump power into the coarse modes — the splotch
 * band. Turn it back on for a tonal mask deliberately scattered wide, where
 * the mean field really is the tip convolved with the scatter marginal; pair
 * it with `highpassK`, which zeroes the band where 1/H would run away.
 */
const SCATTER_DECONV = spec.scatterDeconv ?? spec.maskMode !== 'tonal';
const S_TIP = SCATTER_DECONV && spec.train?.dual ? spec.train.dual.scatter * (N / 2) : 0;
/**
 * The train's transfer H(f) = 1 − Λ(2πfS)², as the kernel actually behaves
 * — computed from the dual scatter whether or not we deconvolve by it, so
 * a diagram can show what the train does to a spectrum nobody corrected.
 */
function scatterTransferRaw(fPerPx) {
  const S = spec.train?.dual ? spec.train.dual.scatter * (N / 2) : 0;
  if (!S) return 1;
  const L = lambda(2 * Math.PI * fPerPx * S);
  return Math.max(1e-4, 1 - L * L);
}

/** The same, as the synthesis filter uses it: 1 when deconvolution is off. */
function scatterTransfer(fPerPx) {
  if (!S_TIP) return 1;
  const L = lambda(2 * Math.PI * fPerPx * S_TIP);
  return Math.max(1e-4, 1 - L * L);
}

/**
 * Target power at a signed 2-D frequency.
 *
 * `stretchX > 1` squeezes the passband in fx, elongating that band's
 * structure along x: the anisotropy of brushed metal, drag marks, striated
 * stone. `stretchY` is the same on the other axis, so two components
 * stretched on opposite axes cross into a weave. For crests rather than
 * lobes, see `sectorDeg` — anisotropy by deletion, not by squeezing. It reads per component before falling back to the spectrum-wide
 * value, which is what lets one field carry coarse strata stretched flat
 * under isotropic fine grain — anisotropy that changes with scale, the way
 * a real bedded or grained material's does.
 */
function targetPowerAt(fx, fy) {
  let s = 0;
  for (const b of COMPONENTS) {
    const sx = b.stretchX ?? sp.stretchX ?? 1;
    const sy = b.stretchY ?? sp.stretchY ?? 1;
    const k = Math.hypot(fx * sx, fy * sy) * N;
    let p = (b.weight ?? 1) * b.norm * bandPower(b, k);
    if (p > 0 && b.sectorDeg) p *= sectorWeight(fx, fy, b);
    s += p;
  }
  return s;
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
      const fx = binFreq(x, N);
      const p = targetPowerAt(fx, fy);
      if (p <= 0) continue;
      // H is the scatter kernel's own transfer and the kernel is isotropic,
      // so it takes the true radial frequency, never a stretched one
      const f = Math.hypot(fx, fy);
      let a = Math.sqrt(p / scatterTransfer(f));
      if (correction) a *= correction(f * N);
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
function sampleWrapped(g, px, py) {
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const wrap = (a) => ((a % N) + N) % N;
  const xa = wrap(x0);
  const xb = wrap(x0 + 1);
  const ya = wrap(y0);
  const yb = wrap(y0 + 1);
  const top = g[ya * N + xa] * (1 - fx) + g[ya * N + xb] * fx;
  const bot = g[yb * N + xa] * (1 - fx) + g[yb * N + xb] * fx;
  return top + (bot - top) * fy;
}

/**
 * Warped spectral field (field.kind: "warped"): the spectrum block's field
 * resampled through a low-frequency displacement — domain-warped fbm, the
 * advected look of real cloud and smoke that a plain spectrum lacks. warp
 * is displacement as a fraction of tip width; warpK caps the displacement
 * field's band.
 */
function warpedField(f) {
  const base = synthField(buildAmp(null));
  const warpAmp = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const fy = binFreq(y, N);
    for (let x = 0; x < N; x++) {
      const k = Math.hypot(binFreq(x, N), fy) * N;
      if (k > 0 && k <= (f.warpK ?? 2.5)) warpAmp[y * N + x] = 1 / (1 + k * k);
    }
  }
  const wx = synthField(warpAmp, makePhases(spec.seed + 13));
  const wy = synthField(warpAmp, makePhases(spec.seed + 17));
  const wAmp = (f.warp ?? 0.08) * N;
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      out[i] = sampleWrapped(base, x + wAmp * wx[i], y + wAmp * wy[i]);
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
 * Zero every mode below kCut cycles per field width. Structure coarser
 * than the tip is invisible in a swatch but poisonous in a mask train:
 * each stamp shows the whole field, so a coarse light/dark imbalance
 * tints whole stamp footprints — stroke-width splotches under random
 * offsets and mirror flips. Used per-generator (faults' DC-heavy
 * half-plane sum) and spec-wide (spec.highpassK, tonal masks).
 */
function highpassField(field, kCut) {
  const re = Float64Array.from(field);
  const im = new Float64Array(N * N);
  fft2d(re, im, N);
  for (let y = 0; y < N; y++) {
    const fy = binFreq(y, N);
    for (let x = 0; x < N; x++) {
      const k = Math.hypot(binFreq(x, N), fy) * N;
      if (k < kCut) {
        re[y * N + x] = 0;
        im[y * N + x] = 0;
      }
    }
  }
  fft2d(re, im, N, true);
  return re;
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
  // stepAmp scales the half-plane offsets (the mottle); lineWeight lays an
  // explicit ridge of ink ALONG each fault trace, width heavy-tailed in
  // [lineWidthMin, lineWidthMax] px. High lineWeight with low stepAmp is
  // the "linear elements crosscutting a quiet field" reading.
  const stepAmp = f.stepAmp ?? 1;
  for (let m = 0; m < M; m++) {
    const th = rng() * Math.PI * 2;
    const nx = Math.cos(th);
    const ny = Math.sin(th);
    const d = nx * (rng() * N) + ny * (rng() * N);
    const a = stepAmp * (1 + (f.ampJitter ?? 0.5) * (rng() * 2 - 1));
    const lw = f.lineWeight
      ? f.lineWeight * (0.35 + 0.65 * rng())
      : 0;
    const wLo = f.lineWidthMin ?? 1.2;
    const wHi = f.lineWidthMax ?? 6;
    const w = wLo * Math.pow(wHi / wLo, Math.pow(rng(), 2));
    for (let y = 0; y < N; y++) {
      const rowDot = ny * y - d;
      for (let x = 0; x < N; x++) {
        const dist = nx * x + rowDot;
        let v = dist > 0 ? a : -a;
        if (lw) v += lw * Math.exp(-(dist * dist) / (w * w));
        out[y * N + x] += v;
      }
    }
  }
  // Each fault is a GLOBAL half-plane, so the sum is DC-heavy: its coarse
  // imbalance makes a 50%-ish threshold cut nearly half-and-half at tip
  // scale — and a mask like that bares whole stretches of stroke.
  if (f.highpassK) out.set(highpassField(out, f.highpassK));
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

/**
 * Scratch field (field.kind: "scratches"): wear and tear — a point process
 * of finite line segments (gently bent), isotropic in orientation, with
 * heavy-tailed lengths, widths and depths: many faint hairlines, a few long
 * deep gouges. Ink = scratch marks, so sparse thresholds keep only the
 * deepest history of abuse. This is worn metal; manufactured brushing is
 * the spectral stretchX route instead.
 */
function scratchesField(f) {
  const rng = mulberry32(spec.seed + 401);
  const out = new Float64Array(N * N);
  const heavy = (lo, hi, pow) => lo * Math.pow(hi / lo, Math.pow(rng(), pow ?? 2));
  const count = f.count ?? 400;
  for (let m = 0; m < count; m++) {
    const L = heavy(f.lenMin * N, f.lenMax * N);
    const w = heavy(f.widthMin ?? 1.2, f.widthMax ?? 5);
    // depthPow > 1 makes depth heavy-tailed: many faint passes, few gouges
    const dMin = f.depthMin ?? 0.4;
    const depth = dMin + (1 - dMin) * Math.pow(rng(), f.depthPow ?? 1);
    const th = rng() * Math.PI * 2;
    const ax = rng() * N;
    const ay = rng() * N;
    const bx = ax + L * Math.cos(th);
    const by = ay + L * Math.sin(th);
    // a wear history mixes tools: swirlFraction of the scratches take the
    // deep swirl curvature, the rest stay near-linear
    const curv =
      f.swirlFraction && rng() < f.swirlFraction
        ? (f.curvatureSwirl ?? 1)
        : (f.curvature ?? 0.08);
    const bend = curv * L * (rng() * 2 - 1);
    const cx = (ax + bx) / 2 - Math.sin(th) * bend;
    const cy = (ay + by) / 2 + Math.cos(th) * bend;
    const steps = Math.max(2, Math.ceil(L / (0.75 * w)));
    const r = Math.ceil(2 * w);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = (1 - t) * (1 - t) * ax + 2 * t * (1 - t) * cx + t * t * bx;
      const py = (1 - t) * (1 - t) * ay + 2 * t * (1 - t) * cy + t * t * by;
      const x0 = Math.max(0, Math.floor(px - r));
      const x1 = Math.min(N - 1, Math.ceil(px + r));
      const y0 = Math.max(0, Math.floor(py - r));
      const y1 = Math.min(N - 1, Math.ceil(py + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d2 = (x - px) * (x - px) + (y - py) * (y - py);
          out[y * N + x] += depth * Math.exp(-d2 / (w * w));
        }
      }
    }
  }
  if (f.fbmWeight) {
    let vari = 0;
    for (const v of out) vari += v * v;
    const sd = Math.sqrt(vari / out.length) || 1;
    const fbm = synthField(buildAmp(null), makePhases(spec.seed + 7));
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
 * Oriented-domain field (field.kind: "domains"): coarse Worley domains,
 * each filled with ELONGATED angular sub-cells (stretched Worley) aligned
 * to that domain's own random orientation — grain patches in a plank, each
 * running its own way, meeting at angular boundaries. The narrow-aspect
 * sub-cells are what a single global stretch cannot give: stretch is per
 * domain here, so orientation varies across the surface.
 */
function domainsField(f) {
  const rng = mulberry32(spec.seed + 503);
  const coarse = makeWorley(rng, f.cells ?? 6);
  const sub = makeWorley(rng, f.subCells ?? 24);
  const fbm = f.fbmWeight ? synthField(buildAmp(null), makePhases(spec.seed + 7)) : null;
  let wx = null;
  let wy = null;
  if (f.warp) {
    const warpAmp = new Float64Array(N * N);
    for (let y = 0; y < N; y++) {
      const fy = binFreq(y, N);
      for (let x = 0; x < N; x++) {
        const k = Math.hypot(binFreq(x, N), fy) * N;
        if (k > 0 && k <= 4) warpAmp[y * N + x] = 1 / (1 + k * k);
      }
    }
    wx = synthField(warpAmp, makePhases(spec.seed + 13));
    wy = synthField(warpAmp, makePhases(spec.seed + 17));
  }
  const aspect = f.aspect ?? 4;
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const v0 = y / N;
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = x / N + (wx ? f.warp * wx[i] : 0);
      const v = v0 + (wy ? f.warp * wy[i] : 0);
      const dom = worley(coarse, u, v);
      // the domain's own orientation, a pure function of its random value
      const th = dom.v * Math.PI;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const du = u - 0.5;
      const dv = v - 0.5;
      const ua = 0.5 + (du * cs + dv * sn) / aspect; // compressed along grain
      const va = 0.5 + (-du * sn + dv * cs);
      const cell = worley(sub, ua, va);
      let s =
        ((f.domainWeight ?? 0.5) * (dom.v - 0.5)) / 0.2887 +
        ((f.cellWeight ?? 1) * (cell.v - 0.5)) / 0.2887;
      if (f.wallDepth) s -= f.wallDepth * smoothstep(f.wallWidth ?? 0.06, 0, dom.f2 - dom.f1);
      if (fbm) s += f.fbmWeight * fbm[i];
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

/**
 * Tonal mask (spec.maskMode: "tonal"): instead of a threshold cut, the tip
 * carries the tone-mapped field itself, so the gated stroke is the texture
 * as graded alpha — damage as a DELTA from the intact material, with
 * `depth` the damage dial (moderate damage = moderate contrast).
 *
 * Two deconvolutions make the painted stroke match the designed field:
 * - value curve: the mask over-composites ≈ n̄ overlapping stamps
 *   (m = 1 − Π(1 − v)), so each stamp carries v = 1 − (depth·damage)^(1/n̄)
 *   and the accumulated mask lands on 1 − depth·damage;
 * - the spectral 1/H pre-compensation already in the field's fbm band.
 *
 * damage01 mapping: "modulate" rank-equalizes the field (domain materials —
 * every value populated, depth sets the visible contrast); "delta" ramps
 * from the field's median to its 99.5th percentile, so a mostly-background
 * field (scratches) leaves the baseline untouched at exactly 0 damage.
 *
 * `gain` and `floor` exist because that value curve inverts the MEAN and
 * nothing else. Put the accumulation in logs and what the mask computes is
 * the geometric mean of the stamps' damages:
 *
 *   ln(1 − m) = Σ ln(1 − vᵢ) = ln depth + (1/n̄)·Σ ln dᵢ
 *   ⇒ 1 − m = depth · GM(d)
 *
 * which says two things. The log-contrast of n̄ near-independent samples
 * falls as 1/√n̄, so a deep train delivers a flatter mark than the field
 * asks for — `gain` puts it back by stretching ln d about its own mean,
 * `d ← G·(d/G)^gain` with `G` the field's geometric mean. Stretching about
 * G rather than raising d to a power is the whole point: a bare `d^gain`
 * scales the spread and the mean together, which lightens the mark instead
 * of sharpening it. `gain ≈ √n̄` for fully independent stamps, less when
 * the scatter is short against the field's correlation length — tune it
 * against the audit's `texture %`. And a geometric mean is dragged to zero
 * by any one near-zero sample, so a single stamp landing its field minimum
 * punches a full-ink speck through the whole stack: `floor` bounds ln d
 * from below and the specks go away. Both default to inert.
 */
/**
 * The damage map the tonal mask is designed to carve: 0 = intact material,
 * 1 = fully carved. Shared by the tip synthesis and the `--field` preview,
 * so what the atlas shows and what the brush paints are the same function.
 */
function damageMap(field, sorted, { ignoreGain = false } = {}) {
  const t0 = spec.tonal ?? {};
  const t = ignoreGain ? { ...t0, gain: 1 } : t0;
  const mode = t.mode ?? 'modulate';
  const delta = mode === 'delta';
  const lo = delta ? sorted[Math.floor(sorted.length * 0.5)] : 0;
  const hi = delta ? sorted[Math.floor(sorted.length * 0.995)] : 1;
  // rank01 via the plateau-sorted table: binary search per pixel is fine
  const rank01 = (v) => {
    let a = 0;
    let b = sorted.length - 1;
    while (a < b) {
      const m = (a + b) >> 1;
      if (sorted[m] < v) a = m + 1;
      else b = m;
    }
    return a / (sorted.length - 1);
  };
  // "lognormal": damage = e^(σ·field), the multiplicative cascade. The mask
  // accumulates a GEOMETRIC mean, so a lognormal damage map is this
  // architecture's exact fixed point — averaging n windows leaves the
  // distribution lognormal with σ/√n, which `gain` puts back exactly. A
  // uniform (rank) map does not survive that averaging in shape, only in
  // rank order. σ sets intermittency: the median lands at e^(−2.58σ) of
  // full damage, so the field reads as mostly-intact with rare deep bites.
  const sigma = t.sigma ?? 1;
  const top = sorted[Math.floor(sorted.length * 0.995)];
  const damageAt = (i) => {
    let d;
    if (mode === 'lognormal') d = Math.exp(sigma * (field[i] - top));
    else if (delta) d = clamp((field[i] - lo) / Math.max(hi - lo, 1e-9), 0, 1);
    else d = rank01(field[i]);
    d = clamp(d, 0, 1);
    // invert: the STRUCTURE keeps full paint and the ground carves — a
    // mid-tone material with darker marks (scratches as shadowed gouges)
    // instead of a solid material with lightened marks
    if (t.invert) d = 1 - d;
    return t.floor ? t.floor + (1 - t.floor) * d : d;
  };
  // the geometric mean the accumulation lands on, so `gain` can stretch the
  // log-contrast about it without moving the mark's tone
  let logG = 0;
  if (t.gain && t.gain !== 1) {
    for (let i = 0; i < field.length; i++) logG += Math.log(Math.max(damageAt(i), 1e-12));
    logG /= field.length;
  }
  const G = Math.exp(logG);
  const out = new Float64Array(field.length);
  for (let i = 0; i < field.length; i++) {
    const d = damageAt(i);
    out[i] =
      t.gain && t.gain !== 1 ? clamp(G * Math.pow(d / G, t.gain), t.floor ?? 1e-12, 1) : d;
  }
  return out;
}

/** Damage map → stamp values, with the train's value curve and the vignette. */
function tonalTip(field, sorted, depth) {
  const nBar = 0.8 / ((spec.train.dual.spacing ?? 0.33) * 0.95);
  const damage = damageMap(field, sorted);
  const data = new Uint8Array(N * N);
  for (let i = 0; i < damage.length; i++) {
    const carve = depth * damage[i];
    const v = 1 - Math.pow(Math.max(carve, 1e-12), 1 / nBar) * (carve > 0 ? 1 : 0);
    data[i] = Math.round(clamp(v * (vignette ? vignette[i] : 1), 0, 1) * 255);
  }
  return data;
}

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
let baseField =
  FIELD_KIND === 'cellular' ? cellularField(spec.field)
  : FIELD_KIND === 'pores' ? poresField(spec.field)
  : FIELD_KIND === 'veins' ? veinsField(spec.field)
  : FIELD_KIND === 'faults' ? faultsField(spec.field)
  : FIELD_KIND === 'banded' ? bandedField(spec.field)
  : FIELD_KIND === 'scratches' ? scratchesField(spec.field)
  : FIELD_KIND === 'domains' ? domainsField(spec.field)
  : FIELD_KIND === 'warped' ? warpedField(spec.field)
  : synthField(buildAmp(null));
/**
 * Domain warp over any finished field: displace each sample by a smooth
 * low-frequency vector field. Straight crests bend into flow lines, whorls
 * and grain running round a knot — the one way to give a spectral texture
 * large-scale organisation, since a stationary spectrum has none by
 * construction.
 *
 * Note what this costs. A warped field is no longer stationary Gaussian:
 * the curves are PHASE, and a deep mask train averages independent windows,
 * so they blend away (math doc §6). A warped spectrum therefore belongs on
 * the shallow rigid train with the generator textures, not on the deep
 * scattered one — the warp moves a texture across the atlas's central line.
 */
function warpField(field, amp, kMax) {
  const warpAmp = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const fy = binFreq(y, N);
    for (let x = 0; x < N; x++) {
      const k = Math.hypot(binFreq(x, N), fy) * N;
      if (k > 0 && k <= kMax) warpAmp[y * N + x] = 1 / (1 + k * k);
    }
  }
  const wx = synthField(warpAmp, makePhases(spec.seed + 901));
  const wy = synthField(warpAmp, makePhases(spec.seed + 907));
  const out = new Float64Array(N * N);
  const a = amp * N;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      out[i] = sampleWrapped(field, x + a * wx[i], y + a * wy[i]);
    }
  }
  return out;
}

if (spec.highpassK) baseField = highpassField(baseField, spec.highpassK);
if (spec.warp) baseField = warpField(baseField, spec.warp.amp ?? 0.05, spec.warp.k ?? 3);

/**
 * --diagram: write what the synthesis filter is actually doing, as three
 * centred log-power panels (target S★, the train's transfer H, and the
 * deconvolved S★/H that gets synthesized) plus the radial curves behind
 * them. The spectrum lab draws its plot from the JSON; the panels are the
 * anisotropy story a radial average cannot tell — a wedge is two lobes, a
 * ring is an annulus, and H is the isotropic hole they sit in.
 */
function writeDiagram() {
  const P = 160;
  // Per-panel zoom, because the two things being compared live a decade
  // apart: the texture band runs out to tens of cycles per diameter, while
  // H does all of its rising below ~5. One shared frame renders H as a flat
  // white square, which is true and useless.
  const K_SHOW = [40, 8, 40];
  const panels = [];
  const grab = (fn, kShow) => {
    const v = new Float64Array(P * P);
    for (let y = 0; y < P; y++) {
      const ky = ((y + 0.5) / P - 0.5) * 2 * kShow;
      for (let x = 0; x < P; x++) {
        const kx = ((x + 0.5) / P - 0.5) * 2 * kShow;
        v[y * P + x] = fn(kx / N, ky / N);
      }
    }
    return v;
  };
  const target = grab((fx, fy) => targetPowerAt(fx, fy), K_SHOW[0]);
  const transfer = grab((fx, fy) => scatterTransferRaw(Math.hypot(fx, fy)), K_SHOW[1]);
  const deconv = grab(
    (fx, fy) => targetPowerAt(fx, fy) / Math.max(scatterTransfer(Math.hypot(fx, fy)), 1e-12),
    K_SHOW[2],
  );
  const logNorm = (v) => {
    let lo = Infinity;
    let hi = -Infinity;
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) {
      out[i] = Math.log10(v[i] + 1e-14);
      if (v[i] > 0) {
        lo = Math.min(lo, out[i]);
        hi = Math.max(hi, out[i]);
      }
    }
    lo = Math.max(lo, hi - 6); // six decades is all the eye can use
    return out.map((x) => clamp((x - lo) / (hi - lo || 1), 0, 1));
  };
  panels.push(logNorm(target), transfer, logNorm(deconv));
  const strip = new Uint8Array(P * 3 * P);
  panels.forEach((pan, i) => {
    for (let y = 0; y < P; y++) {
      for (let x = 0; x < P; x++) strip[y * (P * 3) + i * P + x] = Math.round(pan[y * P + x] * 255);
    }
  });
  writeFileSync(join(outDir, `${spec.name}.diagram.png`), encodeGrayPng(strip, P * 3, P));

  // radial curves: angular mean of the target, so a wedge reads as the
  // fraction of the annulus it keeps rather than as its peak
  const radial = [];
  for (let i = 0; i <= 96; i++) {
    const k = 0.4 * Math.pow(120 / 0.4, i / 96);
    let acc = 0;
    const STEPS = 96;
    for (let a = 0; a < STEPS; a++) {
      const th = (Math.PI * (a + 0.5)) / STEPS;
      acc += targetPowerAt((k * Math.cos(th)) / N, (k * Math.sin(th)) / N);
    }
    const t = acc / STEPS;
    const h = scatterTransferRaw(k / N);
    radial.push({ k: +k.toFixed(3), target: t, transfer: h, deconv: t / Math.max(scatterTransfer(k / N), 1e-12) });
  }
  const dual = spec.train?.dual;
  writeFileSync(
    join(outDir, `${spec.name}.diagram.json`),
    JSON.stringify(
      {
        kShow: K_SHOW,
        deconvolved: SCATTER_DECONV && !!dual,
        // the train's comb sits at 1/spacing cycles per mask diameter, the
        // same units as k here; the scatter cloud's own scale is 2/scatter
        combCyclesPerDia: dual ? +(1 / dual.spacing).toFixed(2) : null,
        scatterCyclesPerDia: dual?.scatter ? +(2 / dual.scatter).toFixed(2) : null,
        radial,
      },
      null,
      1,
    ),
  );
}

if (argv.includes('--diagram')) writeDiagram();

if (spec.output === 'pattern') {
  // A texture-channel pattern: tileable by FFT construction, no vignette,
  // no threshold. Default is rank-equalization to a uniform histogram so
  // the subtract-mode contact model (docs §9: inked where v > 1 − a) turns
  // the pattern's value distribution into an identity — stroke coverage
  // then tracks accumulated alpha directly. A spec may instead ask for a
  // soft linear tone (`tone.gain`, value ≈ 0.15–0.3): flatter contrast for
  // patterns meant to read as gentle surface modulation.
  const data = toneBytes(baseField);
  const out = join(outDir, `${spec.name}.png`);
  writeFileSync(out, encodeGrayPng(data, N, N));
  console.log(`  ${out}  (tileable pattern, equalized)  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

/** Field → bytes: rank-equalized by default, or soft linear via tone.gain. */
function toneBytes(field) {
  const data = new Uint8Array(N * N);
  if (spec.tone?.gain) {
    const g = spec.tone.gain;
    for (let i = 0; i < field.length; i++) {
      data[i] = Math.round(clamp(0.5 + g * field[i], 0, 1) * 255);
    }
    return data;
  }
  const order = Array.from(field.keys()).sort((i, j) => field[i] - field[j]);
  for (let rank = 0; rank < order.length; rank++) {
    data[order[rank]] = Math.round((rank / (order.length - 1)) * 255);
  }
  return data;
}

// --field [depth]: atlas mode — write the damage map as the tone a stroke
// would carry (ink on paper at that depth), and stop. For a spectral
// texture on a deep train the stroke reproduces the field, so this is a
// faithful preview at a fraction of the cost of painting one; it is how
// docs/spectral-atlas.md sweeps candidates before any of them is painted.
const fieldIdx = argv.indexOf('--field');
if (fieldIdx >= 0) {
  const depth = Number(argv[fieldIdx + 1]) || 0.55;
  // gain is a compensation for the train's averaging, not a design choice:
  // the stroke is meant to land on the UNGAINED design, so that is what a
  // swatch should show
  const damage = damageMap(baseField, plateauSorted(baseField), { ignoreGain: true });
  const bytes = new Uint8Array(N * N);
  for (let i = 0; i < damage.length; i++) {
    // ink = 1 − depth·damage; shown as ink on white, like every other crop
    bytes[i] = Math.round(clamp(depth * damage[i], 0, 1) * 255);
  }
  const out = join(outDir, `${spec.name}.field.png`);
  writeFileSync(out, encodeGrayPng(bytes, N, N));
  console.log(`  ${out}  (damage at depth ${depth})  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

// --swatch a,b,c: exploration mode — write the continuous field plus flat
// unvignetted threshold cuts at the given coverages, and stop. For looking
// at candidate textures side by side before any of them earns a family.
const swatchIdx = argv.indexOf('--swatch');
if (swatchIdx >= 0) {
  const covs = argv[swatchIdx + 1].split(',').map((s) => Number(s.trim()));
  writeFileSync(join(outDir, `${spec.name}.field.png`), encodeGrayPng(toneBytes(baseField), N, N));
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
  let bytes;
  if (spec.maskMode === 'tonal') {
    // deterministic: the depth dial needs no coverage calibration
    bytes = tonalTip(field, sorted, level.depth);
  } else {
    bytes = finishTip(field, sorted, q);
  }

  if (CALIBRATE && spec.maskMode !== 'tonal') {
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
    q: spec.maskMode === 'tonal' ? `depth ${level.depth}` : q.toFixed(4),
    tipInk: (inkSum / 255 / bytes.length).toFixed(4),
    core: measured === null ? '—' : measured.core.toFixed(4),
    box: measured === null ? '—' : measured.box.toFixed(4),
  });
  console.log(
    `  ${name}.png  ${spec.maskMode === 'tonal' ? `depth=${level.depth}` : `q=${q.toFixed(4)}`}  ` +
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
