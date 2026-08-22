import { CONTROL_SOURCES, TEXTURE_BLENDS, type BrushSettings } from '../src/brush/types';
import { BLEND_MODES } from '../src/types';

/**
 * What the panel shows, in the order it shows it.
 *
 * Every field of `BrushSettings` appears here exactly once: the engine has no
 * knob this table leaves out, and a knob added to the engine is missing from
 * the app until it is added here. The order within a group follows
 * Photoshop's own Brush Settings panel, because that is the order the people
 * using this already read a brush in — a jitter, then the Control that drives
 * it, then the floor it cannot fall below.
 */

/** `[section]` or `[section, field]` of the settings object. */
export type Path = [keyof BrushSettings, string?];

export interface Choice {
  id: string;
  label: string;
}

interface Base {
  label: string;
  path: Path;
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
  | { row: 'bitmap'; of: 'tip' | 'pattern'; path: Path; mode?: Path }
  /** the paint itself — not a brush setting, but what Color Dynamics works on */
  | { row: 'paint' };

export interface Group {
  title: string;
  /** the section's `enabled` flag, when it has one */
  toggle?: keyof BrushSettings;
  items: Item[];
}

/** A 0..100% jitter, the most common row in the panel. */
const jitter = (label: string, path: Path, inert?: Base['inert']): Item => ({
  row: 'slider',
  label,
  path,
  min: 0,
  max: 1,
  step: 0.01,
  pct: true,
  inert,
});

/** The Control dropdown that follows one. */
const control = (path: Path, inert?: Base['inert']): Item => ({
  row: 'control',
  label: 'control',
  path,
  inert,
});

export const GROUPS: Group[] = [
  {
    title: 'tip',
    items: [
      { row: 'bitmap', of: 'tip', path: ['tip', 'shape'] },
      { row: 'slider', label: 'size', path: ['tip', 'size'], min: 1, max: 600, step: 1 },
      {
        row: 'slider',
        label: 'hardness',
        path: ['tip', 'hardness'],
        min: 0,
        max: 1,
        step: 0.01,
        pct: true,
        // only the analytic round tip has a falloff to harden; a sampled tip
        // brings its own edge and both renderers ignore this for one
        inert: (s) => s.tip.shape !== 'round',
      },
      { row: 'slider', label: 'spacing', path: ['tip', 'spacing'], min: 0.01, max: 2, step: 0.01, pct: true },
      { row: 'slider', label: 'roundness', path: ['tip', 'roundness'], min: 0.05, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'angle', path: ['tip', 'angle'], min: -180, max: 180, step: 1 },
      { row: 'check', label: 'flip X', path: ['tip', 'flipX'] },
      { row: 'check', label: 'flip Y', path: ['tip', 'flipY'] },
    ],
  },
  {
    title: 'stroke',
    items: [
      { row: 'paint' },
      { row: 'choice', label: 'blend mode', path: ['blendMode'], options: BLEND_MODES },
      { row: 'slider', label: 'flow', path: ['flow'], min: 0, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'opacity', path: ['opacity'], min: 0, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'smoothing', path: ['smoothing'], min: 0, max: 0.95, step: 0.01, pct: true },
      { row: 'check', label: 'wet edges', path: ['wetEdges'] },
      { row: 'check', label: 'noise', path: ['noise'] },
      { row: 'check', label: 'build-up', path: ['airbrush'] },
      { row: 'check', label: 'pressure → size', path: ['pressureSize'] },
      { row: 'check', label: 'pressure → opacity', path: ['pressureOpacity'] },
    ],
  },
  {
    title: 'shape dynamics',
    toggle: 'shape',
    items: [
      jitter('size jitter', ['shape', 'sizeJitter']),
      control(['shape', 'sizeControl']),
      jitter('min diameter', ['shape', 'minDiameter']),
      jitter('angle jitter', ['shape', 'angleJitter']),
      control(['shape', 'angleControl']),
      jitter('round jitter', ['shape', 'roundnessJitter']),
      control(['shape', 'roundnessControl']),
      jitter('min roundness', ['shape', 'minRoundness']),
      { row: 'check', label: 'flip X jitter', path: ['shape', 'flipXJitter'] },
      { row: 'check', label: 'flip Y jitter', path: ['shape', 'flipYJitter'] },
    ],
  },
  {
    title: 'scattering',
    toggle: 'scatter',
    items: [
      { row: 'slider', label: 'scatter', path: ['scatter', 'scatter'], min: 0, max: 10, step: 0.05, pct: true },
      control(['scatter', 'scatterControl']),
      { row: 'check', label: 'both axes', path: ['scatter', 'bothAxes'] },
      { row: 'slider', label: 'count', path: ['scatter', 'count'], min: 1, max: 16, step: 1 },
      jitter('count jitter', ['scatter', 'countJitter']),
    ],
  },
  {
    title: 'texture',
    toggle: 'texture',
    items: [
      { row: 'bitmap', of: 'pattern', path: ['texture', 'pattern'], mode: ['texture', 'mode'] },
      { row: 'slider', label: 'depth', path: ['texture', 'depth'], min: 0, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'scale', path: ['texture', 'scale'], min: 0.1, max: 4, step: 0.05, pct: true },
      { row: 'slider', label: 'contrast', path: ['texture', 'contrast'], min: -1, max: 1, step: 0.01, pct: true },
      { row: 'slider', label: 'brightness', path: ['texture', 'brightness'], min: -1, max: 1, step: 0.01, pct: true },
      { row: 'check', label: 'invert', path: ['texture', 'invert'] },
      { row: 'check', label: 'each tip', path: ['texture', 'textureEachTip'] },
      // depth jitter only exists per stamp, which is what "each tip" turns on
      jitter('depth jitter', ['texture', 'depthJitter'], (s) => !s.texture.textureEachTip),
      control(['texture', 'depthControl'], (s) => !s.texture.textureEachTip),
    ],
  },
  {
    title: 'dual brush',
    toggle: 'dual',
    items: [
      { row: 'bitmap', of: 'tip', path: ['dual', 'shape'], mode: ['dual', 'mode'] },
      { row: 'slider', label: 'size', path: ['dual', 'size'], min: 1, max: 600, step: 1 },
      {
        row: 'slider',
        label: 'hardness',
        path: ['dual', 'hardness'],
        min: 0,
        max: 1,
        step: 0.01,
        pct: true,
        inert: (s) => s.dual.shape !== 'round',
      },
      { row: 'slider', label: 'spacing', path: ['dual', 'spacing'], min: 0.01, max: 2, step: 0.01, pct: true },
      { row: 'slider', label: 'scatter', path: ['dual', 'scatter'], min: 0, max: 10, step: 0.05, pct: true },
      { row: 'check', label: 'both axes', path: ['dual', 'bothAxes'] },
      { row: 'slider', label: 'count', path: ['dual', 'count'], min: 1, max: 16, step: 1 },
      jitter('count jitter', ['dual', 'countJitter']),
    ],
  },
  {
    title: 'transfer',
    toggle: 'transfer',
    items: [
      jitter('opacity jitter', ['transfer', 'opacityJitter']),
      control(['transfer', 'opacityControl']),
      jitter('opacity min', ['transfer', 'opacityMin']),
      jitter('flow jitter', ['transfer', 'flowJitter']),
      control(['transfer', 'flowControl']),
      jitter('flow min', ['transfer', 'flowMin']),
    ],
  },
  {
    title: 'color dynamics',
    toggle: 'color',
    items: [
      { row: 'check', label: 'per tip', path: ['color', 'applyPerTip'] },
      jitter('fg/bg jitter', ['color', 'fgBgJitter']),
      control(['color', 'fgBgControl']),
      jitter('hue jitter', ['color', 'hueJitter']),
      jitter('sat jitter', ['color', 'satJitter']),
      jitter('bri jitter', ['color', 'briJitter']),
      { row: 'slider', label: 'purity', path: ['color', 'purity'], min: -1, max: 1, step: 0.01, pct: true },
    ],
  },
];

export const BLEND_CHOICES = TEXTURE_BLENDS;
export const CONTROL_CHOICES = CONTROL_SOURCES;
