import { deflateSync, inflateSync } from 'node:zlib';

/**
 * A PNG encoder, because there is no canvas out here.
 *
 * Plain 8-bit RGB or RGBA, one IDAT, filter type 0. Plates are large flat
 * images and deflate handles them well enough that a smarter filter would
 * buy little for the complexity.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function chunk(tag: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(tag, 'latin1'), payload]);
  let c = -1;
  for (const byte of body) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ -1) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** `rgba` is straight (un-premultiplied) RGBA8. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  // Drop a fully opaque alpha channel: plates are opaque, and RGB is a
  // quarter smaller for nothing lost.
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0; // filter: none
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const src = row + x * 4;
      raw[at++] = rgba[src];
      raw[at++] = rgba[src + 1];
      raw[at++] = rgba[src + 2];
      if (!opaque) raw[at++] = rgba[src + 3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type: RGB / RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decodes a PNG far enough to use it as a brush tip.
 *
 * 8- and 16-bit greyscale, RGB, palette and their alpha variants,
 * non-interlaced — which is everything an image editor writes by default.
 * Interlaced files are rejected with a message rather than silently
 * producing a scrambled tip.
 */
export function decodePng(bytes: Uint8Array): {
  width: number;
  height: number;
  /** straight RGBA8 */
  data: Uint8Array;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [i, b] of [0x89, 0x50, 0x4e, 0x47].entries()) {
    if (bytes[i] !== b) throw new Error('not a PNG file');
  }
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 6;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const tag = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (tag === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('interlaced PNGs are not supported — re-save without Adam7');
    } else if (tag === 'PLTE') {
      palette = body.slice();
    } else if (tag === 'tRNS') {
      transparency = body.slice();
    } else if (tag === 'IDAT') {
      idat.push(body.slice());
    } else if (tag === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (!width || !height) throw new Error('PNG has no IHDR');
  if (depth !== 8 && depth !== 16) throw new Error(`unsupported PNG bit depth ${depth}`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const bytesPerSample = depth / 8;
  const pixelBytes = channels * bytesPerSample;
  const stride = width * pixelBytes;

  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  const prior = new Uint8Array(stride);
  const line = new Uint8Array(stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    line.set(raw.subarray(src, src + stride));
    src += stride;
    unfilter(filter, line, prior, pixelBytes);
    prior.set(line);

    for (let x = 0; x < width; x++) {
      const p = x * pixelBytes;
      const sample = (i: number) => line[p + i * bytesPerSample]; // 16-bit: high byte
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colorType === 3) {
        const index = sample(0);
        r = palette![index * 3];
        g = palette![index * 3 + 1];
        b = palette![index * 3 + 2];
        if (transparency && index < transparency.length) a = transparency[index];
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = sample(0);
        if (colorType === 4) a = sample(1);
      } else {
        r = sample(0);
        g = sample(1);
        b = sample(2);
        if (colorType === 6) a = sample(3);
      }
      const dst = (y * width + x) * 4;
      out[dst] = r;
      out[dst + 1] = g;
      out[dst + 2] = b;
      out[dst + 3] = a;
    }
  }
  return { width, height, data: out };
}

/** The five PNG row filters, undone in place. */
function unfilter(filter: number, line: Uint8Array, prior: Uint8Array, bpp: number): void {
  const n = line.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i] + prior[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prior[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prior[i];
        const c = i >= bpp ? prior[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown PNG row filter ${filter}`);
  }
}
