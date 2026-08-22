import { getPattern, getTipAspect } from '../src/brush/patterns';
import { CONTROL_SOURCES, TEXTURE_BLENDS, type BrushSettings } from '../src/brush/types';
import { BLEND_MODES } from '../src/types';

/**
 * What the panel shows, in the order it shows it, and what each control means.
 *
 * Every field of `BrushSettings` appears here exactly once — `npm test` fails
 * if one does not — so this table is the app's contract with the engine.
 *
 * Two things beyond the bindings live here, because they are what turns a
 * wall of sliders into something a person can reason about:
 *
 *   `hint`   one line on what the control does, shown in the status bar.
 *   `reads`  the section's governing *ratio*, computed live. Photoshop's
 *            panel is a long list of independent-looking sliders and it is
 *            not one: flow over spacing decides the edge, scatter over
 *            spacing decides whether the stamp train shows. Those numbers
 *            are the ones worth watching, so the panel does the arithmetic
 *            instead of leaving it to be re-derived. See docs/parameters.md.
 */

/** `[section]` or `[section, field]` of the settings object. */
export type Path = [keyof BrushSettings, string?];

export interface Choice {
  id: string;
  label: string;
}

/** A section's live readout: the ratio, and whether it is out of band. */
export interface Reads {
  text: string;
  warn?: boolean;
}

interface Base {
  label: string;
  path: Path;
  /** one line, shown in the status bar on hover or focus */
  hint: string;
  /**
   * True when this control currently reaches nothing — a hardness on a
   * sampled tip, a depth jitter with "each tip" off. The row dims where it
   * stands rather than vanishing: the value is still the brush's, and still
   * worth setting before flipping the switch that gives it teeth. It is only
   * set where the engine plainly ignores the field, never on a guess.
   */
  inert?: (s: BrushSettings) => boolean;
}

export type Item =
  | (Base & { row: 'slider'; min: number; max: number; step: number; pct?: boolean })
  | (Base & { row: 'check' })
  | (Base & { row: 'choice'; options: readonly Choice[] })
  /** a `DynamicControl`: what drives the value above, and the fade length */
  | (Base & { row: 'control' })
  /** the bitmap in a tip or texture slot, and how it combines */
  | { row: 'bitmap'; of: 'tip' | 'pattern'; path: Path; mode?: Path; hint: string }
  /** the paint itself — not a brush setting, but what Color Dynamics works on */
  | { row: 'paint'; hint: string };

export interface Group {
  title: string;
  /** the name on the section rail, where there is only room for one word */
  short: string;
  /** the section's `enabled` flag, when it has one */
  toggle?: keyof BrushSettings;
  reads?: (s: BrushSettings) => Reads | null;
  items: Item[];
}

/** A 0..100% jitter, the most common row in the panel. */
const jitter = (label: string, path: Path, hint: string, inert?: Base['inert']): Item => ({
  row: 'slider',
  label,
  path,
  hint,
  min: 0,
  max: 1,
  step: 0.01,
  pct: true,
  inert,
});

/** The Control dropdown that follows one. */
const control = (path: Path, drives: string, inert?: Base['inert']): Item => ({
  row: 'control',
  label: 'control',
  path,
  hint: `what drives ${drives}: pressure, tilt, stroke direction, or a fade over N steps`,
  inert,
});

const pctOf = (x: number) => `${Math.round(x * 100)}%`;

export const GROUPS: Group[] = [
  {
    title: 'tip',
    short: 'tip',
    // a squat sampled tip packs its dabs tighter than a round one at the same
    // nominal spacing, because spacing is a fraction of the mark's short side
    reads: (s) => {
      const aspect = getTipAspect(s.tip.shape);
      if (aspect > 0.95) return null;
      return { text: `mark is ${(1 / aspect).toFixed(1)}:1 · dabs land that much tighter than a round tip` };
    },
    items: [
      { row: 'bitmap', of: 'tip', path: ['tip', 'shape'], hint: 'the alpha map every dab stamps — white is ink' },
      { row: 'slider', label: 'size', path: ['tip', 'size'], hint: 'dab diameter in document pixels', min: 1, max: 600, step: 1 },
      {
        row: 'slider',
        label: 'hardness',
        path: ['tip', 'hardness'],
        hint: 'rim falloff of the analytic round tip — a stroke’s real edge comes from flow ÷ spacing',
        min: 0,
        max: 1,
        step: 0.01,
        pct: true,
        // only the analytic round tip has a falloff to harden; a sampled tip
        // brings its own edge and both renderers ignore this for one
        inert: (s) => s.tip.shape !== 'round',
      },
      { row: 'slider', label: 'spacing', path: ['tip', 'spacing'], hint: 'travel between dabs, as a fraction of the mark — over 100% and dabs stop abutting', min: 0.01, max: 2, step: 0.01, pct: true },
      { row: 'slider', label: 'roundness', path: ['tip', 'roundness'], hint: 'squashes the dab across its angle — 100% is a circle', min: 0.05, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'angle', path: ['tip', 'angle'], hint: 'dab rotation in degrees, counter-clockwise', min: -180, max: 180, step: 1 },
      { row: 'check', label: 'flip X', path: ['tip', 'flipX'], hint: 'mirror the tip bitmap horizontally' },
      { row: 'check', label: 'flip Y', path: ['tip', 'flipY'], hint: 'mirror the tip bitmap vertically' },
    ],
  },
  {
    title: 'stroke',
    short: 'stroke',
    // K = flow / spacing: how many dabs of ink pile up per unit of travel, and
    // the thing that actually decides whether a flank is sharp or soft
    reads: (s) => {
      const k = s.flow / s.tip.spacing;
      const band =
        k >= 10 ? 'loaded, opaque, hard-flanked'
        : k >= 4 ? 'solid paint'
        : k >= 2 ? 'paint that still glazes'
        : k >= 1.5 ? 'thin' : 'a wash — long translucent tails';
      return { text: `K = flow ÷ spacing = ${k.toFixed(1)} · ${band}`, warn: k < 1.5 };
    },
    items: [
      { row: 'paint', hint: 'the two colours Color Dynamics blends between — not saved to the brush' },
      { row: 'choice', label: 'blend mode', path: ['blendMode'], hint: 'how the stroke combines with what is already on the layer', options: BLEND_MODES },
      { row: 'slider', label: 'flow', path: ['flow'], hint: 'ink deposited per dab — accumulates within one stroke', min: 0, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'opacity', path: ['opacity'], hint: 'ceiling for the whole stroke, so it cannot darken where it crosses itself', min: 0, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'smoothing', path: ['smoothing'], hint: 'lag on the pointer path — steadies a shaky line, softens corners', min: 0, max: 0.95, step: 0.01, pct: true },
      { row: 'check', label: 'wet edges', path: ['wetEdges'], hint: 'pools ink at the rim, like a watercolour bead' },
      { row: 'check', label: 'noise', path: ['noise'], hint: 'breaks up the soft part of the dab, grainiest at low hardness' },
      { row: 'check', label: 'build-up', path: ['airbrush'], hint: 'airbrush: keeps depositing while the pen is held still' },
      { row: 'check', label: 'pressure → size', path: ['pressureSize'], hint: 'options-bar override: pressure scales the dab even with Shape Dynamics off' },
      { row: 'check', label: 'pressure → opacity', path: ['pressureOpacity'], hint: 'options-bar override: pressure scales deposition' },
    ],
  },
  {
    title: 'shape dynamics',
    short: 'shape',
    toggle: 'shape',
    // size jitter reduces downward and minDiameter floors it, so set both
    // high and the mark stops varying at all
    reads: (s) => {
      if (s.shape.sizeJitter === 0) return null;
      const room = 1 - s.shape.sizeJitter;
      if (s.shape.minDiameter <= room) {
        return { text: `size runs ${pctOf(room)}–100% of ${Math.round(s.tip.size)}px` };
      }
      return { text: `min diameter ${pctOf(s.shape.minDiameter)} floors the jitter · cap it at ${pctOf(room)}`, warn: true };
    },
    items: [
      jitter('size jitter', ['shape', 'sizeJitter'], 'random size reduction per dab — only ever downward'),
      control(['shape', 'sizeControl'], 'dab size'),
      jitter('min diameter', ['shape', 'minDiameter'], 'floor the jitter and the control cannot go below'),
      jitter('angle jitter', ['shape', 'angleJitter'], 'random rotation per dab, as a fraction of ±180°'),
      control(['shape', 'angleControl'], 'dab angle — Direction turns the tip to follow the path'),
      jitter('round jitter', ['shape', 'roundnessJitter'], 'random squash per dab'),
      control(['shape', 'roundnessControl'], 'roundness'),
      jitter('min roundness', ['shape', 'minRoundness'], 'floor for the roundness jitter and control'),
      { row: 'check', label: 'flip X jitter', path: ['shape', 'flipXJitter'], hint: 'mirror half the dabs horizontally, at random' },
      { row: 'check', label: 'flip Y jitter', path: ['shape', 'flipYJitter'], hint: 'mirror half the dabs vertically, at random' },
    ],
  },
  {
    title: 'scattering',
    short: 'scatter',
    toggle: 'scatter',
    // rho = scatter / spacing: below about 3 the stamping frequency survives
    // as a visible beat down the stroke
    reads: (s) => {
      const rho = s.scatter.scatter / s.tip.spacing;
      if (rho >= 3) {
        return s.scatter.bothAxes
          ? { text: `ρ = scatter ÷ spacing = ${rho.toFixed(1)} · no beat` }
          : { text: `ρ = ${rho.toFixed(1)} across only · the beat runs along the stroke`, warn: true };
      }
      return { text: `ρ = scatter ÷ spacing = ${rho.toFixed(1)} · under 3, stamping shows`, warn: true };
    },
    items: [
      { row: 'slider', label: 'scatter', path: ['scatter', 'scatter'], hint: 'how far dabs stray, as a fraction of the diameter — keep it 3× spacing or more', min: 0, max: 10, step: 0.05, pct: true },
      control(['scatter', 'scatterControl'], 'how far dabs stray'),
      { row: 'check', label: 'both axes', path: ['scatter', 'bothAxes'], hint: 'scatter along the stroke as well as across it — off leaves the beat intact' },
      { row: 'slider', label: 'count', path: ['scatter', 'count'], hint: 'dabs laid down per spacing step', min: 1, max: 16, step: 1 },
      jitter('count jitter', ['scatter', 'countJitter'], 'random reduction of that count'),
    ],
  },
  {
    title: 'texture',
    short: 'texture',
    toggle: 'texture',
    reads: (s) => {
      const tile = Math.round(getPattern(s.texture.pattern).size * s.texture.scale);
      const where = s.texture.textureEachTip ? 'carved per dab' : 'carved per stroke';
      return { text: `${tile}px tile on a ${Math.round(s.tip.size)}px tip · ${where}` };
    },
    items: [
      { row: 'bitmap', of: 'pattern', path: ['texture', 'pattern'], mode: ['texture', 'mode'], hint: 'the pattern carved out of the stroke, and how it combines with coverage' },
      { row: 'slider', label: 'depth', path: ['texture', 'depth'], hint: 'how much of the pattern reaches the mark — 0 is no texture at all', min: 0, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'scale', path: ['texture', 'scale'], hint: 'tile size as a multiple of the pattern’s own — judge it against the tip diameter', min: 0.1, max: 4, step: 0.05, pct: true },
      { row: 'slider', label: 'contrast', path: ['texture', 'contrast'], hint: 'pushes the pattern toward pure tooth and pure hollow', min: -1, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'brightness', path: ['texture', 'brightness'], hint: 'lifts or sinks the whole pattern before it carves', min: -1, max: 1, step: 0.01, pct: true },
      { row: 'check', label: 'invert', path: ['texture', 'invert'], hint: 'swap tooth for hollow' },
      { row: 'check', label: 'each tip', path: ['texture', 'textureEachTip'], hint: 'carve per dab instead of per stroke — enables depth jitter, but the grain then moves with the brush' },
      // depth jitter only exists per stamp, which is what "each tip" turns on
      jitter('depth jitter', ['texture', 'depthJitter'], 'random depth per dab — needs "each tip"', (s) => !s.texture.textureEachTip),
      control(['texture', 'depthControl'], 'texture depth', (s) => !s.texture.textureEachTip),
    ],
  },
  {
    title: 'dual brush',
    short: 'dual',
    toggle: 'dual',
    // the dual tip is a gate, not a second layer of paint: spacing over 100%
    // leaves holes the primary can never paint through
    reads: (s) => {
      if (s.dual.spacing > 1) {
        return { text: `mask spacing ${pctOf(s.dual.spacing)} · holes the primary cannot paint through`, warn: true };
      }
      return { text: `a ${Math.round(s.dual.size)}px mask every ${pctOf(s.dual.spacing)} gates the primary` };
    },
    items: [
      { row: 'bitmap', of: 'tip', path: ['dual', 'shape'], mode: ['dual', 'mode'], hint: 'the secondary tip, stamped into a mask that gates every primary dab' },
      { row: 'slider', label: 'size', path: ['dual', 'size'], hint: 'mask dab diameter — scales with the primary size, as in Photoshop', min: 1, max: 600, step: 1 },
      {
        row: 'slider',
        label: 'hardness',
        path: ['dual', 'hardness'],
        hint: 'rim falloff of the mask dab, for the analytic round tip only',
        min: 0,
        max: 1,
        step: 0.01,
        pct: true,
        inert: (s) => s.dual.shape !== 'round',
      },
      { row: 'slider', label: 'spacing', path: ['dual', 'spacing'], hint: 'travel between mask dabs — over 100% breaks the stroke', min: 0.01, max: 2, step: 0.01, pct: true },
      { row: 'slider', label: 'scatter', path: ['dual', 'scatter'], hint: 'how far mask dabs stray, as a fraction of the diameter', min: 0, max: 10, step: 0.05, pct: true },
      { row: 'check', label: 'both axes', path: ['dual', 'bothAxes'], hint: 'scatter the mask along the stroke as well as across it' },
      { row: 'slider', label: 'count', path: ['dual', 'count'], hint: 'mask dabs per spacing step', min: 1, max: 16, step: 1 },
      jitter('count jitter', ['dual', 'countJitter'], 'random reduction of that count'),
    ],
  },
  {
    title: 'transfer',
    short: 'transfer',
    toggle: 'transfer',
    reads: (s) => {
      const t = s.transfer;
      if (t.opacityControl.source === 'off' && t.flowControl.source === 'off' && !t.opacityJitter && !t.flowJitter) {
        return { text: 'nothing set · the stroke deposits flat', warn: true };
      }
      return null;
    },
    items: [
      jitter('opacity jitter', ['transfer', 'opacityJitter'], 'random reduction of the stroke ceiling, per dab'),
      control(['transfer', 'opacityControl'], 'the stroke ceiling'),
      jitter('opacity min', ['transfer', 'opacityMin'], 'floor for the opacity jitter and control'),
      jitter('flow jitter', ['transfer', 'flowJitter'], 'random reduction of deposition, per dab'),
      control(['transfer', 'flowControl'], 'deposition — Pen Pressure here is what makes a stroke breathe'),
      jitter('flow min', ['transfer', 'flowMin'], 'floor for the flow jitter and control'),
    ],
  },
  {
    title: 'color dynamics',
    short: 'color',
    toggle: 'color',
    reads: (s) =>
      s.color.applyPerTip
        ? null
        : { text: 'per tip off · one colour for the whole stroke' },
    items: [
      { row: 'check', label: 'per tip', path: ['color', 'applyPerTip'], hint: 'vary colour dab by dab rather than once per stroke' },
      jitter('fg/bg jitter', ['color', 'fgBgJitter'], 'how far each dab drifts from foreground toward background'),
      control(['color', 'fgBgControl'], 'the fg→bg blend'),
      jitter('hue jitter', ['color', 'hueJitter'], 'random hue shift, as a fraction of ±180°'),
      jitter('sat jitter', ['color', 'satJitter'], 'random saturation shift per dab'),
      jitter('bri jitter', ['color', 'briJitter'], 'random brightness shift per dab'),
      { row: 'slider', label: 'purity', path: ['color', 'purity'], hint: 'pushes saturation up or down across the whole stroke', min: -1, max: 1, step: 0.01, pct: true },
    ],
  },
];

export const BLEND_CHOICES = TEXTURE_BLENDS;
export const CONTROL_CHOICES = CONTROL_SOURCES;
