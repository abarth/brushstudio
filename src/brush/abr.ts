import type { GrayMap } from './patterns';
import type { BlendMode } from '../types';
import type { BrushPatch, DynamicControl, TextureBlend } from './types';

/**
 * Photoshop .abr brush file parser.
 *
 * Supports the legacy v1/v2 format (a flat list of sampled brushes) and the
 * modern v6/v7/v9/v10 format: 8BIM 'samp' (sampled tip bitmaps), 'desc'
 * (an Actions-format descriptor with names and dynamics), and 'patt'
 * (embedded texture patterns as VirtualMemoryArrayList images).
 *
 * The descriptor key schema and enum values below were validated against
 * real ABR files (see tests/gpu.spec.mjs for the file list and URLs) and
 * cross-checked against three independent implementations:
 * - GIMP's app/core/gimpbrush-load.c (samp record layout: skip 47 bytes for
 *   subversion 1, 301 for subversion 2, from the record start)
 * - github.com/SonyStone/ABR-Viewer research.md + parser (desc layout,
 *   '$'-prefixed UUIDs, bVTy 7 = Rotation)
 * - github.com/jlai/brush-viewer ABR.ksy (Kaitai grammar) and
 *   github.com/abarth/impression abrParser.ts (bVTy 5/6 = Direction /
 *   Initial Direction, prVr = flow)
 */

export interface AbrBrush {
  name: string;
  /** id of the sampled tip in `tips`, or null for a computed round brush */
  tipId: string | null;
  /** id of the texture pattern in `patterns`, when the brush uses Texture */
  texturePatternId: string | null;
  settings: BrushPatch;
}

export interface AbrPattern {
  name: string;
  map: GrayMap;
}

export interface AbrResult {
  version: number;
  tips: Map<string, GrayMap>;
  patterns: Map<string, AbrPattern>;
  brushes: AbrBrush[];
}

class Reader {
  private v: DataView;
  private buf: ArrayBuffer;
  pos = 0;

  constructor(buf: ArrayBuffer) {
    this.buf = buf;
    this.v = new DataView(buf);
  }

  get length(): number {
    return this.v.byteLength;
  }

  get remaining(): number {
    return this.v.byteLength - this.pos;
  }

  u8(): number {
    return this.v.getUint8(this.pos++);
  }

  i8(): number {
    return this.v.getInt8(this.pos++);
  }

  u16(): number {
    const x = this.v.getUint16(this.pos);
    this.pos += 2;
    return x;
  }

  i16(): number {
    const x = this.v.getInt16(this.pos);
    this.pos += 2;
    return x;
  }

  u32(): number {
    const x = this.v.getUint32(this.pos);
    this.pos += 4;
    return x;
  }

  i32(): number {
    const x = this.v.getInt32(this.pos);
    this.pos += 4;
    return x;
  }

  f64(): number {
    const x = this.v.getFloat64(this.pos);
    this.pos += 8;
    return x;
  }

  peekU32(): number {
    return this.v.getUint32(this.pos);
  }

  peekAscii(n: number): string {
    let s = '';
    for (let i = 0; i < n && this.pos + i < this.length; i++) {
      s += String.fromCharCode(this.v.getUint8(this.pos + i));
    }
    return s;
  }

  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }

  bytes(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.buf.slice(this.pos, this.pos + n));
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    this.pos += n;
  }

  /**
   * Pascal string: u8 length + ascii chars. Samp-record UUIDs are stored as
   * '$' + 36 chars; conveniently '$' is ASCII 36, so the prefix doubles as
   * the length byte and this read yields the bare UUID.
   */
  pascal(): string {
    return this.ascii(this.u8());
  }

  /** Photoshop unicode string: u32 char count + UTF-16BE chars. */
  unicode(): string {
    const n = this.u32();
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.u16();
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s;
  }

  /** Descriptor key: u32 length (0 means 4) + ascii. */
  key(): string {
    const n = this.u32();
    return this.ascii(n === 0 ? 4 : n).trim();
  }
}

/** PackBits RLE decode of exactly `expected` output bytes. */
function unpackBits(r: Reader, expected: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(expected);
  let o = 0;
  while (o < expected && r.remaining > 0) {
    const n = r.i8();
    if (n >= 0) {
      for (let i = 0; i <= n && o < expected; i++) out[o++] = r.u8();
    } else if (n !== -128) {
      const b = r.u8();
      for (let i = 0; i < 1 - n && o < expected; i++) out[o++] = b;
    }
  }
  return out;
}

/**
 * Photoshop's compressed-rows image layout, shared by sampled tips and
 * pattern channels: per-row compressed byte counts (i16 each), then a
 * PackBits-packed run per row of `bytesPerRow` decoded bytes.
 */
function readRleRows(r: Reader, rows: number, bytesPerRow: number): Uint8Array<ArrayBuffer> {
  const counts: number[] = [];
  for (let y = 0; y < rows; y++) counts.push(r.i16());
  const out = new Uint8Array(rows * bytesPerRow);
  for (let y = 0; y < rows; y++) {
    const rowEnd = r.pos + counts[y];
    out.set(unpackBits(r, bytesPerRow), y * bytesPerRow);
    r.pos = rowEnd;
  }
  return out;
}

/** Pads a possibly non-square bitmap into a square, centered GrayMap. */
function toSquareMap(data: Uint8Array, w: number, h: number): GrayMap {
  const size = Math.max(w, h);
  const out = new Uint8Array(size * size);
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y++) {
    out.set(data.subarray(y * w, (y + 1) * w), (y + oy) * size + ox);
  }
  return { size, data: out };
}

/**
 * Nearest-resamples a non-square bitmap to a square map. Used for patterns,
 * which must stay tileable (padding would break the tiling), unlike tips.
 */
function resampleSquare(data: Uint8Array, w: number, h: number): GrayMap {
  if (w === h) {
    return { size: w, data: new Uint8Array(data) };
  }
  const size = Math.max(w, h);
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / size));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / size));
      out[y * size + x] = data[sy * w + sx];
    }
  }
  return { size, data: out };
}

const MAX_TIP_DIM = 8192;

/** Reads one sampled-brush bitmap: rect, depth, compression, pixel data. */
function readSampledBitmap(r: Reader): GrayMap | null {
  const top = r.i32();
  const left = r.i32();
  const bottom = r.i32();
  const right = r.i32();
  const depth = r.i16();
  const compressed = r.u8() !== 0;
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0 || w > MAX_TIP_DIM || h > MAX_TIP_DIM) return null;
  if (depth !== 8 && depth !== 16) return null;

  let gray: Uint8Array;
  if (!compressed) {
    if (depth === 8) {
      gray = r.bytes(w * h);
    } else {
      gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = r.u16() >> 8;
    }
  } else {
    const rows = readRleRows(r, h, w * (depth >> 3));
    if (depth === 8) {
      gray = rows;
    } else {
      gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = rows[i * 2];
    }
  }
  return toSquareMap(gray, w, h);
}

// ---------------------------------------------------------------------------
// Actions-format descriptor parsing
// ---------------------------------------------------------------------------

type DescValue =
  | number
  | boolean
  | string
  | null
  | { unit: string; value: number }
  | { enumType: string; enumValue: string }
  | DescValue[]
  | Descriptor;

interface Descriptor {
  [key: string]: DescValue;
}

function parseDescriptor(r: Reader): Descriptor {
  r.unicode(); // class name
  r.key(); // class id
  const count = r.u32();
  const out: Descriptor = {};
  for (let i = 0; i < count; i++) {
    const key = r.key();
    const type = r.ascii(4);
    out[key] = parseValue(r, type);
  }
  return out;
}

function parseValue(r: Reader, type: string): DescValue {
  switch (type) {
    case 'Objc':
    case 'GlbO':
      return parseDescriptor(r);
    case 'VlLs': {
      const n = r.u32();
      const items: DescValue[] = [];
      for (let i = 0; i < n; i++) {
        const t = r.ascii(4);
        items.push(parseValue(r, t));
      }
      return items;
    }
    case 'doub':
      return r.f64();
    case 'UntF': {
      const unit = r.ascii(4);
      return { unit, value: r.f64() };
    }
    case 'TEXT':
      return r.unicode();
    case 'enum': {
      const enumType = r.key();
      const enumValue = r.key();
      return { enumType, enumValue };
    }
    case 'long':
      return r.i32();
    case 'comp': {
      const hi = r.u32();
      const lo = r.u32();
      return hi * 0x100000000 + lo;
    }
    case 'bool':
      return r.u8() !== 0;
    case 'type':
    case 'GlbC':
      r.unicode();
      r.key();
      return null;
    case 'alis':
    case 'tdta':
    case 'Pth ': {
      const n = r.u32();
      r.skip(n);
      return null;
    }
    case 'obj ': {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        const t = r.ascii(4);
        switch (t) {
          case 'prop':
            r.unicode();
            r.key();
            r.key();
            break;
          case 'Clss':
            r.unicode();
            r.key();
            break;
          case 'Enmr':
            r.unicode();
            r.key();
            r.key();
            r.key();
            break;
          case 'rele':
            r.unicode();
            r.key();
            r.u32();
            break;
          case 'Idnt':
          case 'indx':
            r.u32();
            break;
          case 'name':
            r.unicode();
            r.key();
            r.unicode();
            break;
          default:
            throw new Error(`unknown reference type ${t}`);
        }
      }
      return null;
    }
    default:
      throw new Error(`unknown descriptor type ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Descriptor -> BrushSettings mapping
//
// Key names below were observed in real files (MB Starter Pack, Evenant,
// Pixelstains, spray brushes — see tests for URLs). Notably:
// - scatter lives in scatterDynamics/countDynamics/bothAxes/'Cnt '
// - texture uses textureScale/textureBlendMode/textureDepth/InvT/TxtC/
//   textureBrightness/textureContrast/textureDepthDynamics + Txtr.Idnt
// - useDualBrush is nested INSIDE the dualBrush descriptor
// - transfer: opVr = opacity variance, prVr = flow variance
// - toolOptions: Opct/flow/Md/smoothingValue/usePressureOverridesSize/
//   usePressureOverridesOpacity
// ---------------------------------------------------------------------------

const isDesc = (v: DescValue | undefined): v is Descriptor =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !('unit' in v) && !('enumType' in v);

/** Narrowing helper: returns the value when it is a nested descriptor. */
function desc(v: DescValue | undefined): Descriptor | undefined {
  return isDesc(v) ? v : undefined;
}

function num(v: DescValue | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const value = (v as { value?: unknown }).value;
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function bool(v: DescValue | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function str(v: DescValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function enumVal(v: DescValue | undefined): string | undefined {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const enumValue = (v as { enumValue?: unknown }).enumValue;
    if (typeof enumValue === 'string') return enumValue;
  }
  return undefined;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * bVTy control values. Empirically validated table:
 * 0=Off, 1=Fade, 2=Pen Pressure, 3=Pen Tilt, 4=Stylus Wheel,
 * 5=Initial Direction, 6=Direction, 7=Rotation.
 * (5/6 verified against Photoshop's UI for Size_Flow_Gang.abr: "08 Flatty"
 * stores bVTy 6 and Photoshop shows Direction — jlai/brush-viewer and
 * abarth/impression have the pair backwards; 7=Rotation per
 * SonyStone/ABR-Viewer's reverse-engineering; 4=wheel is unsupported here and
 * maps to Off so mouse users don't get zeroed parameters.)
 */
const CONTROL_MAP: DynamicControl['source'][] = [
  'off', 'fade', 'pressure', 'tilt', 'off',
  'initial-direction', 'direction', 'rotation',
];

function mapControl(d: Descriptor | undefined): {
  control: DynamicControl;
  jitter: number;
  minimum: number;
} {
  if (!d) {
    return { control: { source: 'off', fadeSteps: 25 }, jitter: 0, minimum: 0 };
  }
  const idx = num(d['bVTy']) ?? 0;
  return {
    control: {
      source: CONTROL_MAP[idx] ?? 'off',
      fadeSteps: Math.max(1, num(d['fStp']) ?? 25),
    },
    // raw fraction; most consumers clamp to 0..1 but scatter can reach 10
    jitter: Math.max(0, (num(d['jitter']) ?? 0) / 100),
    minimum: clamp01((num(d['Mnm']) ?? 0) / 100),
  };
}

/** Texture/dual-brush blend enum -> our TextureBlend (observed values). */
const BLEND_MAP: Record<string, TextureBlend> = {
  Mltp: 'multiply',
  Drkn: 'darken',
  Lghn: 'lighten',
  Scrn: 'screen',
  Sbtr: 'subtract',
  blendSubtraction: 'subtract',
  Ovrl: 'overlay',
  CDdg: 'color-dodge',
  CBrn: 'color-burn',
  linearDodge: 'color-dodge',
  linearBurn: 'linear-burn',
  LnDd: 'color-dodge',
  lnBr: 'linear-burn',
  Hght: 'height',
  linearHeight: 'height',
  hardMix: 'hard-mix',
};

function mapBlend(v: DescValue | undefined): TextureBlend {
  const e = enumVal(v);
  return (e && BLEND_MAP[e]) || 'multiply';
}

/** toolOptions 'Md' paint-mode enum -> our layer BlendMode ids. */
const PAINT_MODE_MAP: Record<string, BlendMode> = {
  Nrml: 'normal',
  Drkn: 'darken',
  Mltp: 'multiply',
  CBrn: 'color-burn',
  linearBurn: 'linear-burn',
  Lghn: 'lighten',
  Scrn: 'screen',
  CDdg: 'color-dodge',
  linearDodge: 'linear-dodge',
  Ovrl: 'overlay',
  SftL: 'soft-light',
  HrdL: 'hard-light',
  vividLight: 'vivid-light',
  linearLight: 'linear-light',
  pinLight: 'pin-light',
  Dfrn: 'difference',
  Xclu: 'exclusion',
  blendSubtraction: 'subtract',
  blendDivide: 'divide',
  H: 'hue',
  Strt: 'saturation',
  Clr: 'color',
  Lmns: 'luminosity',
};

interface TipInfo {
  tipId: string | null;
  size?: number;
  angle?: number;
  roundness?: number;
  hardness?: number;
  spacing?: number;
  flipX?: boolean;
  flipY?: boolean;
}

function mapTip(tip: Descriptor | undefined): TipInfo {
  if (!tip) return { tipId: null };
  const spacingOn = bool(tip['Intr']);
  const spacing = num(tip['Spcn']) ?? num(tip['Spcg']);
  return {
    tipId: str(tip['sampledData'])?.toLowerCase() ?? null,
    size: num(tip['Dmtr']),
    angle: num(tip['Angl']),
    roundness: num(tip['Rndn']),
    hardness: num(tip['Hrdn']),
    spacing:
      spacingOn === false ? 0.01 : spacing !== undefined ? spacing / 100 : undefined,
    flipX: bool(tip['flipX']),
    flipY: bool(tip['flipY']),
  };
}

/** Maps one brushPreset descriptor to a name/tip/pattern/settings record. */
function mapBrushDescriptor(d: Descriptor): AbrBrush {
  const tipDesc = desc(d['Brsh']);
  const tip = mapTip(tipDesc);
  const settings: BrushPatch = {};
  const tipPatch: NonNullable<BrushPatch['tip']> = {};

  if (tip.size !== undefined) tipPatch.size = Math.min(Math.max(tip.size, 1), 1000);
  if (tip.angle !== undefined) tipPatch.angle = tip.angle;
  if (tip.roundness !== undefined) tipPatch.roundness = clamp01(tip.roundness / 100) || 0.01;
  if (tip.hardness !== undefined) tipPatch.hardness = clamp01(tip.hardness / 100);
  if (tip.spacing !== undefined) tipPatch.spacing = Math.max(tip.spacing, 0.01);
  if (tip.flipX !== undefined) tipPatch.flipX = tip.flipX;
  if (tip.flipY !== undefined) tipPatch.flipY = tip.flipY;
  settings.tip = tipPatch;

  // Shape Dynamics
  if (bool(d['useTipDynamics'])) {
    const size = mapControl(desc(d['szVr']));
    const angle = mapControl(desc(d['angleDynamics']));
    const round = mapControl(desc(d['roundnessDynamics']));
    settings.shape = {
      enabled: true,
      sizeJitter: clamp01(size.jitter),
      sizeControl: size.control,
      minDiameter: clamp01((num(d['minimumDiameter']) ?? 0) / 100) || size.minimum,
      angleJitter: clamp01(angle.jitter),
      angleControl: angle.control,
      roundnessJitter: clamp01(round.jitter),
      roundnessControl: round.control,
      minRoundness: clamp01((num(d['minimumRoundness']) ?? 25) / 100),
      // top-level flipX/flipY are the flip *jitters*; the tip's own flips
      // live inside the Brsh descriptor
      flipXJitter: bool(d['flipX']) ?? false,
      flipYJitter: bool(d['flipY']) ?? false,
    };
  }

  // Scattering — amount/control in scatterDynamics, count jitter in
  // countDynamics, count in 'Cnt ', axes in bothAxes
  if (bool(d['useScatter'])) {
    const sc = mapControl(desc(d['scatterDynamics']));
    const cnt = mapControl(desc(d['countDynamics']));
    settings.scatter = {
      enabled: true,
      bothAxes: bool(d['bothAxes']) ?? false,
      // ABR stores scatter as a percentage that can reach 1000%; our model
      // uses 0..10 where 1.0 = a spread of 100% of the diameter (offsets
      // up to +-half a diameter)
      scatter: Math.min(sc.jitter, 10),
      scatterControl: sc.control,
      count: Math.min(Math.max(num(d['Cnt']) ?? 1, 1), 16),
      countJitter: clamp01(cnt.jitter),
    };
  }

  // Texture
  let texturePatternId: string | null = null;
  if (bool(d['useTexture'])) {
    const txtr = desc(d['Txtr']);
    texturePatternId = str(txtr?.['Idnt'])?.toLowerCase() ?? null;
    const depthDyn = mapControl(desc(d['textureDepthDynamics']));
    settings.texture = {
      enabled: true,
      // pattern id is resolved by the importer once patterns are registered
      scale: Math.min(Math.max((num(d['textureScale']) ?? 100) / 100, 0.01), 10),
      brightness: Math.min(1, Math.max(-1, (num(d['textureBrightness']) ?? 0) / 150)),
      contrast: Math.min(1, Math.max(-1, (num(d['textureContrast']) ?? 0) / 100)),
      invert: bool(d['InvT']) ?? false,
      mode: mapBlend(d['textureBlendMode']),
      depth: clamp01((num(d['textureDepth']) ?? 100) / 100),
      textureEachTip: bool(d['TxtC']) ?? false,
      depthJitter: clamp01(depthDyn.jitter),
      depthControl: depthDyn.control,
    };
  }

  // Transfer (paint dynamics): opVr = opacity, prVr = flow
  if (bool(d['usePaintDynamics'])) {
    const op = mapControl(desc(d['opVr']));
    const fl = mapControl(desc(d['prVr']) ?? desc(d['flVr']));
    settings.transfer = {
      enabled: true,
      opacityJitter: clamp01(op.jitter),
      opacityControl: op.control,
      opacityMin: op.minimum,
      flowJitter: clamp01(fl.jitter),
      flowControl: fl.control,
      flowMin: fl.minimum,
    };
  }

  // Color Dynamics
  if (bool(d['useColorDynamics'])) {
    const fgbg = mapControl(desc(d['clVr']));
    settings.color = {
      enabled: true,
      applyPerTip: bool(d['colorDynamicsPerTip']) ?? bool(d['perTip']) ?? true,
      fgBgJitter: clamp01(fgbg.jitter),
      fgBgControl: fgbg.control,
      hueJitter: clamp01((num(d['H']) ?? 0) / 100),
      satJitter: clamp01((num(d['Strt']) ?? 0) / 100),
      briJitter: clamp01((num(d['Brgh']) ?? 0) / 100),
      purity: Math.min(1, Math.max(-1, (num(d['purity']) ?? 0) / 100)),
    };
  }

  // Dual Brush — useDualBrush is nested inside the dualBrush descriptor
  const dualDesc = desc(d['dualBrush']);
  if (dualDesc && (bool(dualDesc['useDualBrush']) ?? bool(d['useDualBrush']))) {
    const dualTip = mapTip(desc(dualDesc['Brsh']));
    const dualScatter = mapControl(desc(dualDesc['scatterDynamics']));
    const dualCount = mapControl(desc(dualDesc['countDynamics']));
    const panelSpacing = num(dualDesc['Spcn']);
    settings.dual = {
      enabled: true,
      shape: dualTip.tipId ?? 'round',
      hardness: dualTip.hardness !== undefined ? clamp01(dualTip.hardness / 100) : 1,
      mode: mapBlend(dualDesc['BlnM']),
      size: Math.min(Math.max(dualTip.size ?? 40, 1), 1000),
      // The Dual Brush panel's Spacing slider is stored on the nested tip
      // (dualBrush.Brsh.Spcn) — verified against real Photoshop files. The
      // outer dualBrush.Spcn holds a stale default (e.g. 100) and is only a
      // last-resort fallback.
      spacing: Math.max(
        dualTip.spacing ?? (panelSpacing !== undefined ? panelSpacing / 100 : 0.25),
        0.01,
      ),
      scatter: Math.min(dualScatter.jitter, 10),
      bothAxes: bool(dualDesc['bothAxes']) ?? false,
      count: Math.min(Math.max(num(dualDesc['Cnt']) ?? 1, 1), 16),
      countJitter: clamp01(dualCount.jitter),
    };
  }

  // Options-bar state
  const tool = desc(d['toolOptions']);
  if (tool) {
    const opct = num(tool['Opct']);
    if (opct !== undefined) settings.opacity = clamp01(opct / 100);
    const flow = num(tool['flow']);
    if (flow !== undefined) settings.flow = clamp01(flow / 100);
    const smoo = num(tool['smoothingValue']) ?? num(tool['Smoo']);
    if (smoo !== undefined) settings.smoothing = clamp01(smoo / 100);
    const mode = enumVal(tool['Md']);
    if (mode && PAINT_MODE_MAP[mode]) settings.blendMode = PAINT_MODE_MAP[mode];
    const pSize = bool(tool['usePressureOverridesSize']);
    if (pSize !== undefined) settings.pressureSize = pSize;
    const pOp = bool(tool['usePressureOverridesOpacity']);
    if (pOp !== undefined) settings.pressureOpacity = pOp;
  }

  if (bool(d['Wtdg']) !== undefined) settings.wetEdges = bool(d['Wtdg']);
  if (bool(d['Nose']) !== undefined) settings.noise = bool(d['Nose']);
  if (bool(d['Rpt']) !== undefined) settings.airbrush = bool(d['Rpt']);

  return {
    name: str(d['Nm']) ?? '',
    tipId: tip.tipId,
    texturePatternId,
    settings,
  };
}

// ---------------------------------------------------------------------------
// patt section: embedded patterns as VirtualMemoryArrayList images
// (validated layout: entry len u32; version=1 u32; imageMode u32 (1=gray,
// 3=RGB); height u16; width u16; unicode name; pascal id; VMAL: version=3
// u32, length u32, rect 4xu32, maxChannels u32; per channel: written u32,
// [length u32, depth u32, rect 4xu32, pixelDepth u16, compression u8,
// data (length-23 bytes)]. Entries pad to 4 bytes.)
// ---------------------------------------------------------------------------

const MAX_PATTERN_DIM = 4096;

function parsePattEntry(r: Reader, entryEnd: number): { id: string; pattern: AbrPattern } | null {
  const version = r.u32();
  if (version !== 1) return null;
  const mode = r.u32();
  const h = r.u16();
  const w = r.u16();
  const name = r.unicode();
  const id = r.pascal().toLowerCase();
  if ((mode !== 1 && mode !== 3) || w <= 0 || h <= 0 || w > MAX_PATTERN_DIM || h > MAX_PATTERN_DIM) {
    return null;
  }

  const vmaVersion = r.u32();
  if (vmaVersion !== 3) return null;
  const vmaLen = r.u32();
  const vmaEnd = Math.min(r.pos + vmaLen, entryEnd);
  r.skip(16); // VMAL rectangle (matches w/h)
  const maxChannels = r.u32();

  const wanted = mode === 3 ? 3 : 1;
  const channels: Uint8Array[] = [];
  for (let ch = 0; ch < maxChannels + 2 && r.pos + 4 <= vmaEnd && channels.length < wanted; ch++) {
    const written = r.u32();
    if (!written) continue;
    const chLen = r.u32();
    if (chLen === 0) continue;
    const chEnd = r.pos + chLen;
    const depth = r.u32();
    const top = r.i32();
    const left = r.i32();
    const bottom = r.i32();
    const right = r.i32();
    r.u16(); // pixel depth (again)
    const compressed = r.u8() !== 0;
    const cw = right - left;
    const chH = bottom - top;
    if (depth === 8 && cw > 0 && chH > 0 && cw <= MAX_PATTERN_DIM && chH <= MAX_PATTERN_DIM) {
      const data = compressed ? readRleRows(r, chH, cw) : r.bytes(cw * chH);
      if (cw === w && chH === h) channels.push(data);
    }
    r.pos = chEnd;
  }

  if (channels.length === 0) return null;
  let gray: Uint8Array;
  if (channels.length >= 3) {
    // RGB -> luminance (Photoshop textures use the pattern's luminosity)
    gray = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.round(
        0.299 * channels[0][i] + 0.587 * channels[1][i] + 0.114 * channels[2][i],
      );
    }
  } else {
    gray = channels[0];
  }
  return { id, pattern: { name, map: resampleSquare(gray, w, h) } };
}

// ---------------------------------------------------------------------------
// Top-level parsing
// ---------------------------------------------------------------------------

/** Resolves a descriptor UUID against samp/patt ids: exact, then 35-char
 * prefix (samp UUIDs are sometimes truncated by one char), then null. */
function resolveId(id: string | null, keys: Iterable<string>): string | null {
  if (!id) return null;
  const norm = id.toLowerCase();
  const all = [...keys];
  if (all.includes(norm)) return norm;
  const prefix = norm.slice(0, 35);
  const hit = all.find((k) => k.slice(0, 35) === prefix);
  return hit ?? null;
}

function parseV6(r: Reader, version: number, subVersion: number): AbrResult {
  const tips = new Map<string, GrayMap>();
  const patterns = new Map<string, AbrPattern>();
  const sampleOrder: string[] = [];
  let described: AbrBrush[] = [];

  while (r.remaining >= 12) {
    // resync: sections are back-to-back but may carry a byte or two of
    // padding; scan a few bytes forward for the next 8BIM signature
    let found = false;
    for (let k = 0; k < 8 && r.pos + 8 <= r.length; k++) {
      if (r.peekAscii(4) === '8BIM') {
        found = true;
        break;
      }
      r.skip(1);
    }
    if (!found) break;
    r.skip(4); // 8BIM
    const key = r.ascii(4);
    const len = r.u32();
    const end = Math.min(r.pos + len, r.length);

    if (key === 'samp') {
      while (r.pos < end - 4) {
        const brushLen = r.u32();
        const brushEnd = Math.min(r.pos + brushLen + ((4 - (brushLen % 4)) % 4), end);
        try {
          const start = r.pos;
          const id = r.pascal().toLowerCase();
          // fixed header size from the record start: 47 bytes for
          // subversion 1, 301 for subversion 2+ (GIMP's values)
          r.pos = start + (subVersion <= 1 ? 47 : 301);
          const map = readSampledBitmap(r);
          if (map && id) {
            tips.set(id, map);
            sampleOrder.push(id);
          }
        } catch {
          // skip malformed brush records
        }
        r.pos = brushEnd;
      }
    } else if (key === 'desc') {
      try {
        if (r.peekU32() === 16) r.u32(); // versioned descriptor prefix
        const descriptor = parseDescriptor(r);
        const list = descriptor['Brsh'];
        if (Array.isArray(list)) {
          described = list.filter(isDesc).map(mapBrushDescriptor);
        }
      } catch (err) {
        console.warn('[northlight] ABR descriptor parse failed:', err);
      }
    } else if (key === 'patt') {
      while (r.pos + 4 < end) {
        const entryLen = r.u32();
        if (entryLen === 0 || r.pos + entryLen > end) break;
        const entryEnd = r.pos + entryLen;
        try {
          const parsed = parsePattEntry(r, entryEnd);
          if (parsed) patterns.set(parsed.id, parsed.pattern);
        } catch {
          // skip malformed pattern entries
        }
        r.pos = entryEnd + ((4 - (entryLen % 4)) % 4);
      }
    }
    r.pos = end;
  }

  // Prefer descriptor entries (they carry names + dynamics); fall back to
  // bare sampled tips when there is no usable descriptor.
  let brushes: AbrBrush[];
  if (described.length > 0) {
    let sampleIndex = 0;
    brushes = [];
    for (const b of described) {
      if (b.tipId !== null) {
        // resolve against samp ids: exact/prefix, then index order
        const resolved =
          resolveId(b.tipId, tips.keys()) ?? sampleOrder[sampleIndex] ?? null;
        sampleIndex++;
        if (!resolved) continue;
        b.tipId = resolved;
      }
      if (b.settings.dual?.enabled && typeof b.settings.dual.shape === 'string') {
        const dualResolved = resolveId(b.settings.dual.shape, tips.keys());
        if (dualResolved) b.settings.dual.shape = dualResolved;
        else if (b.settings.dual.shape.includes('-')) b.settings.dual.shape = 'round';
      }
      b.texturePatternId = resolveId(b.texturePatternId, patterns.keys());
      brushes.push(b);
    }
  } else {
    brushes = sampleOrder.map((id, i) => ({
      name: `Brush ${i + 1}`,
      tipId: id,
      texturePatternId: null,
      settings: {},
    }));
  }
  return { version, tips, patterns, brushes };
}

function parseV12(r: Reader, version: number): AbrResult {
  const tips = new Map<string, GrayMap>();
  const brushes: AbrBrush[] = [];
  const count = r.u16();

  for (let i = 0; i < count && r.remaining > 6; i++) {
    const type = r.u16();
    const size = r.u32();
    const end = r.pos + size;
    try {
      if (type === 2) {
        r.u32(); // misc
        const spacing = r.u16();
        let name = '';
        if (version === 2) name = r.unicode();
        r.u8(); // antialiasing
        r.skip(8); // short bounds
        const map = readSampledBitmap(r);
        if (map) {
          const id = `v${version}-tip-${i}`;
          tips.set(id, map);
          brushes.push({
            name: name || `Brush ${i + 1}`,
            tipId: id,
            texturePatternId: null,
            settings: {
              tip: {
                size: Math.min(map.size, 1000),
                spacing: Math.max(spacing / 100, 0.01),
              },
            },
          });
        }
      }
      // type 1 (computed) brushes carry little useful data; skip them
    } catch {
      // skip malformed brush records
    }
    r.pos = end;
  }
  return { version, tips, patterns: new Map(), brushes };
}

export function parseAbr(buf: ArrayBuffer): AbrResult {
  const r = new Reader(buf);
  if (r.length < 4) throw new Error('Not an ABR file (too short).');
  const version = r.u16();
  if (version === 1 || version === 2) {
    return parseV12(r, version);
  }
  if (version >= 6 && version <= 10) {
    const subVersion = r.u16();
    return parseV6(r, version, subVersion);
  }
  throw new Error(`Unsupported ABR version ${version}.`);
}
