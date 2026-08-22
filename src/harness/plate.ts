import { getTip } from '../brush/patterns';
import type { BrushSettings } from '../brush/types';
import { describeBrush } from './describe';
import {
  brushReach,
  DEFAULT_PLATE_STROKES,
  findStroke,
  TEST_STROKES,
  type TestStroke,
} from './strokes';
import { backendFactory, cpuBackend, Surface, type BackendFactory } from './surface';
import { drawText, fillRect, textHeight, wrapText } from './text';
import type { HSV } from '../types';
import type { BackendId } from '../engine/types';

/**
 * The plate: one page of marks per brush, always the same marks in the same
 * order, captioned with the settings that produced them.
 *
 * Everything here works on a plain pixel buffer — no canvas, no DOM — so a
 * plate comes out identical from either renderer and from either process.
 * Encoding it as a PNG is left to the caller, which is the one part that
 * genuinely differs between Node and a browser.
 */

export interface PlateEntry {
  label: string;
  settings: BrushSettings;
  /** optional second caption line; defaults to the settings summary */
  caption?: string;
}

export interface PlateOptions {
  width?: number;
  /** stroke ids from strokes.ts, in the order they should appear */
  strokes?: string[];
  seed?: number;
  fg?: HSV;
  bg?: HSV;
  /** paper colour behind the marks */
  paper?: [number, number, number];
  /** draw on a dark ground with light ink */
  dark?: boolean;
  /** print the "reveals" note under each row label */
  annotate?: boolean;
  /** which renderer paints the marks: an id, or a factory of your own */
  backend?: BackendId | BackendFactory;
}

export interface Plate {
  width: number;
  height: number;
  /** premultiplied RGBA8 */
  rgba: Uint8Array;
  rows: string[];
}

const TITLE_SCALE = 3;
const LABEL_SCALE = 2;
const ROW_LABEL_H = textHeight(LABEL_SCALE) + 8;
const NOTE_H = textHeight(LABEL_SCALE) + 6;
const MARGIN = 18;

const PAPER_LIGHT: [number, number, number] = [0.965, 0.949, 0.918];
const PAPER_DARK: [number, number, number] = [0.11, 0.107, 0.115];
const INK_LIGHT: HSV = { h: 24, s: 0.62, v: 0.2 };
const INK_DARK: HSV = { h: 40, s: 0.08, v: 0.96 };

interface BlockLayout {
  entry: PlateEntry;
  size: number;
  reach: number;
  height: number;
  title: string[];
  caption: string[];
  titleH: number;
  rows: { y: number; label: string; note: string; h: number }[];
}

/** Works out a brush's page without painting any of it. */
function layoutBlock(
  entry: PlateEntry,
  width: number,
  strokes: TestStroke[],
  annotate: boolean,
): BlockLayout {
  const size = entry.settings.tip.size;
  const reach = brushReach(entry.settings);
  const noteH = annotate ? NOTE_H : 0;

  // Captions wrap rather than run off the edge: a settings summary for a
  // brush with several sections on is easily wider than the plate.
  const textBox = width - 2 * MARGIN;
  const title = wrapText(entry.label, textBox, TITLE_SCALE, true);
  const caption = wrapText(entry.caption ?? describeBrush(entry.settings), textBox, LABEL_SCALE);
  const titleH =
    16 + title.length * textHeight(TITLE_SCALE) + 8 + caption.length * textHeight(LABEL_SCALE) + 12;

  const rows: BlockLayout['rows'] = [];
  let y = titleH;
  for (const stroke of strokes) {
    const h = Math.ceil(stroke.rowHeight(size, reach));
    rows.push({ y, label: stroke.label, note: stroke.reveals, h });
    y += ROW_LABEL_H + noteH + h + 10;
  }
  // room for the last row's marks to overhang its box, as diagonals do
  const height = y + Math.ceil(reach * 0.35) + 8;
  return { entry, size, reach, height, title, caption, titleH, rows };
}

export async function renderPlate(
  entries: PlateEntry[],
  options: PlateOptions = {},
): Promise<Plate> {
  const width = options.width ?? 1400;
  const annotate = options.annotate ?? false;
  const strokeIds = options.strokes?.length ? options.strokes : DEFAULT_PLATE_STROKES;
  const strokes = strokeIds.map(findStroke).filter((s): s is TestStroke => !!s);
  const noteH = annotate ? NOTE_H : 0;

  const blocks = entries.map((entry) => layoutBlock(entry, width, strokes, annotate));
  const height = blocks.reduce((a, b) => a + b.height, 0);
  if (height === 0) return { width, height: 0, rgba: new Uint8Array(0), rows: [] };

  // One surface for the whole plate rather than one per brush. On the CPU
  // renderer that is a small saving; on the GPU one it is the difference
  // between a device per brush and a device per plate, which is most of what
  // a multi-brush plate used to cost.
  const backend =
    typeof options.backend === 'string'
      ? backendFactory(options.backend)
      : options.backend ?? cpuBackend;
  const surface = await Surface.create(width, height, backend);
  const paper = options.paper ?? (options.dark ? PAPER_DARK : PAPER_LIGHT);
  surface.fill([paper[0], paper[1], paper[2], 1]);

  const fg = options.fg ?? (options.dark ? INK_DARK : INK_LIGHT);
  const bg = options.bg ?? (options.dark ? INK_LIGHT : INK_DARK);
  let seed = options.seed ?? 1;
  let offset = 0;
  for (const block of blocks) {
    strokes.forEach((stroke, i) => {
      const row = block.rows[i];
      const box = {
        x: MARGIN + block.reach * 0.6,
        y: offset + row.y + ROW_LABEL_H + noteH,
        width: Math.max(200, width - 2 * MARGIN - block.reach * 1.2),
        height: row.h,
      };
      for (const path of stroke.paths(box, block.size, block.reach)) {
        surface.paint(block.entry.settings, path, { fg, bg, seed: seed++ });
      }
    });
    offset += block.height;
  }

  const rgba = (await surface.read()).slice();
  surface.destroy();

  // --- captions and rules, over the marks ---------------------------------
  const dark = !!options.dark;
  const ink: [number, number, number] = dark ? [0.91, 0.9, 0.88] : [0.11, 0.08, 0.06];
  const dim: [number, number, number] = dark ? [0.55, 0.54, 0.52] : [0.48, 0.44, 0.4];
  const rule: [number, number, number, number] = dark
    ? [0.16, 0.16, 0.18, 1]
    : [0.87, 0.84, 0.79, 1];

  offset = 0;
  const rowLabels: string[] = [];
  for (const block of blocks) {
    let textY = offset + 16;
    for (const line of block.title) {
      drawText(rgba, width, height, line, MARGIN, textY, {
        scale: TITLE_SCALE,
        color: ink,
        bold: true,
      });
      textY += textHeight(TITLE_SCALE);
    }
    textY += 8;
    for (const line of block.caption) {
      drawText(rgba, width, height, line, MARGIN, textY, { scale: LABEL_SCALE, color: dim });
      textY += textHeight(LABEL_SCALE);
    }

    for (const row of block.rows) {
      drawText(rgba, width, height, row.label, MARGIN, offset + row.y, {
        scale: LABEL_SCALE,
        color: dim,
        bold: true,
      });
      if (annotate) {
        drawText(rgba, width, height, row.note, MARGIN, offset + row.y + ROW_LABEL_H, {
          scale: LABEL_SCALE,
          color: dim,
        });
      }
      rowLabels.push(`${block.entry.label} / ${row.label}`);
    }

    offset += block.height;
    if (offset < height) fillRect(rgba, width, height, 0, offset - 1, width, 1, rule);
  }

  return { width, height, rgba, rows: rowLabels };
}

/**
 * A grid of raw tip bitmaps. Reading an unfamiliar .abr starts here: the
 * marks a pack is built from say more about it than its parameter dump.
 */
export function renderTipSheet(
  tips: { id: string; label: string }[],
  options: { cell?: number; columns?: number; dark?: boolean } = {},
): Plate {
  const cell = options.cell ?? 150;
  const columns = options.columns ?? Math.min(8, Math.max(1, tips.length));
  const rowCount = Math.ceil(tips.length / columns);
  const labelH = textHeight(LABEL_SCALE) + 10;
  const width = columns * cell;
  const height = rowCount * (cell + labelH) + 8;
  const rgba = new Uint8Array(width * height * 4);
  const dark = !!options.dark;

  fillRect(rgba, width, height, 0, 0, width, height, dark ? [0.08, 0.08, 0.09, 1] : [0.97, 0.955, 0.93, 1]);

  const inset = 8;
  const box = cell - inset * 2;
  tips.forEach((tip, i) => {
    const map = getTip(tip.id);
    const cx = (i % columns) * cell + inset;
    const cy = Math.floor(i / columns) * (cell + labelH) + inset;
    // nearest-neighbour downscale: a tip map is 128-1024px and the cell is
    // ~134, so this is a decimation, and a box filter would only hide the
    // grain that is the point of looking
    for (let y = 0; y < box; y++) {
      const sy = Math.min(map.size - 1, Math.floor(((y + 0.5) / box) * map.size));
      for (let x = 0; x < box; x++) {
        const sx = Math.min(map.size - 1, Math.floor(((x + 0.5) / box) * map.size));
        const v = map.data[sy * map.size + sx];
        const shade = dark ? v : 255 - v;
        const idx = ((cy + y) * width + cx + x) * 4;
        rgba[idx] = shade;
        rgba[idx + 1] = shade;
        rgba[idx + 2] = shade;
        rgba[idx + 3] = 255;
      }
    }
    drawText(rgba, width, height, `${tip.label} (${map.size}px)`, cx, cy + box + 4, {
      scale: LABEL_SCALE,
      color: dark ? [0.78, 0.77, 0.75] : [0.27, 0.24, 0.2],
    });
  });

  return { width, height, rgba, rows: tips.map((t) => t.label) };
}

/** Premultiplied RGBA -> straight RGBA, which is what a PNG stores. */
export function unpremultiply(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    const inv = a > 0 ? 255 / a : 0;
    out[i] = Math.min(255, Math.round(rgba[i] * inv));
    out[i + 1] = Math.min(255, Math.round(rgba[i + 1] * inv));
    out[i + 2] = Math.min(255, Math.round(rgba[i + 2] * inv));
    out[i + 3] = a;
  }
  return out;
}

export const PLATE_STROKE_IDS = TEST_STROKES.map((s) => s.id);
