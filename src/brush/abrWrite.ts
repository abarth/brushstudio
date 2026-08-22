import { getPattern, getTip, type GrayMap } from './patterns';
import type {
  BrushSettings, ControlSource, DynamicControl, TextureBlend, TipShape,
} from './types';
import type { BlendMode } from '../types';

/**
 * Photoshop .abr writer (version 6.2) — the inverse of abr.ts.
 *
 * Emits the same three sections a real Photoshop brush file carries:
 * '8BIM samp' (sampled tip bitmaps), '8BIM patt' (texture patterns) and
 * '8BIM desc' (the Actions-format descriptor holding names and dynamics).
 * Layouts and key spellings were taken from the reference files parsed by
 * abr.ts, and the byte-level details below were read back out of a genuine
 * Photoshop file rather than guessed:
 *
 * - the sampled-brush record carries a 301-byte header before the bitmap,
 *   with the bounding rect stored twice and two internal lengths expressed
 *   relative to the record length,
 * - descriptor and pattern strings are NUL-terminated UTF-16BE (Photoshop
 *   stores "Nm" of an 18-character name with a count of 19),
 * - pattern channels use the VirtualMemoryArrayList layout, maxChannels 24,
 * - percentages are unit floats ('UntF' '#Prc'), the options-bar Opacity and
 *   Flow in toolOptions included — Photoshop drops a percentage that arrives
 *   as a 'long' and paints with whatever the tool is currently set to,
 * - and every descriptor is classed (see writeDesc).
 *
 * Round-tripping through parseAbr is covered in tests/gpu.spec.mjs.
 */

export interface AbrExportBrush {
  name: string;
  settings: BrushSettings;
}

// ---------------------------------------------------------------------------
// byte writer
// ---------------------------------------------------------------------------

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  get length(): number {
    return this.len;
  }

  u8(x: number): this {
    this.ensure(1);
    this.buf[this.len++] = x & 0xff;
    return this;
  }

  u16(x: number): this {
    return this.u8(x >>> 8).u8(x);
  }

  u32(x: number): this {
    return this.u16(Math.floor(x / 65536)).u16(x & 0xffff);
  }

  i32(x: number): this {
    return this.u32(x < 0 ? x + 0x100000000 : x);
  }

  f64(x: number): this {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x);
    for (let i = 0; i < 8; i++) this.u8(dv.getUint8(i));
    return this;
  }

  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }

  /** Photoshop unicode string: u32 count + UTF-16BE, NUL-terminated. */
  unicode(s: string): this {
    this.u32(s.length + 1);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this.u16(0);
  }

  pascal(s: string): this {
    return this.u8(s.length).ascii(s);
  }

  /** Descriptor key: u32 length (0 means the common 4-char case) + ascii. */
  key(s: string): this {
    return s.length === 4 ? this.u32(0).ascii(s) : this.u32(s.length).ascii(s);
  }

  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }

  raw(d: Uint8Array): this {
    this.ensure(d.length);
    this.buf.set(d, this.len);
    this.len += d.length;
    return this;
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** PackBits-encodes one row, the compression Photoshop uses for tip rows. */
function packBits(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && row[i + run] === row[i] && run < 128) run++;
    if (run >= 3) {
      out.push(256 - (run - 1), row[i]);
      i += run;
    } else {
      const start = i;
      i++;
      while (i < row.length && i - start < 128) {
        if (i + 2 < row.length && row[i] === row[i + 1] && row[i] === row[i + 2]) break;
        i++;
      }
      out.push(i - start - 1);
      for (let k = start; k < i; k++) out.push(row[k]);
    }
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// descriptor DSL
// ---------------------------------------------------------------------------

type Emit = (w: ByteWriter) => void;
type Entry = [string, Emit];

/**
 * Every descriptor carries a class id naming what it is, and Photoshop needs
 * them: it rejects a file whose tip descriptor is not classed
 * `computedBrush` or `sampledBrush` with "unknown brush type" — the class IS
 * the brush type. A lenient reader (abr.ts included) discards class ids
 * entirely, so a round trip through the parser cannot catch a wrong one.
 * The ids used here were read out of a genuine Photoshop file: brushPreset
 * per brush, computedBrush/sampledBrush per tip, brVr on every dynamics
 * object, dualBrush, brushGroup, Ptrn on the texture, PbTl on toolOptions.
 */
function writeDesc(w: ByteWriter, items: Entry[], classId = 'null'): void {
  w.unicode('');
  w.key(classId);
  w.u32(items.length);
  for (const [k, fn] of items) {
    w.key(k);
    fn(w);
  }
}

const T = {
  untf: (unit: string, v: number): Emit => (w) => { w.ascii('UntF').ascii(unit).f64(v); },
  text: (s: string): Emit => (w) => { w.ascii('TEXT').unicode(s); },
  bool: (v: boolean): Emit => (w) => { w.ascii('bool').u8(v ? 1 : 0); },
  long: (n: number): Emit => (w) => { w.ascii('long').i32(Math.round(n)); },
  enm: (t: string, v: string): Emit => (w) => { w.ascii('enum').key(t).key(v); },
  objc: (items: Entry[], classId = 'null'): Emit => (w) => {
    w.ascii('Objc');
    writeDesc(w, items, classId);
  },
  list: (items: Emit[]): Emit => (w) => {
    w.ascii('VlLs').u32(items.length);
    for (const fn of items) fn(w);
  },
};

/** bVTy control ids, the inverse of abr.ts's CONTROL_MAP. */
const CONTROL_BVTY: Record<ControlSource, number> = {
  off: 0, fade: 1, pressure: 2, tilt: 3, 'initial-direction': 5, direction: 6, rotation: 7,
};

/** Photoshop's dynamics-variance object. Percentages, not fractions. */
function dyn(control: DynamicControl, jitterPct: number, minPct = 0): Emit {
  return T.objc([
    ['bVTy', T.long(CONTROL_BVTY[control.source] ?? 0)],
    ['fStp', T.long(Math.max(1, Math.round(control.fadeSteps)))],
    ['jitter', T.untf('#Prc', jitterPct)],
    ['Mnm ', T.untf('#Prc', minPct)],
  ], 'brVr');
}

const BLEND_ENUM: Record<TextureBlend, string> = {
  multiply: 'Mltp', subtract: 'Sbtr', darken: 'Drkn', overlay: 'Ovrl', height: 'Hght',
  lighten: 'Lghn', screen: 'Scrn', 'color-dodge': 'CDdg', 'color-burn': 'CBrn',
  'linear-burn': 'lnBr', 'hard-mix': 'hardMix',
};

const PAINT_MODE_ENUM: Record<BlendMode, string> = {
  normal: 'Nrml', darken: 'Drkn', multiply: 'Mltp', 'color-burn': 'CBrn',
  'linear-burn': 'linearBurn', lighten: 'Lghn', screen: 'Scrn', 'color-dodge': 'CDdg',
  'linear-dodge': 'linearDodge', overlay: 'Ovrl', 'soft-light': 'SftL', 'hard-light': 'HrdL',
  'vivid-light': 'vividLight', 'linear-light': 'linearLight', 'pin-light': 'pinLight',
  difference: 'Dfrn', exclusion: 'Xclu', subtract: 'blendSubtraction', divide: 'blendDivide',
  hue: 'H   ', saturation: 'Strt', color: 'Clr ', luminosity: 'Lmns',
};

// ---------------------------------------------------------------------------
// stable ids
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic UUID for a tip or pattern id, so re-exporting the same
 * brushes yields byte-identical ids (and diffable files).
 */
function uuidFor(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const rng = mulberry32(h);
  let hex = '';
  for (let i = 0; i < 32; i++) hex += Math.floor(rng() * 16).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// samp: sampled tip bitmaps
// ---------------------------------------------------------------------------

interface Bitmap {
  w: number;
  h: number;
  data: Uint8Array;
}

/**
 * Crops a padded square tip map down to its ink. Photoshop stores tips
 * cropped, and the crop is what carries the mark's aspect ratio — a chisel
 * padded into a square would otherwise import as a circle.
 */
function cropToInk(map: GrayMap): Bitmap {
  const { size, data } = map;
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return { w: size, h: size, data: new Uint8Array(data) };
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    out.set(data.subarray((y + minY) * size + minX, (y + minY) * size + minX + w), y * w);
  }
  return { w, h, data: out };
}

/**
 * One sampled-brush record. The 301-byte header holds the id, the bounding
 * rect (twice) and two lengths defined relative to the record length; the
 * eight trailing zero bytes mirror what Photoshop writes.
 */
function writeSampRecord(w: ByteWriter, uuid: string, bmp: Bitmap): void {
  const rows = new ByteWriter();
  const counts: number[] = [];
  for (let y = 0; y < bmp.h; y++) {
    const packed = packBits(bmp.data.subarray(y * bmp.w, (y + 1) * bmp.w));
    counts.push(packed.length);
    rows.raw(packed);
  }
  const dataLen = bmp.h * 2 + rows.length;
  const recLen = 328 + dataLen;

  w.u32(recLen);
  const rect = (t: ByteWriter) => t.i32(0).i32(0).i32(bmp.h).i32(bmp.w);
  w.pascal(uuid); // '$' doubles as the length byte for a 36-char uuid
  w.u16(1).u32(0).u16(3);
  w.u32(recLen - 49);
  rect(w);
  w.u32(56);
  w.zeros(223);
  w.u8(1);
  w.u32(recLen - 305);
  w.u32(8);
  rect(w);
  w.u16(8).u8(1); // 8-bit, RLE
  for (const c of counts) w.u16(c);
  w.raw(rows.bytes());
  w.zeros(8);
  // records are padded to a 4-byte boundary, and the padding sits outside the
  // declared record length (abr.ts advances by len + pad)
  w.zeros((4 - (recLen % 4)) % 4);
}

// ---------------------------------------------------------------------------
// patt: texture patterns
// ---------------------------------------------------------------------------

function writePattEntry(w: ByteWriter, uuid: string, name: string, map: GrayMap): void {
  const { size, data } = map;

  const ch = new ByteWriter();
  ch.u32(8); // depth
  ch.i32(0).i32(0).i32(size).i32(size);
  ch.u16(8); // pixel depth
  ch.u8(0); // uncompressed, as Photoshop writes for patterns
  ch.raw(data);

  const vma = new ByteWriter();
  vma.i32(0).i32(0).i32(size).i32(size);
  vma.u32(24); // maxChannels
  vma.u32(1); // channel 0 written
  vma.u32(ch.length);
  vma.raw(ch.bytes());
  for (let i = 1; i < 26; i++) vma.u32(0); // remaining channels unwritten

  const entry = new ByteWriter();
  entry.u32(1); // version
  entry.u32(1); // image mode: grayscale
  entry.u16(size).u16(size);
  entry.unicode(name);
  entry.pascal(uuid);
  entry.u32(3); // VirtualMemoryArrayList version
  entry.u32(vma.length);
  entry.raw(vma.bytes());

  w.u32(entry.length);
  w.raw(entry.bytes());
  while (w.length % 4 !== 0) w.u8(0);
}

// ---------------------------------------------------------------------------
// desc: one brushPreset descriptor per brush
// ---------------------------------------------------------------------------

const pct = (x: number) => x * 100;

function tipDescriptor(
  shape: TipShape,
  size: number,
  angle: number,
  roundness: number,
  hardness: number,
  spacing: number,
  flipX: boolean,
  flipY: boolean,
  uuid: string | null,
): Emit {
  const items: Entry[] = [
    ['Dmtr', T.untf('#Pxl', size)],
    ['Hrdn', T.untf('#Prc', pct(hardness))],
    ['Angl', T.untf('#Ang', angle)],
    ['Rndn', T.untf('#Prc', pct(roundness))],
    ['Nm  ', T.text(String(shape))],
    ['Spcn', T.untf('#Prc', pct(spacing))],
    ['Intr', T.bool(true)],
    ['flipX', T.bool(flipX)],
    ['flipY', T.bool(flipY)],
  ];
  if (uuid) items.push(['sampledData', T.text(uuid)]);
  // the class is what tells Photoshop which kind of tip this is
  return T.objc(items, uuid ? 'sampledBrush' : 'computedBrush');
}

function brushPreset(
  brush: AbrExportBrush,
  tipUuid: string | null,
  dualUuid: string | null,
  pattern: { uuid: string; name: string } | null,
): Emit {
  const s = brush.settings;
  const items: Entry[] = [
    ['Nm  ', T.text(brush.name)],
    ['Brsh', tipDescriptor(s.tip.shape, s.tip.size, s.tip.angle, s.tip.roundness,
      s.tip.hardness, s.tip.spacing, s.tip.flipX, s.tip.flipY, tipUuid)],
    ['useTipDynamics', T.bool(s.shape.enabled)],
    ['flipX', T.bool(s.shape.flipXJitter)],
    ['flipY', T.bool(s.shape.flipYJitter)],
    ['brushProjection', T.bool(false)],
    ['minimumDiameter', T.untf('#Prc', pct(s.shape.minDiameter))],
    ['minimumRoundness', T.untf('#Prc', pct(s.shape.minRoundness))],
    ['tiltScale', T.untf('#Prc', 200)],
    ['szVr', dyn(s.shape.sizeControl, pct(s.shape.sizeJitter))],
    ['angleDynamics', dyn(s.shape.angleControl, pct(s.shape.angleJitter))],
    ['roundnessDynamics', dyn(s.shape.roundnessControl, pct(s.shape.roundnessJitter))],
    ['useScatter', T.bool(s.scatter.enabled)],
  ];

  if (s.scatter.enabled) {
    items.push(
      ['bothAxes', T.bool(s.scatter.bothAxes)],
      ['Cnt ', T.long(s.scatter.count)],
      ['scatterDynamics', dyn(s.scatter.scatterControl, pct(s.scatter.scatter))],
      ['countDynamics', dyn({ source: 'off', fadeSteps: 1 }, pct(s.scatter.countJitter))],
    );
  }

  // useDualBrush lives inside the dualBrush descriptor, as in real files
  const d = s.dual;
  items.push(['dualBrush', T.objc(
    d.enabled
      ? [
          ['useDualBrush', T.bool(true)],
          ['Flip', T.bool(false)],
          ['Brsh', tipDescriptor(d.shape, d.size, 0, 1, d.hardness, d.spacing,
            false, false, dualUuid)],
          ['BlnM', T.enm('BlnM', BLEND_ENUM[d.mode] ?? 'Mltp')],
          ['useScatter', T.bool(d.scatter > 0)],
          ['Spcn', T.untf('#Prc', pct(d.spacing))],
          ['Cnt ', T.long(d.count)],
          ['bothAxes', T.bool(d.bothAxes)],
          ['countDynamics', dyn({ source: 'off', fadeSteps: 1 }, pct(d.countJitter))],
          ['scatterDynamics', dyn({ source: 'off', fadeSteps: 25 }, pct(d.scatter))],
        ]
      : [['useDualBrush', T.bool(false)]],
    'dualBrush',
  )]);

  items.push(['brushGroup', T.objc([['useBrushGroup', T.bool(false)]], 'brushGroup')]);

  const tx = s.texture;
  items.push(['useTexture', T.bool(tx.enabled && !!pattern)]);
  if (tx.enabled && pattern) {
    items.push(
      ['Txtr', T.objc([['Nm  ', T.text(pattern.name)], ['Idnt', T.text(pattern.uuid)]], 'Ptrn')],
      ['interpretation', T.bool(true)],
      ['textureScale', T.untf('#Prc', pct(tx.scale))],
      ['textureBlendMode', T.enm('BlnM', BLEND_ENUM[tx.mode] ?? 'Mltp')],
      ['textureDepth', T.untf('#Prc', pct(tx.depth))],
      ['minimumDepth', T.untf('#Prc', 0)],
      ['InvT', T.bool(tx.invert)],
      ['TxtC', T.bool(tx.textureEachTip)],
      // abr.ts reads brightness back over 150 and contrast over 100
      ['textureBrightness', T.long(tx.brightness * 150)],
      ['textureContrast', T.long(tx.contrast * 100)],
      ['textureDepthDynamics', dyn(tx.depthControl, pct(tx.depthJitter))],
    );
  }

  const tr = s.transfer;
  items.push(['usePaintDynamics', T.bool(tr.enabled)]);
  if (tr.enabled) {
    items.push(
      ['opVr', dyn(tr.opacityControl, pct(tr.opacityJitter), pct(tr.opacityMin))],
      ['prVr', dyn(tr.flowControl, pct(tr.flowJitter), pct(tr.flowMin))],
    );
  }

  const c = s.color;
  items.push(['useColorDynamics', T.bool(c.enabled)]);
  if (c.enabled) {
    items.push(
      ['colorDynamicsPerTip', T.bool(c.applyPerTip)],
      ['clVr', dyn(c.fgBgControl, pct(c.fgBgJitter))],
      ['H   ', T.untf('#Prc', pct(c.hueJitter))],
      ['Strt', T.untf('#Prc', pct(c.satJitter))],
      ['Brgh', T.untf('#Prc', pct(c.briJitter))],
      ['purity', T.untf('#Prc', pct(c.purity))],
    );
  }

  items.push(
    ['Wtdg', T.bool(s.wetEdges)],
    ['Nose', T.bool(s.noise)],
    ['Rpt ', T.bool(s.airbrush)],
    ['useBrushSize', T.bool(true)],
    ['useBrushPose', T.bool(false)],
    ['toolOptions', T.objc([
      ['brushPreset', T.bool(true)],
      // Opacity and Flow are percentages like every other one in the file,
      // and abr.ts's num() unwraps a unit float and a long alike — so a round
      // trip through our own parser cannot tell the two apart. The byte-level
      // expectation in tests/cases.mjs is what holds these types in place.
      ['flow', T.untf('#Prc', pct(s.flow))],
      ['Smoo', T.long(0)],
      ['Md  ', T.enm('BlnM', PAINT_MODE_ENUM[s.blendMode] ?? 'Nrml')],
      ['Opct', T.untf('#Prc', pct(s.opacity))],
      ['smoothing', T.bool(true)],
      ['smoothingValue', T.long(pct(s.smoothing))],
      ['usePressureOverridesSize', T.bool(s.pressureSize)],
      ['usePressureOverridesOpacity', T.bool(s.pressureOpacity)],
      ['useLegacy', T.bool(false)],
    ], 'PbTl')],
  );

  return T.objc(items, 'brushPreset');
}

// ---------------------------------------------------------------------------
// top level
// ---------------------------------------------------------------------------

const section = (file: ByteWriter, key: string, body: ByteWriter) => {
  file.ascii('8BIM').ascii(key).u32(body.length).raw(body.bytes());
};

/**
 * Serializes brush presets to a Photoshop .abr file (version 6.2). Every
 * sampled tip they reference, and any texture pattern, is embedded.
 */
export function writeAbr(brushes: AbrExportBrush[]): ArrayBuffer {
  // ---- gather the bitmaps the presets reference ----
  const tipUuids = new Map<string, string>();
  const tipOrder: string[] = [];
  const useTip = (shape: TipShape): string | null => {
    if (shape === 'round') return null; // computed, no bitmap needed
    const id = String(shape);
    let uuid = tipUuids.get(id);
    if (!uuid) {
      uuid = uuidFor(`tip:${id}`);
      tipUuids.set(id, uuid);
      tipOrder.push(id);
    }
    return uuid;
  };

  const pattUuids = new Map<string, string>();
  const pattOrder: string[] = [];
  const usePattern = (id: string): { uuid: string; name: string } => {
    let uuid = pattUuids.get(id);
    if (!uuid) {
      uuid = uuidFor(`patt:${id}`);
      pattUuids.set(id, uuid);
      pattOrder.push(id);
    }
    return { uuid, name: id };
  };

  const resolved = brushes.map((b) => ({
    brush: b,
    tipUuid: useTip(b.settings.tip.shape),
    dualUuid: b.settings.dual.enabled ? useTip(b.settings.dual.shape) : null,
    pattern: b.settings.texture.enabled ? usePattern(String(b.settings.texture.pattern)) : null,
  }));

  const file = new ByteWriter();
  file.u16(6).u16(2); // version 6, subversion 2

  const samp = new ByteWriter();
  for (const id of tipOrder) writeSampRecord(samp, tipUuids.get(id)!, cropToInk(getTip(id)));
  section(file, 'samp', samp);

  if (pattOrder.length > 0) {
    const patt = new ByteWriter();
    for (const id of pattOrder) writePattEntry(patt, pattUuids.get(id)!, id, getPattern(id));
    section(file, 'patt', patt);
  }

  const desc = new ByteWriter();
  desc.u32(16); // versioned-descriptor prefix
  writeDesc(desc, [['Brsh', T.list(
    resolved.map((r) => brushPreset(r.brush, r.tipUuid, r.dualUuid, r.pattern)),
  )]]);
  section(file, 'desc', desc);

  const bytes = file.bytes();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
