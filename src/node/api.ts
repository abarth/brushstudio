import type { GrayMap } from '../brush/patterns';
import * as commands from '../harness/commands';
import { unpremultiply, type Plate } from '../harness/plate';
import { decodePng, encodePng } from './png';

/**
 * The Node front end.
 *
 * Same commands as the browser build, with the two environment-specific
 * pieces supplied for Node: a PNG decoder for image-sourced tips, and a PNG
 * encoder for finished plates. Marks are painted by the CPU renderer, so
 * nothing here needs a browser, a GPU, or a readback.
 */

/** Decodes a grayscale image into a square alpha map (white = ink). */
async function decodeImage(bytes: ArrayBuffer): Promise<GrayMap> {
  const image = decodePng(new Uint8Array(bytes));
  const size = Math.max(image.width, image.height);
  const data = new Uint8Array(size * size);
  // centre a non-square image in the square, like the .abr importer does
  const offX = Math.floor((size - image.width) / 2);
  const offY = Math.floor((size - image.height) / 2);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const src = (y * image.width + x) * 4;
      const lum =
        0.299 * image.data[src] + 0.587 * image.data[src + 1] + 0.114 * image.data[src + 2];
      data[(y + offY) * size + x + offX] = Math.round((lum * image.data[src + 3]) / 255);
    }
  }
  return { size, data };
}

const CONTEXT: commands.CommandContext = { backend: 'cpu', decodeImage };

export function toPng(plate: Plate): Buffer {
  return encodePng(unpremultiply(plate.rgba), plate.width, plate.height);
}

const withPng = <T extends Plate>(plate: T) => ({
  width: plate.width,
  height: plate.height,
  rows: plate.rows,
  png: toPng(plate),
  ...('warnings' in plate ? { warnings: (plate as { warnings: string[] }).warnings } : {}),
});

export const catalog = commands.CATALOG;

// The environment-neutral half of the surface, so a test or a script sees
// the same API whichever front end it loaded.
export {
  Surface,
  backendFactory,
  cpuBackend,
  defaultBrush,
  describeBrush,
  diffFromDefaults,
  explainBrush,
  getPattern,
  getTip,
  makeBrush,
  measureBrush,
  registerPattern,
  registerTip,
  renderPlate,
  resolveBrush,
} from '../harness/commands';

// The plate's bitmap type, for tools that label their own images (e.g.
// tools/texture-sheet.mjs) — captions everywhere should come from the same
// font for the same reason the plate's do: identical output on every host.
export { drawText, fillRect, textHeight, textWidth } from '../harness/text';

export async function plate(
  docs: Parameters<typeof commands.plate>[0],
  assets: Parameters<typeof commands.plate>[1],
  opts: Parameters<typeof commands.plate>[2] = {},
) {
  return withPng(await commands.plate(docs, assets, { ...CONTEXT, ...opts }));
}

export async function comparePlate(
  docs: Parameters<typeof commands.comparePlate>[0],
  assets: Parameters<typeof commands.comparePlate>[1],
  refs: Parameters<typeof commands.comparePlate>[2],
  opts: Parameters<typeof commands.comparePlate>[3] = {},
) {
  return withPng(await commands.comparePlate(docs, assets, refs, { ...CONTEXT, ...opts }));
}

export function tipSheet(
  tips: Parameters<typeof commands.renderTipSheet>[0],
  opts: Parameters<typeof commands.renderTipSheet>[1] = {},
) {
  return withPng(commands.renderTipSheet(tips, opts));
}

export async function measure(
  docs: Parameters<typeof commands.measure>[0],
  assets: Parameters<typeof commands.measure>[1],
  opts: Parameters<typeof commands.measure>[2] = {},
) {
  return commands.measure(docs, assets, { ...CONTEXT, ...opts });
}

export async function resolvedSettings(
  docs: Parameters<typeof commands.resolvedSettings>[0],
  assets: Parameters<typeof commands.resolvedSettings>[1],
) {
  return commands.resolvedSettings(docs, assets, CONTEXT);
}

export async function exportAbr(
  docs: Parameters<typeof commands.exportAbr>[0],
  assets: Parameters<typeof commands.exportAbr>[1],
) {
  const result = await commands.exportAbr(docs, assets, CONTEXT);
  return { ...result, abr: Buffer.from(result.abr, 'base64') };
}

export const inspectAbr = commands.inspectAbr;
export const dumpAbr = commands.dumpAbr;
export const compareAbrDescriptors = commands.compareAbrDescriptors;
export const abrShape = commands.abrShape;
export const abrEntries = commands.abrEntries;

export async function renderEntries(
  entries: Parameters<typeof commands.renderPlate>[0],
  opts: Parameters<typeof commands.renderPlate>[1] = {},
) {
  return withPng(await commands.renderPlate(entries, opts));
}
