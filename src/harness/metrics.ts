import type { PointerSample } from '../brush/dynamics';
import type { BrushSettings } from '../brush/types';
import { brushReach } from './strokes';
import { cpuBackend, Surface, type BackendFactory } from './surface';

/**
 * Numbers for the parts of a mark the eye is bad at.
 *
 * Every probe paints on a transparent ground, so the alpha channel *is* the
 * ink the brush laid down — no ground colour, no blend mode, nothing to
 * unpick. Each measurement below answers one question a designer actually
 * asks while tuning, and each is reported on its own scale rather than
 * folded into a single score, because "too grainy" and "too thin" want
 * opposite fixes.
 */

export interface BandStats {
  /** fraction of the mark's band carrying meaningful ink (holes vs. solid) */
  coverage: number;
  /** mean alpha where there IS ink — thin glaze vs. loaded paint */
  density: number;
  /** mean alpha over the whole band: coverage * density */
  ink: number;
  /**
   * std/mean of alpha inside the mark — the grain of the mark.
   *
   * Read it with care on a narrow mark. The band is everything above the
   * ink floor, which on a soft tip includes the two rows of falloff at the
   * edges, and on a mark only a few pixels wide those rows dominate the
   * spread: whether they clear the floor flips on a fraction of a pixel of
   * tip size, and the number can move several-fold without the texture
   * changing at all. To ask what a texture is doing, measure the same
   * stroke with `texture.enabled` off and compare the ink.
   */
  grain: number;
}

export interface RepetitionStats {
  /**
   * How far the strongest periodic line stands above the rest of the
   * spectrum. Texture is broadband and lands near 1; a tip stamping the
   * same mark at a fixed interval puts a spike there instead.
   */
  prominence: number;
  /** that line's ripple depth as a fraction of mean ink — what the eye sees */
  amplitude: number;
  /** its period, as a fraction of tip diameter */
  periodInDiameters: number;
  /** longest run of near-bare columns, in tip diameters */
  worstGap: number;
}

export interface DabStats {
  /** ink bounding box of one full-pressure dab, in pixels */
  boxPx: [number, number];
  /** bounding box at half the dab's peak alpha — the mark's "solid" core */
  coreBoxPx: [number, number];
  peakAlpha: number;
  /**
   * Mean alpha in 10 bands from the centre out to the edge of the mark,
   * measured on the mark's own axes so an elongated tip is not averaged
   * against the empty corners of a circle.
   */
  radialProfile: number[];
  /**
   * Distance from 90% to 10% of peak alpha, as a fraction of the radius —
   * the falloff width, i.e. what Hardness actually controls.
   */
  edgeWidth: number;
}

export interface PoseStats {
  /** how far the pen was laid over for these marks, in degrees */
  tiltDeg: number;
  /**
   * One straight stroke per heading, the heading measured from the pen's
   * own barrel: 0 is drawn along the barrel (the way a pencil is pulled
   * behind the hand), 90 across it.
   */
  headings: { offBarrelDeg: number; widthPx: number; ink: number }[];
  /** widest heading over narrowest — 1 means the pose does not shape the mark */
  anisotropy: number;
  /** which heading came out narrowest, in degrees off the barrel */
  narrowestDeg: number;
  /**
   * Whether that pattern belongs to the pen or to the canvas. The fan is
   * drawn twice with the barrel 90 degrees apart: a tip bound to the pose
   * keeps its narrow mark on the barrel and the two fans agree, a tip at a
   * fixed angle keeps it on the canvas and they do not.
   */
  followsPen: boolean;
}

export interface BrushMetrics {
  size: number;
  flat: BandStats & { widthPx: number };
  repetition: RepetitionStats;
  dab: DabStats;
  /** measured ink of a single stroke, per pressure step 10%..100% */
  pressureResponse: { pressure: number; widthPx: number; ink: number }[];
  /** width against heading for one fixed pen pose — what tilt does to a mark */
  pose: PoseStats;
  /**
   * Ink after 1 / 2 / 4 passes over the same path. The ratio says whether
   * the brush keeps accumulating; the absolute ink says what it accumulates
   * *to*, which is the number to read against an opacity cap.
   */
  buildup: { passes: number; ink: number; ratio: number }[];
  /** spread of total ink across seeds — how much randomness moves the mark */
  seedSpread: { mean: number; cv: number };
  warnings: string[];
}

const INK_FLOOR = 8; // alpha under this reads as bare paper

function bandStats(alpha: Uint8Array, w: number, box: Box): BandStats {
  let inked = 0;
  let sum = 0;
  let sumInked = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const a = alpha[y * w + x] / 255;
      sum += a;
      n++;
      if (a * 255 >= INK_FLOOR) {
        inked++;
        sumInked += a;
        sumSq += a * a;
      }
    }
  }
  if (n === 0) return { coverage: 0, density: 0, ink: 0, grain: 0 };
  const coverage = inked / n;
  const density = inked ? sumInked / inked : 0;
  const variance = inked ? Math.max(0, sumSq / inked - density * density) : 0;
  return {
    coverage,
    density,
    ink: sum / n,
    grain: density > 0 ? Math.sqrt(variance) / density : 0,
  };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Tight bounding box of everything at or above `floor`. */
function inkBox(alpha: Uint8Array, w: number, h: number, floor = INK_FLOOR): Box | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] >= floor) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < x0 ? null : { x0, y0, x1, y1 };
}

/** Per-column ink sums across a horizontal band. */
function columnInk(alpha: Uint8Array, w: number, box: Box): Float64Array {
  const out = new Float64Array(box.x1 - box.x0 + 1);
  for (let x = box.x0; x <= box.x1; x++) {
    let s = 0;
    for (let y = box.y0; y <= box.y1; y++) s += alpha[y * w + x];
    out[x - box.x0] = s / 255;
  }
  return out;
}

/**
 * Periodicity of the ink along the stroke — the "wallpaper" artifact, and
 * the most common reason a hand-built brush reads as fake.
 *
 * Plain autocorrelation is the obvious tool and the wrong one: a grainy tip
 * correlates strongly with itself at short lags whether or not it repeats,
 * so every textured brush scores as periodic. A repeating stamp is instead a
 * narrow LINE in the spectrum, so what is measured here is how far the
 * strongest line rises above the broadband floor, plus how deep that ripple
 * actually is relative to the ink around it. Grain moves the floor; only
 * repetition moves the peak.
 */
function repetition(col: Float64Array, diameter: number): RepetitionStats {
  const n = col.length;
  const mean = col.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const gap = worstBareRun(col, diameter);
  if (n < 64 || mean <= 0 || diameter <= 0) {
    return { prominence: 0, amplitude: 0, periodInDiameters: 0, worstGap: gap };
  }

  // Hann window, so a line that does not sit exactly on a bin does not
  // smear across half the spectrum.
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    win[i] = (col[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }

  // Only periods a viewer could read as a beat: a few pixels up to a few
  // tip diameters. Anything longer is the stroke's own shape.
  const minPeriod = Math.max(4, diameter * 0.1);
  const maxPeriod = Math.min(n / 4, diameter * 6);
  const kMin = Math.max(1, Math.ceil(n / maxPeriod));
  const kMax = Math.min(Math.floor(n / 2), Math.floor(n / minPeriod));
  if (kMax <= kMin) {
    return { prominence: 0, amplitude: 0, periodInDiameters: 0, worstGap: gap };
  }

  const power: number[] = [];
  let bestK = kMin;
  let bestPower = -1;
  for (let k = kMin; k <= kMax; k++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      re += win[i] * Math.cos(w * i);
      im -= win[i] * Math.sin(w * i);
    }
    const p = re * re + im * im;
    power.push(p);
    if (p > bestPower) {
      bestPower = p;
      bestK = k;
    }
  }
  const sorted = [...power].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length / 2)] || 1e-12;
  // Hann's coherent gain is 1/2, so a sinusoid of amplitude A peaks at A*n/4.
  const amplitude = (4 * Math.sqrt(bestPower)) / n / mean;

  // An even stroke has no ripple to be prominent ABOUT: its spectrum is
  // numerical dust, and dust divided by smaller dust is a huge meaningless
  // ratio. Below a ripple the eye could not see, report no periodicity.
  if (amplitude < 0.02) {
    return { prominence: 0, amplitude: 0, periodInDiameters: 0, worstGap: gap };
  }

  return {
    prominence: bestPower / floor,
    amplitude,
    periodInDiameters: n / bestK / diameter,
    worstGap: gap,
  };
}

/**
 * Longest stretch the stroke goes nearly bare.
 *
 * Judging it relative to the stroke's own ink matters: on a soft tip a break
 * still carries a little colour, so a test for empty columns misses exactly
 * the breaks an eye picks out. The reference level is the upper quartile
 * rather than the median, because a stroke that is half gap drags its own
 * median down into the gaps and then reports none of them.
 */
function worstBareRun(col: Float64Array, diameter: number): number {
  if (col.length === 0 || diameter <= 0) return 0;
  const sorted = [...col].sort((a, b) => a - b);
  const inked = sorted[Math.floor(sorted.length * 0.75)];
  let run = 0;
  let worst = 0;
  for (const v of col) {
    run = v < inked * 0.4 ? run + 1 : 0;
    if (run > worst) worst = run;
  }
  return worst / diameter;
}

function dabStats(alpha: Uint8Array, w: number, h: number, cx: number, cy: number): DabStats {
  const box = inkBox(alpha, w, h);
  if (!box) {
    return {
      boxPx: [0, 0],
      coreBoxPx: [0, 0],
      peakAlpha: 0,
      radialProfile: new Array(10).fill(0),
      edgeWidth: 0,
    };
  }
  let peak = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const a = alpha[y * w + x];
      if (a > peak) peak = a;
    }
  }
  const core = inkBox(alpha, w, h, Math.max(INK_FLOOR, peak * 0.5)) ?? box;

  // Normalise by each axis of the ink box: a chisel mark is 3:1, and a
  // circular profile over it would average mostly bare paper.
  const rx = (box.x1 - box.x0 + 1) / 2 || 1;
  const ry = (box.y1 - box.y0 + 1) / 2 || 1;
  const bins = new Float64Array(10);
  const counts = new Float64Array(10);
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const r = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      if (r > 1) continue;
      const b = Math.min(9, Math.floor(r * 10));
      bins[b] += alpha[y * w + x] / 255;
      counts[b]++;
    }
  }
  const profile = Array.from(bins, (v, i) => (counts[i] ? v / counts[i] : 0));

  // Where the profile crosses 90% and 10% of its own peak: the falloff band.
  const top = Math.max(...profile);
  const cross = (frac: number): number => {
    const level = top * frac;
    for (let i = 1; i < profile.length; i++) {
      if (profile[i] <= level) {
        const span = profile[i - 1] - profile[i];
        const t = span > 0 ? (profile[i - 1] - level) / span : 0;
        return (i - 1 + t) / profile.length;
      }
    }
    return 1;
  };
  return {
    boxPx: [box.x1 - box.x0 + 1, box.y1 - box.y0 + 1],
    coreBoxPx: [core.x1 - core.x0 + 1, core.y1 - core.y0 + 1],
    peakAlpha: +(peak / 255).toFixed(4),
    radialProfile: profile.map((v) => +v.toFixed(4)),
    edgeWidth: +Math.max(0, cross(0.1) - cross(0.9)).toFixed(4),
  };
}

/**
 * The pen pose the fan is drawn with, and the headings it is drawn at.
 *
 * 45 degrees is a pencil riding on its worn facet rather than its point,
 * and 30-degree steps resolve a narrow axis well enough to say which
 * heading it is on without paying for twelve strokes.
 */
const POSE_TILT_DEG = 45;
const POSE_HEADINGS = [0, 30, 60, 90, 120, 150];

/**
 * How wide a straight stroke is across its own direction.
 *
 * The plate's `flat` width is the ink box's height, which only means width
 * for a horizontal stroke; a fan needs the same number for a stroke running
 * any which way. Ink is binned by perpendicular distance from the stroke's
 * spine over its steady middle, so the entry and exit dabs — which are
 * round on a tapered brush and would widen the reading — stay out of it.
 */
function acrossWidth(
  alpha: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  heading: number,
  len: number,
): { widthPx: number; ink: number } {
  const dx = Math.cos(heading);
  const dy = Math.sin(heading);
  const half = len * 0.35;
  const profile = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = alpha[y * w + x];
      if (a === 0) continue;
      const ux = x + 0.5 - cx;
      const uy = y + 0.5 - cy;
      if (Math.abs(ux * dx + uy * dy) > half) continue;
      const k = Math.round(uy * dx - ux * dy);
      profile.set(k, (profile.get(k) ?? 0) + a / 255);
    }
  }
  if (profile.size === 0) return { widthPx: 0, ink: 0 };
  const run = half * 2;
  let peak = 0;
  let ink = 0;
  for (const v of profile.values()) {
    const mean = v / run;
    if (mean > peak) peak = mean;
    ink += mean;
  }
  // A tenth of the mark's own peak, floored at the bare-paper level: a soft
  // tip has no edge to find, and a scattered one throws single dabs well
  // outside the mark that would otherwise count as its width.
  const level = Math.max(INK_FLOOR / 255, peak * 0.1);
  const kept = [...profile.entries()].filter(([, v]) => v / run >= level).map(([k]) => k);
  if (kept.length === 0) return { widthPx: 0, ink: +ink.toFixed(3) };
  return {
    widthPx: Math.max(...kept) - Math.min(...kept) + 1,
    ink: +ink.toFixed(3),
  };
}

/**
 * What the pen's pose does to the mark.
 *
 * Every other probe here paints with the pen upright, which is the honest
 * default — most brushes ignore tilt — but it means a pose-driven brush
 * measures identically to one that is not. This draws a fan of straight
 * strokes with the pen held in one pose and the heading turning, twice,
 * with the barrel 90 degrees apart. Width against heading says how much the
 * pose shapes the mark; the two fans agreeing in pen-relative terms says
 * the shaping belongs to the pen rather than to the canvas.
 */
async function poseResponse(
  settings: BrushSettings,
  backend: BackendFactory,
  size: number,
  reach: number,
): Promise<PoseStats> {
  const len = Math.max(size * 4, 48);
  const pad = Math.min(reach, size * 2) + 20;
  const side = Math.ceil(len + pad * 2);
  const surface = await Surface.create(side, side, backend);
  const c = side / 2;
  const step = Math.max(1.5, size / 14);
  const fans: { widthPx: number; ink: number }[][] = [];
  for (const azimuth of [0, 90]) {
    const tiltX = POSE_TILT_DEG * Math.cos((azimuth * Math.PI) / 180);
    const tiltY = POSE_TILT_DEG * Math.sin((azimuth * Math.PI) / 180);
    const fan: { widthPx: number; ink: number }[] = [];
    for (const off of POSE_HEADINGS) {
      const heading = ((azimuth + off) * Math.PI) / 180;
      const pts: PointerSample[] = [];
      for (let d = -len / 2; d <= len / 2; d += step) {
        pts.push({
          x: c + Math.cos(heading) * d,
          y: c + Math.sin(heading) * d,
          pressure: 0.8,
          tiltX,
          tiltY,
          twist: 0,
        });
      }
      surface.clear();
      surface.paint(settings, pts, { seed: 55 });
      fan.push(acrossWidth(await surface.readAlpha(), side, side, c, c, heading, len));
    }
    fans.push(fan);
  }
  surface.destroy();

  const widths = fans[0].map((f) => f.widthPx);
  const turned = fans[1].map((f) => f.widthPx);
  const min = Math.min(...widths);
  const max = Math.max(...widths);
  const spread = max - min;
  const disagreement = Math.max(...widths.map((v, i) => Math.abs(v - turned[i])));
  return {
    tiltDeg: POSE_TILT_DEG,
    headings: POSE_HEADINGS.map((offBarrelDeg, i) => ({ offBarrelDeg, ...fans[0][i] })),
    anisotropy: min > 0 ? +(max / min).toFixed(2) : 0,
    narrowestDeg: POSE_HEADINGS[widths.indexOf(min)],
    // A pixel of slop either way, and a third of the spread on top: the two
    // fans are painted at different canvas angles, so a mark that is
    // genuinely pen-bound still lands on the pixel grid differently.
    followsPen: spread > 1 && disagreement <= Math.max(1.5, spread * 0.35),
  };
}

const line = (
  x0: number,
  x1: number,
  y: number,
  pressure: number,
  step: number,
): PointerSample[] => {
  const pts: PointerSample[] = [];
  for (let x = x0; x <= x1; x += step) {
    pts.push({ x, y, pressure, tiltX: 0, tiltY: 0, twist: 0 });
  }
  return pts;
};

/**
 * Runs the probe suite. `seeds` trades run time for a more honest picture of
 * a brush whose dynamics are random: one seed of a scattered brush can look
 * lucky or unlucky by chance.
 */
export async function measureBrush(
  settings: BrushSettings,
  opts: { seeds?: number; backend?: BackendFactory } = {},
): Promise<BrushMetrics> {
  const seeds = Math.max(1, opts.seeds ?? 4);
  const size = settings.tip.size;
  const pad = Math.ceil(size * 2 + 40);
  const runLen = Math.ceil(Math.max(size * 12, 700));
  const w = runLen + pad * 2;
  const h = Math.ceil(size * 4 + 80);
  const step = Math.max(1.5, size / 14);
  const surface = await Surface.create(w, h, opts.backend ?? cpuBackend);
  const warnings: string[] = [];
  const mid = h / 2;

  // --- flat stroke, averaged over seeds -------------------------------------
  let flatAgg: BandStats = { coverage: 0, density: 0, ink: 0, grain: 0 };
  let widthPx = 0;
  let rep: RepetitionStats = {
    prominence: 0,
    amplitude: 0,
    periodInDiameters: 0,
    worstGap: 0,
  };
  const seedInk: number[] = [];
  for (let s = 0; s < seeds; s++) {
    surface.clear();
    surface.paint(settings, line(pad, pad + runLen, mid, 0.8, step), { seed: 100 + s });
    const alpha = await surface.readAlpha();
    const box = inkBox(alpha, w, h);
    if (!box) {
      warnings.push('the flat stroke deposited no ink at all');
      break;
    }
    // measure inside the steady middle, away from the entry/exit dabs
    const inset = Math.round((box.x1 - box.x0) * 0.08);
    const band: Box = { ...box, x0: box.x0 + inset, x1: box.x1 - inset };
    const st = bandStats(alpha, w, band);
    flatAgg = {
      coverage: flatAgg.coverage + st.coverage / seeds,
      density: flatAgg.density + st.density / seeds,
      ink: flatAgg.ink + st.ink / seeds,
      grain: flatAgg.grain + st.grain / seeds,
    };
    widthPx += (box.y1 - box.y0 + 1) / seeds;
    const r = repetition(columnInk(alpha, w, band), size);
    // report the worst seed: a break is a chance event and one is enough to see
    if (r.amplitude > rep.amplitude) rep = { ...r, worstGap: rep.worstGap };
    if (r.worstGap > rep.worstGap) rep.worstGap = r.worstGap;
    seedInk.push(st.ink);
  }

  // --- one dab, full pressure ----------------------------------------------
  surface.clear();
  const dcx = w / 2;
  surface.paint(settings, [{ x: dcx, y: mid, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 }], {
    seed: 7,
  });
  const dab = dabStats(await surface.readAlpha(), w, h, dcx, mid);

  // --- pressure response ---------------------------------------------------
  const pressureResponse: BrushMetrics['pressureResponse'] = [];
  for (let i = 1; i <= 10; i++) {
    const pressure = i / 10;
    surface.clear();
    surface.paint(settings, line(pad, pad + runLen * 0.5, mid, pressure, step), { seed: 21 });
    const alpha = await surface.readAlpha();
    const box = inkBox(alpha, w, h);
    pressureResponse.push({
      pressure,
      widthPx: box ? box.y1 - box.y0 + 1 : 0,
      ink: box ? +bandStats(alpha, w, box).ink.toFixed(4) : 0,
    });
  }

  // --- build-up over repeated passes ---------------------------------------
  const buildup: BrushMetrics['buildup'] = [];
  let base = 0;
  for (const passes of [1, 2, 4]) {
    surface.clear();
    for (let p = 0; p < passes; p++) {
      surface.paint(settings, line(pad, pad + runLen * 0.5, mid, 0.8, step), { seed: 33 + p });
    }
    const alpha = await surface.readAlpha();
    const box = inkBox(alpha, w, h);
    const ink = box ? bandStats(alpha, w, box).ink : 0;
    if (passes === 1) base = ink;
    buildup.push({
      passes,
      ink: +ink.toFixed(4),
      ratio: base > 0 ? +(ink / base).toFixed(3) : 0,
    });
  }

  // --- what the pen's pose does to the mark --------------------------------
  const pose = await poseResponse(
    settings,
    opts.backend ?? cpuBackend,
    size,
    brushReach(settings),
  );

  const mean = seedInk.reduce((a, b) => a + b, 0) / Math.max(1, seedInk.length);
  const variance =
    seedInk.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, seedInk.length);
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

  if (rep.prominence > 20 && rep.amplitude > 0.15) {
    warnings.push(
      `a periodic beat every ${rep.periodInDiameters.toFixed(2)} diameters stands ` +
        `${rep.prominence.toFixed(0)}x above the spectral floor at ` +
        `${(rep.amplitude * 100).toFixed(0)}% ripple — the tip is stamping visibly`,
    );
  }
  if (rep.worstGap > 0.5) {
    warnings.push(
      `the stroke goes nearly bare for ${rep.worstGap.toFixed(2)} diameters — visible break`,
    );
  }
  if (dab.peakAlpha < 0.05) warnings.push('a full-pressure dab is almost invisible');
  if (settings.shape.enabled && settings.shape.angleControl.source === 'tilt') {
    if (pose.anisotropy < 1.15) {
      warnings.push(
        'the tip angle follows the pen but the tip is too round for it to show — ' +
          'lower tip.roundness or the pose is doing nothing',
      );
    } else if (!pose.followsPen) {
      warnings.push('the mark changes with the heading but not with the pen — check the pose controls');
    }
  }
  const p10 = pressureResponse[0];
  const p100 = pressureResponse[9];
  if (p100.ink > 0 && p10.ink / p100.ink > 0.9 && settings.shape.enabled) {
    warnings.push('light and heavy pressure lay down nearly the same ink');
  }

  surface.destroy();
  return {
    size,
    flat: {
      coverage: +flatAgg.coverage.toFixed(4),
      density: +flatAgg.density.toFixed(4),
      ink: +flatAgg.ink.toFixed(4),
      grain: +flatAgg.grain.toFixed(4),
      widthPx: +widthPx.toFixed(1),
    },
    repetition: {
      prominence: +rep.prominence.toFixed(2),
      amplitude: +rep.amplitude.toFixed(4),
      periodInDiameters: +rep.periodInDiameters.toFixed(3),
      worstGap: +rep.worstGap.toFixed(3),
    },
    dab,
    pressureResponse,
    pose,
    buildup,
    seedSpread: { mean: +mean.toFixed(4), cv: +cv.toFixed(4) },
    warnings,
  };
}
