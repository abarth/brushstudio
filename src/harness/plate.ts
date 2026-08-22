import { getTip } from '../brush/patterns';
import type { BrushSettings } from '../brush/types';
import { describeBrush } from './describe';
import { brushReach, DEFAULT_PLATE_STROKES, findStroke, TEST_STROKES } from './strokes';
import { Surface } from './surface';
import type { HSV } from '../types';

/**
 * The plate: one page of marks per brush, always the same marks in the same
 * order, captioned with the settings that produced them. It is what gets
 * shown to a human reviewer and what two revisions get diffed as.
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
}

export interface PlateResult {
  width: number;
  height: number;
  /** the finished plate as a PNG data URL */
  png: string;
  rows: string[];
}

const TITLE_H = 52;
const ROW_LABEL_H = 22;
const MARGIN = 18;

const PAPER_LIGHT: [number, number, number] = [0.965, 0.949, 0.918];
const PAPER_DARK: [number, number, number] = [0.11, 0.107, 0.115];
const INK_LIGHT: HSV = { h: 24, s: 0.62, v: 0.2 };
const INK_DARK: HSV = { h: 40, s: 0.08, v: 0.96 };

/** Paints one brush's marks and hands back the pixels plus row geometry. */
async function paintBlock(
  entry: PlateEntry,
  width: number,
  opts: Required<Pick<PlateOptions, 'strokes' | 'seed' | 'annotate'>> & PlateOptions,
): Promise<{ data: Uint8Array; height: number; rows: { y: number; label: string; note: string }[] }> {
  const size = entry.settings.tip.size;
  const reach = brushReach(entry.settings);
  const chosen = opts.strokes.map(findStroke).filter((s): s is NonNullable<typeof s> => !!s);
  const noteH = opts.annotate ? 16 : 0;

  const rows: { y: number; label: string; note: string; h: number }[] = [];
  let y = TITLE_H;
  for (const stroke of chosen) {
    const h = Math.ceil(stroke.rowHeight(size, reach));
    rows.push({ y, label: stroke.label, note: stroke.reveals, h });
    y += ROW_LABEL_H + noteH + h + 10;
  }
  const height = y + 8;

  const surface = await Surface.create(width, height);
  const paper = opts.paper ?? (opts.dark ? PAPER_DARK : PAPER_LIGHT);
  surface.fill([paper[0], paper[1], paper[2], 1]);

  const fg = opts.fg ?? (opts.dark ? INK_DARK : INK_LIGHT);
  const bg = opts.bg ?? (opts.dark ? INK_LIGHT : INK_DARK);
  let seed = opts.seed;
  chosen.forEach((stroke, i) => {
    const row = rows[i];
    const box = {
      x: MARGIN + reach * 0.6,
      y: row.y + ROW_LABEL_H + noteH,
      width: Math.max(200, width - 2 * MARGIN - reach * 1.2),
      height: row.h,
    };
    for (const path of stroke.paths(box, size, reach)) {
      surface.paint(entry.settings, path, { fg, bg, seed: seed++ });
    }
  });

  return { data: await surface.read(), height, rows };
}

/** Un-premultiplies engine output into something a 2D canvas can take. */
function toImageData(data: Uint8Array, width: number, height: number): ImageData {
  const img = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    const inv = a > 0 ? 255 / a : 0;
    img.data[i * 4] = Math.min(255, data[i * 4] * inv);
    img.data[i * 4 + 1] = Math.min(255, data[i * 4 + 1] * inv);
    img.data[i * 4 + 2] = Math.min(255, data[i * 4 + 2] * inv);
    img.data[i * 4 + 3] = a;
  }
  return img;
}

export async function renderPlate(
  entries: PlateEntry[],
  options: PlateOptions = {},
): Promise<PlateResult> {
  const width = options.width ?? 1400;
  const opts = {
    ...options,
    strokes: options.strokes?.length ? options.strokes : DEFAULT_PLATE_STROKES,
    seed: options.seed ?? 1,
    annotate: options.annotate ?? false,
  };

  const blocks = [];
  for (const entry of entries) blocks.push({ entry, ...(await paintBlock(entry, width, opts)) });

  const height = blocks.reduce((a, b) => a + b.height, 0);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const dark = !!options.dark;
  const textColor = dark ? '#e8e6e1' : '#1b1510';
  const dimColor = dark ? '#8d8a85' : '#7a7166';

  let offset = 0;
  const rowLabels: string[] = [];
  for (const block of blocks) {
    ctx.putImageData(toImageData(block.data, width, block.height), 0, offset);
    ctx.fillStyle = textColor;
    ctx.font = '700 21px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(block.entry.label, MARGIN, offset + 26);
    ctx.fillStyle = dimColor;
    ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(block.entry.caption ?? describeBrush(block.entry.settings), MARGIN, offset + 44);

    for (const row of block.rows) {
      ctx.fillStyle = dimColor;
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(row.label, MARGIN, offset + row.y + 14);
      if (opts.annotate) {
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(row.note, MARGIN, offset + row.y + 30);
      }
      rowLabels.push(`${block.entry.label} / ${row.label}`);
    }

    offset += block.height;
    ctx.strokeStyle = dark ? '#2a2a2e' : '#ded7c9';
    ctx.beginPath();
    ctx.moveTo(0, offset - 0.5);
    ctx.lineTo(width, offset - 0.5);
    ctx.stroke();
  }

  return { width, height, png: canvas.toDataURL('image/png'), rows: rowLabels };
}

/**
 * A grid of raw tip bitmaps. Reading an unfamiliar .abr starts here: the
 * marks a pack is built from say more about it than its parameter dump.
 */
export function renderTipSheet(
  tips: { id: string; label: string }[],
  options: { cell?: number; columns?: number; dark?: boolean } = {},
): PlateResult {
  const cell = options.cell ?? 150;
  const columns = options.columns ?? Math.min(8, Math.max(1, tips.length));
  const rows = Math.ceil(tips.length / columns);
  const labelH = 22;
  const width = columns * cell;
  const height = rows * (cell + labelH) + 8;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const dark = !!options.dark;
  ctx.fillStyle = dark ? '#141416' : '#f7f4ee';
  ctx.fillRect(0, 0, width, height);

  tips.forEach((tip, i) => {
    const map = getTip(tip.id);
    const cx = (i % columns) * cell;
    const cy = Math.floor(i / columns) * (cell + labelH);
    const img = new ImageData(map.size, map.size);
    for (let p = 0; p < map.size * map.size; p++) {
      const v = dark ? map.data[p] : 255 - map.data[p];
      img.data[p * 4] = v;
      img.data[p * 4 + 1] = v;
      img.data[p * 4 + 2] = v;
      img.data[p * 4 + 3] = 255;
    }
    const scratch = document.createElement('canvas');
    scratch.width = map.size;
    scratch.height = map.size;
    scratch.getContext('2d')!.putImageData(img, 0, 0);
    const inset = 8;
    ctx.drawImage(scratch, cx + inset, cy + inset, cell - inset * 2, cell - inset * 2);
    ctx.fillStyle = dark ? '#3a3a3e' : '#e2dcd0';
    ctx.strokeRect(cx + inset - 0.5, cy + inset - 0.5, cell - inset * 2 + 1, cell - inset * 2 + 1);
    ctx.fillStyle = dark ? '#c9c6c1' : '#463d33';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    const label = tip.label.length > 22 ? `${tip.label.slice(0, 21)}…` : tip.label;
    ctx.fillText(`${label} (${map.size}px)`, cx + inset, cy + cell + 14);
  });

  return { width, height, png: canvas.toDataURL('image/png'), rows: tips.map((t) => t.label) };
}

export const PLATE_STROKE_IDS = TEST_STROKES.map((s) => s.id);
