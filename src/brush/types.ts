import type { BlendMode } from '../types';

/**
 * Brush settings modeled on Photoshop's brush engine: a Brush Tip Shape plus
 * the optional dynamics sections (Shape Dynamics, Scattering, Texture, Dual
 * Brush, Color Dynamics, Transfer) and the tip-level toggles (Noise, Wet
 * Edges, Build-up/airbrush, Smoothing).
 */

/** What drives a dynamic parameter — Photoshop's "Control" dropdown. */
export type ControlSource =
  | 'off'
  | 'fade'
  | 'pressure'
  | 'tilt'
  | 'rotation' // stylus barrel rotation / twist
  | 'direction'
  | 'initial-direction';

export interface DynamicControl {
  source: ControlSource;
  /** number of spacing steps for `fade` */
  fadeSteps: number;
}

/**
 * Tip shapes. `round` is analytic; chalk/spatter/grain are generated
 * textures; any other string is a sampled tip registered at runtime
 * (e.g. imported from a Photoshop .abr file).
 */
export type TipShape =
  | 'round'
  | 'chalk'
  | 'spatter'
  | 'grain'
  // Oil & Fresco texture tips (Dual Brush) and primary tips
  | 'sponge-fractal'
  | 'granite-grit'
  | 'crackle-web'
  | 'fiber-drag'
  | 'mist-billow'
  | 'stipple-flecks'
  | 'wisp-filament'
  | 'dust-motes'
  | 'lichen-crust'
  | 'bone-pore'
  | 'moss-tuft'
  | 'bark-grain'
  | 'rust-bloom'
  | 'bristle-chisel'
  | 'bristle-round'
  | 'blade-flat'
  | 'plume-soft'
  | 'fan-comb'
  | (string & {});

/**
 * Texture patterns. The five names are built-in procedural patterns; any
 * other string is a pattern registered at runtime (e.g. imported from a
 * Photoshop .abr file's patt section).
 */
export type PatternId =
  | 'paper'
  | 'canvas'
  | 'sponge'
  | 'clouds'
  | 'speckle'
  | 'linen'
  | (string & {});

/** How texture/dual-brush values combine with brush coverage. */
export type TextureBlend =
  | 'multiply'
  | 'subtract'
  | 'darken'
  | 'overlay'
  | 'height'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'color-burn'
  | 'linear-burn'
  | 'hard-mix';

export interface BrushTip {
  shape: TipShape;
  /** diameter in document pixels */
  size: number;
  /** 0..1, solid-core fraction for the analytic round tip */
  hardness: number;
  /** tip rotation in degrees, -180..180 */
  angle: number;
  /** 0.01..1 — 1 is a circle, smaller squashes the tip into an ellipse */
  roundness: number;
  /** distance between stamps as a fraction of diameter, 0.01..10 */
  spacing: number;
  flipX: boolean;
  flipY: boolean;
}

export interface ShapeDynamics {
  enabled: boolean;
  /** 0..1 random size reduction per stamp */
  sizeJitter: number;
  sizeControl: DynamicControl;
  /** 0..1 floor for controlled/jittered size */
  minDiameter: number;
  /** 0..1 of a full revolution */
  angleJitter: number;
  angleControl: DynamicControl;
  /** 0..1 */
  roundnessJitter: number;
  roundnessControl: DynamicControl;
  /** 0..1 floor for roundness */
  minRoundness: number;
  flipXJitter: boolean;
  flipYJitter: boolean;
}

export interface Scattering {
  enabled: boolean;
  /** scatter along both axes instead of only across the stroke */
  bothAxes: boolean;
  /** 0..10 — fraction of diameter (Photoshop shows 0..1000%) */
  scatter: number;
  scatterControl: DynamicControl;
  /** stamps per spacing step, 1..16 */
  count: number;
  /** 0..1 random reduction of count */
  countJitter: number;
}

export interface TextureSettings {
  enabled: boolean;
  pattern: PatternId;
  /** 0.1..4 — pattern tile scale */
  scale: number;
  /** -1..1 */
  brightness: number;
  /** -1..1 */
  contrast: number;
  invert: boolean;
  mode: TextureBlend;
  /** 0..1 — how strongly the texture carves the stroke */
  depth: number;
  /**
   * When true the texture is applied per stamp (enabling depth jitter);
   * when false it is applied once across the whole stroke, like Photoshop.
   */
  textureEachTip: boolean;
  /** 0..1, only used when textureEachTip */
  depthJitter: number;
  depthControl: DynamicControl;
}

export interface DualBrush {
  enabled: boolean;
  /** the secondary tip shape */
  shape: TipShape;
  /** 0..1, for a round secondary tip */
  hardness: number;
  mode: TextureBlend;
  /** secondary tip diameter in px */
  size: number;
  /** secondary spacing, fraction of secondary diameter */
  spacing: number;
  /** 0..10 */
  scatter: number;
  bothAxes: boolean;
  /** 1..16 */
  count: number;
  /** 0..1 random reduction of count */
  countJitter: number;
}

export interface ColorDynamics {
  enabled: boolean;
  /** vary color per stamp instead of per stroke */
  applyPerTip: boolean;
  /** 0..1 blend toward the background color */
  fgBgJitter: number;
  fgBgControl: DynamicControl;
  /** 0..1 (of ±180 degrees) */
  hueJitter: number;
  /** 0..1 */
  satJitter: number;
  /** 0..1 */
  briJitter: number;
  /** -1..1 saturation bias */
  purity: number;
}

export interface TransferSettings {
  enabled: boolean;
  /** 0..1 random opacity reduction */
  opacityJitter: number;
  opacityControl: DynamicControl;
  /** 0..1 floor */
  opacityMin: number;
  flowJitter: number;
  flowControl: DynamicControl;
  flowMin: number;
}

export interface BrushSettings {
  tip: BrushTip;
  shape: ShapeDynamics;
  scatter: Scattering;
  texture: TextureSettings;
  dual: DualBrush;
  color: ColorDynamics;
  transfer: TransferSettings;

  noise: boolean;
  wetEdges: boolean;
  /** build-up: keep depositing while the pointer is held still */
  airbrush: boolean;
  /** 0..1 input smoothing */
  smoothing: number;

  // options-bar state
  /** stroke-level opacity cap, 0..1 */
  opacity: number;
  /** per-stamp deposition, 0..1 */
  flow: number;
  /** paint blending mode of the stroke against the layer */
  blendMode: BlendMode;
  /** options-bar override: always use pressure for size */
  pressureSize: boolean;
  /** options-bar override: always use pressure for opacity */
  pressureOpacity: boolean;
}

/** Recursive partial used by presets. */
export type BrushPatch = {
  [K in keyof BrushSettings]?: BrushSettings[K] extends object
    ? Partial<BrushSettings[K]>
    : BrushSettings[K];
};

export const CONTROL_SOURCES: { id: ControlSource; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'fade', label: 'Fade' },
  { id: 'pressure', label: 'Pen Pressure' },
  { id: 'tilt', label: 'Pen Tilt' },
  { id: 'rotation', label: 'Rotation' },
  { id: 'direction', label: 'Direction' },
  { id: 'initial-direction', label: 'Initial Direction' },
];

export const TEXTURE_BLENDS: { id: TextureBlend; label: string }[] = [
  { id: 'multiply', label: 'Multiply' },
  { id: 'subtract', label: 'Subtract' },
  { id: 'darken', label: 'Darken' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'height', label: 'Height' },
  { id: 'lighten', label: 'Lighten' },
  { id: 'screen', label: 'Screen' },
  { id: 'color-dodge', label: 'Color Dodge' },
  { id: 'color-burn', label: 'Color Burn' },
  { id: 'linear-burn', label: 'Linear Burn' },
  { id: 'hard-mix', label: 'Hard Mix' },
];

/** Order matches the switch in the shaders' applyTexToAlpha. */
export const TEXTURE_BLEND_INDEX: Record<TextureBlend, number> = {
  multiply: 0,
  subtract: 1,
  darken: 2,
  overlay: 3,
  height: 4,
  lighten: 5,
  screen: 6,
  'color-dodge': 7,
  'color-burn': 8,
  'linear-burn': 9,
  'hard-mix': 10,
};

export const TIP_SHAPES: { id: TipShape; label: string }[] = [
  { id: 'round', label: 'Round' },
  { id: 'chalk', label: 'Chalk' },
  { id: 'spatter', label: 'Spatter' },
  { id: 'grain', label: 'Grain' },
  { id: 'bristle-chisel', label: 'Bristle Chisel' },
  { id: 'bristle-round', label: 'Bristle Round' },
  { id: 'blade-flat', label: 'Flat Blade' },
  { id: 'plume-soft', label: 'Soft Plume' },
  { id: 'fan-comb', label: 'Fan Comb' },
  { id: 'sponge-fractal', label: 'Fractal Sponge' },
  { id: 'granite-grit', label: 'Granite Grit' },
  { id: 'crackle-web', label: 'Crackle Web' },
  { id: 'fiber-drag', label: 'Fibre Drag' },
  { id: 'mist-billow', label: 'Mist Billow' },
  { id: 'stipple-flecks', label: 'Salt Flecks' },
  { id: 'wisp-filament', label: 'Wisp Filament' },
  { id: 'dust-motes', label: 'Dust Motes' },
  { id: 'lichen-crust', label: 'Lichen Crust' },
  { id: 'bone-pore', label: 'Bone Pore' },
  { id: 'moss-tuft', label: 'Moss Tuft' },
  { id: 'bark-grain', label: 'Bark Grain' },
  { id: 'rust-bloom', label: 'Rust Bloom' },
];

export const PATTERNS: { id: PatternId; label: string }[] = [
  { id: 'paper', label: 'Paper' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'sponge', label: 'Sponge' },
  { id: 'clouds', label: 'Clouds' },
  { id: 'speckle', label: 'Speckle' },
  { id: 'linen', label: 'Linen' },
];
