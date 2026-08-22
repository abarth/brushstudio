#!/usr/bin/env node
/**
 * texture-sheet — composite `fractal-tip --swatch` outputs into one labelled
 * contact sheet, for judging candidate textures side by side before any of
 * them earns a family.
 *
 *   node tools/fractal-tip.mjs cand.spec.json --swatch 25,55,85
 *   node tools/texture-sheet.mjs --dir swatches --rows nickel,leather -o out/sheet.png
 *
 * Each row is one candidate: its continuous height field, then ink at each
 * threshold the swatches were cut at (discovered from the files present).
 * Labels use the harness's own plate font, so sheets diff cleanly run to run.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeGrayPng, encodeGrayPng } from './lib/dsp.mjs';
import { loadCpuHarness } from './lib/harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DIR = arg('--dir');
const ROWS = (arg('--rows') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = arg('-o', 'out/texture-sheet.png');
const TILE = Number(arg('--tile', 256));
if (!DIR || !ROWS.length) {
  console.error('usage: node tools/texture-sheet.mjs --dir <swatch dir> --rows a,b,c [-o sheet.png] [--tile 256]');
  process.exit(1);
}

const { drawText, textHeight, textWidth } = await loadCpuHarness();

// column set: the field plus every threshold present for the first row
const suffixes = ['field'];
for (const f of readdirSync(DIR).sort()) {
  const m = f.match(new RegExp(`^${ROWS[0]}\\.t(\\d+)\\.png$`));
  if (m) suffixes.push(`t${m[1]}`);
}
const colLabel = (s) => (s === 'field' ? 'height field' : `ink ${s.slice(1)}%`);

const GUT = 6;
const HEAD = textHeight(2) + 10;
const ROWLBL = textHeight(2) + 8;
const W = suffixes.length * TILE + (suffixes.length + 1) * GUT;
const H = HEAD + ROWS.length * (TILE + ROWLBL) + (ROWS.length + 1) * GUT;

// RGBA workspace so drawText can blend; collapsed to grayscale at the end
const rgba = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 235;
  rgba[i * 4 + 3] = 255;
}

function blit(path, ox, oy, invert) {
  const { width, data } = decodeGrayPng(readFileSync(path));
  const s = width / TILE;
  if (s !== Math.round(s)) throw new Error(`${path}: ${width}px does not downsample to ${TILE}`);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let acc = 0;
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) acc += data[(y * s + dy) * width + (x * s + dx)];
      }
      let v = Math.round(acc / (s * s));
      if (invert) v = 255 - v;
      const i = ((oy + y) * W + ox + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    }
  }
}

suffixes.forEach((s, col) => {
  const x = GUT + col * (TILE + GUT);
  drawText(rgba, W, H, colLabel(s), x + (TILE - textWidth(colLabel(s), 2)) / 2, 5, { scale: 2 });
});

ROWS.forEach((name, row) => {
  const top = HEAD + GUT + row * (TILE + ROWLBL + GUT);
  drawText(rgba, W, H, name, GUT, top, { scale: 2, bold: true });
  suffixes.forEach((s, col) => {
    // the field is a height map shown as-is; threshold cuts are ink on paper
    blit(join(DIR, `${name}.${s}.png`), GUT + col * (TILE + GUT), top + ROWLBL, s !== 'field');
  });
});

const gray = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) gray[i] = rgba[i * 4];
writeFileSync(OUT, encodeGrayPng(gray, W, H));
console.log(`sheet ${W}x${H}, ${ROWS.length} rows x ${suffixes.length} cols -> ${OUT}`);
