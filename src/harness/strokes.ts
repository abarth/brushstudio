import type { PointerSample } from '../brush/dynamics';

/**
 * The standard test marks.
 *
 * A brush is judged by what its marks do, so the harness always draws the
 * same ones: comparing two revisions, or a design against a reference .abr,
 * is then a straight image diff instead of an argument about whether the
 * hand that drew them moved differently.
 *
 * Every path is a pure function of its box, and pen state is spelled out
 * per sample, so a plate is reproducible to the pixel given the same seed.
 */

export interface StrokeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TestStroke {
  id: string;
  /** printed on the plate */
  label: string;
  /** what the mark is meant to expose */
  reveals: string;
  /**
   * Natural row height in document pixels. `size` is the tip diameter;
   * `reach` is how far the brush can actually throw ink, which Scattering
   * makes much larger — a row sized to the tip alone would have a spatter
   * brush spilling into its neighbours.
   */
  rowHeight: (size: number, reach: number) => number;
  paths: (box: StrokeBox, size: number, reach: number) => PointerSample[][];
}

const sample = (
  x: number,
  y: number,
  pressure: number,
  extra: Partial<PointerSample> = {},
): PointerSample => ({ x, y, pressure, tiltX: 0, tiltY: 0, twist: 0, ...extra });

/** Samples a parametric path at a fixed step in t. */
function trace(
  steps: number,
  f: (t: number) => { x: number; y: number; pressure: number; tiltX?: number; tiltY?: number },
): PointerSample[] {
  const out: PointerSample[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = f(i / steps);
    out.push(sample(p.x, p.y, p.pressure, { tiltX: p.tiltX ?? 0, tiltY: p.tiltY ?? 0 }));
  }
  return out;
}

/**
 * The pen pose the `pose` fan is drawn with: laid over far enough that a
 * real pencil would be riding on its worn facet rather than its point, and
 * eight headings per band, which resolves the narrow axis to 22.5 degrees.
 */
const POSE_TILT = 45;
const POSE_HEADINGS = 8;

export const TEST_STROKES: TestStroke[] = [
  {
    id: 'dabs',
    label: 'single dabs — pressure 20 / 40 / 60 / 80 / 100%',
    reveals: 'the tip mark itself: shape, edge, grain, and how size follows pressure',
    rowHeight: (_size, reach) => reach * 1.7 + 20,
    paths: (box, _size, reach) => {
      // Spread across the row rather than packed left: at a big tip size the
      // dabs would otherwise overlap and stop being separate marks.
      const pressures = [0.2, 0.4, 0.6, 0.8, 1];
      const y = box.y + box.height / 2;
      const span = Math.min(box.width, (reach * 2 + 40) * pressures.length);
      const x0 = box.x + (box.width - span) / 2;
      return pressures.map((p, i) => [
        sample(x0 + (span * (i + 0.5)) / pressures.length, y, p),
      ]);
    },
  },
  {
    id: 'flat',
    label: 'flat stroke — constant pressure',
    reveals: 'repetition: a tip that stamps the same mark every N pixels shows a beat here',
    rowHeight: (_size, reach) => reach * 1.5 + 20,
    paths: (box, size) => {
      const y = box.y + box.height / 2;
      const step = Math.max(2, size / 12);
      const pts: PointerSample[] = [];
      for (let x = box.x; x <= box.x + box.width; x += step) pts.push(sample(x, y, 0.8));
      return [pts];
    },
  },
  {
    id: 'taper',
    label: 'pressure ramp 0 → 1 → 0',
    reveals: 'the entry and exit taper, and whether thin pressure still deposits ink',
    rowHeight: (_size, reach) => reach * 1.7 + 20,
    paths: (box, size) => {
      const y = box.y + box.height / 2;
      const steps = Math.max(60, Math.round(box.width / Math.max(2, size / 12)));
      return [
        trace(steps, (t) => ({
          x: box.x + t * box.width,
          y,
          pressure: Math.max(0.02, Math.sin(t * Math.PI)),
        })),
      ];
    },
  },
  {
    id: 'ladder',
    label: 'pressure ladder — 10% steps held flat',
    reveals: 'the size/opacity response curve, one rung per pressure level',
    rowHeight: (_size, reach) => reach * 1.5 + 20,
    paths: (box, size) => {
      const y = box.y + box.height / 2;
      const rungs = 10;
      const w = box.width / rungs;
      const step = Math.max(2, size / 12);
      return Array.from({ length: rungs }, (_, i) => {
        const pressure = (i + 1) / rungs;
        const pts: PointerSample[] = [];
        const x0 = box.x + i * w + w * 0.08;
        for (let x = x0; x <= x0 + w * 0.84; x += step) pts.push(sample(x, y, pressure));
        return pts;
      });
    },
  },
  {
    id: 'curves',
    label: 'S-curve and tight arc',
    reveals: 'direction-driven dynamics: does the tip stay in register as the path turns',
    rowHeight: (_size, reach) => Math.max(reach * 3, 200),
    paths: (box, size) => {
      const amp = Math.min(box.height * 0.34, size * 1.6 + 40);
      const mid = box.y + box.height / 2;
      const steps = Math.max(120, Math.round(box.width / Math.max(1.5, size / 16)));
      const sCurve = trace(steps, (t) => ({
        x: box.x + t * box.width * 0.58,
        y: mid + Math.sin(t * Math.PI * 2) * amp,
        pressure: 0.8,
      }));
      const r = Math.min(box.height * 0.36, box.width * 0.16);
      const cx = box.x + box.width * 0.82;
      const arc = trace(steps, (t) => {
        const a = -Math.PI * 0.9 + t * Math.PI * 1.8;
        return { x: cx + Math.cos(a) * r, y: mid + Math.sin(a) * r, pressure: 0.8 };
      });
      return [sCurve, arc];
    },
  },
  {
    id: 'crosshatch',
    label: 'crosshatch',
    reveals: 'how strokes build where they cross — flow accumulation and wet edges',
    rowHeight: (_size, reach) => Math.max(reach * 2.6, 180),
    paths: (box, size) => {
      const step = Math.max(2, size / 12);
      const gap = Math.max(size * 1.2, 22);
      const lanes = Math.ceil(box.width / gap) + Math.ceil(box.height / gap);
      const out: PointerSample[][] = [];
      for (const dir of [1, -1]) {
        for (let k = -Math.ceil(box.height / gap); k <= lanes; k++) {
          const pts: PointerSample[] = [];
          const x0 = box.x + k * gap;
          const len = box.height * 0.9;
          for (let d = 0; d <= len; d += step) {
            const x = x0 + d * dir * 0.75;
            const y = box.y + box.height * 0.05 + d;
            if (x < box.x - size || x > box.x + box.width + size) continue;
            pts.push(sample(x, y, 0.7));
          }
          if (pts.length > 1) out.push(pts);
        }
      }
      return out;
    },
  },
  {
    id: 'wash',
    label: 'wash — three overlapping passes',
    reveals: 'glazing: whether repeated passes build smoothly or blotch',
    rowHeight: (_size, reach) => Math.max(reach * 2.4, 150),
    paths: (box, size) => {
      const step = Math.max(2, size / 12);
      const out: PointerSample[][] = [];
      for (let pass = 0; pass < 3; pass++) {
        const y0 = box.y + box.height * (0.3 + pass * 0.02);
        for (let lane = 0; lane < 4; lane++) {
          const y = y0 + lane * Math.max(size * 0.45, 8);
          const pts: PointerSample[] = [];
          const dir = lane % 2 === 0 ? 1 : -1;
          for (let i = 0; i <= box.width; i += step) {
            const x = dir > 0 ? box.x + i : box.x + box.width - i;
            pts.push(sample(x, y, 0.65));
          }
          out.push(pts);
        }
      }
      return out;
    },
  },
  {
    id: 'tilt',
    label: 'tilt sweep — pen upright → laid over',
    reveals: 'tilt-driven dynamics; a flat row here means nothing is bound to tilt',
    rowHeight: (_size, reach) => reach * 1.6 + 20,
    paths: (box, size) => {
      const y = box.y + box.height / 2;
      const steps = Math.max(60, Math.round(box.width / Math.max(2, size / 12)));
      return [
        trace(steps, (t) => ({
          x: box.x + t * box.width,
          y,
          pressure: 0.8,
          tiltX: t * 60,
          tiltY: 0,
        })),
      ];
    },
  },
  {
    id: 'pose',
    label: 'pose fan — one pen pose held, heading turned 0 → 180° (top: barrel right · bottom: barrel down)',
    reveals: "whether the mark follows the pen's pose: a facet tip runs narrow along the barrel and wide across it",
    rowHeight: (size, reach) => Math.max(reach * 3.4, size * 5, 210),
    paths: (box, size) => {
      const out: PointerSample[][] = [];
      const bandH = box.height / 2;
      const cellW = box.width / POSE_HEADINGS;
      const len = Math.min(cellW, bandH) * 0.8;
      const step = Math.max(1.5, size / 12);
      // Two barrel directions, because one fan cannot tell the two cases
      // apart: a tip at a fixed angle draws exactly the same fan whatever
      // the pen is doing. Only a tip bound to the pose keeps its narrow
      // mark on the barrel when the barrel moves, so the second band
      // repeats the first band's pen-relative headings with the pen turned
      // 90 degrees — the two bands match if and only if the tip follows.
      [0, 90].forEach((azimuth, band) => {
        const tiltX = POSE_TILT * Math.cos((azimuth * Math.PI) / 180);
        const tiltY = POSE_TILT * Math.sin((azimuth * Math.PI) / 180);
        const cy = box.y + bandH * (band + 0.5);
        for (let i = 0; i < POSE_HEADINGS; i++) {
          const heading = ((azimuth + (i * 180) / POSE_HEADINGS) * Math.PI) / 180;
          const cx = box.x + cellW * (i + 0.5);
          const pts: PointerSample[] = [];
          for (let d = -len / 2; d <= len / 2; d += step) {
            pts.push(
              sample(cx + Math.cos(heading) * d, cy + Math.sin(heading) * d, 0.8, {
                tiltX,
                tiltY,
              }),
            );
          }
          out.push(pts);
        }
      });
      return out;
    },
  },
  {
    id: 'speed',
    label: 'slow → fast (sample spacing widens)',
    reveals: 'spacing robustness: gaps here mean the brush depends on a slow hand',
    rowHeight: (_size, reach) => reach * 1.5 + 20,
    paths: (box, size) => {
      const y = box.y + box.height / 2;
      const pts: PointerSample[] = [];
      let x = box.x;
      let step = Math.max(1.5, size / 20);
      while (x <= box.x + box.width) {
        pts.push(sample(x, y, 0.8));
        x += step;
        step *= 1.045; // event spacing grows the way a fast hand's does
      }
      return [pts];
    },
  },
];

export const DEFAULT_PLATE_STROKES = ['dabs', 'flat', 'taper', 'curves', 'crosshatch'];

export function findStroke(id: string): TestStroke | undefined {
  return TEST_STROKES.find((s) => s.id === id);
}

/**
 * How far from the pen a brush can actually put ink, in document pixels.
 * Scatter throws stamps clear of the path and the dual train reaches wider
 * still, so a plate row sized to the tip diameter alone would have those
 * marks landing in the row above.
 */
export function brushReach(settings: {
  tip: { size: number };
  scatter: { enabled: boolean; scatter: number };
}): number {
  // Only Scattering moves ink away from the path. The dual brush reaches
  // wider and scatters harder, but its train is a mask: it can subtract
  // coverage from a dab, never add any outside one.
  const scatter = settings.scatter.enabled ? settings.scatter.scatter : 0;
  // Capped: a 1000% scatter is legal and would make a plate unreadable.
  return settings.tip.size * Math.min(1 + scatter, 4);
}
