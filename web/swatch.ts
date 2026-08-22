import type { GrayMap } from '../src/brush/patterns';

/**
 * Bitmap swatches for the panel.
 *
 * A tip or a pattern is a grayscale map, and which one is in a slot is not
 * something a parameter list can tell you — "fiber-drag" and "wisp-filament"
 * are two words until you have seen them. The swatch is the same picture the
 * CLI's tip sheet draws, in the panel next to the picker that changes it.
 */

/** Swatch edge in CSS pixels; the canvas is rasterised at device resolution. */
export const SWATCH = 88;

/**
 * Draws a gray map into a canvas, white for ink.
 *
 * Sampling is nearest-neighbour, for the same reason `renderTipSheet` uses
 * it: a map is 128-1024px and the swatch is a couple of hundred device
 * pixels, so this is a decimation, and a box filter would average away
 * exactly the grain you are choosing between.
 *
 * `shade` maps a raw 0..1 map value to what is drawn — the texture swatch
 * passes the engine's own brightness/contrast/invert through it, so the
 * picture is the one the stroke will be carved with.
 */
export function drawSwatch(
  canvas: HTMLCanvasElement,
  map: GrayMap,
  shade: (v: number) => number = (v) => v,
): void {
  const px = Math.round(SWATCH * Math.min(2, devicePixelRatio || 1));
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${SWATCH}px`;
  canvas.style.height = `${SWATCH}px`;
  const img = new ImageData(px, px);
  for (let y = 0; y < px; y++) {
    const sy = Math.min(map.size - 1, Math.floor(((y + 0.5) / px) * map.size));
    for (let x = 0; x < px; x++) {
      const sx = Math.min(map.size - 1, Math.floor(((x + 0.5) / px) * map.size));
      const v = Math.round(Math.min(1, Math.max(0, shade(map.data[sy * map.size + sx] / 255))) * 255);
      const i = (y * px + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  canvas.getContext('2d')!.putImageData(img, 0, 0);
}
