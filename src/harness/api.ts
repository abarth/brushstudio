import * as commands from './commands';
import { unpremultiply, type Plate } from './plate';
import { Surface } from './surface';

/**
 * The browser front end: the command layer plus the two things only a
 * browser can do — decode an image file, and encode a PNG — exposed on
 * `window` for the CLI's `--backend gpu` path and for console poking.
 *
 * Marks can be painted by either renderer from in here, which is what the
 * parity test uses: it runs both against the same page and diffs the pixels.
 */

function toPngDataUrl(plate: Plate): string {
  const canvas = document.createElement('canvas');
  canvas.width = plate.width;
  canvas.height = plate.height;
  const straight = new Uint8ClampedArray(unpremultiply(plate.rgba));
  canvas.getContext('2d')!.putImageData(new ImageData(straight, plate.width, plate.height), 0, 0);
  return canvas.toDataURL('image/png');
}

const withPng = <T extends Plate>(plate: T) => ({
  width: plate.width,
  height: plate.height,
  rows: plate.rows,
  png: toPngDataUrl(plate),
  ...('warnings' in plate ? { warnings: (plate as { warnings: string[] }).warnings } : {}),
});

const api = {
  ready: true,
  ...commands,
  catalog: commands.CATALOG,
  Surface,
  toPngDataUrl,

  plate: async (...args: Parameters<typeof commands.plate>) =>
    withPng(await commands.plate(...args)),
  comparePlate: async (...args: Parameters<typeof commands.comparePlate>) =>
    withPng(await commands.comparePlate(...args)),
  renderPlate: async (...args: Parameters<typeof commands.renderPlate>) =>
    withPng(await commands.renderPlate(...args)),
  renderTipSheet: (...args: Parameters<typeof commands.renderTipSheet>) =>
    withPng(commands.renderTipSheet(...args)),
};

declare global {
  interface Window {
    __brushstudio?: typeof api;
  }
}

window.__brushstudio = api;

export type BrushStudioApi = typeof api;
