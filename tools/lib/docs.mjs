/**
 * Brush documents on disk: reading them, following their asset references,
 * and writing what comes back out of the harness.
 *
 * Asset paths inside a document are relative to that document, which is what
 * a designer expects but not something the page can resolve. Everything is
 * rewritten to an absolute path here and shipped alongside as base64, so the
 * page only ever sees bytes.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
}

/** Reads a brush document and every file it references. */
export function loadDoc(path, assets = {}) {
  const abs = resolve(path);
  const doc = readJson(abs);
  if (!doc.settings) throw new Error(`${path}: a brush document needs a "settings" object`);
  doc.id ??= basename(abs).replace(/\.(brush\.)?json$/i, '');
  doc.name ??= doc.id;

  for (const section of ['tips', 'patterns']) {
    for (const [key, src] of Object.entries(doc[section] ?? {})) {
      for (const field of ['abr', 'image']) {
        if (typeof src[field] !== 'string') continue;
        const file = resolve(dirname(abs), src[field]);
        try {
          assets[file] ??= { path: file, data: readFileSync(file).toString('base64') };
        } catch (err) {
          throw new Error(`${path}: ${section}.${key}.${field} — ${err.message}`);
        }
        src[field] = file;
      }
    }
  }
  return { doc, assets };
}

/**
 * Loads brush documents from files, directories, or a pack file — a pack
 * being `{ name, brushes: [...paths] }`, which is also what an .abr export
 * is built from.
 */
export function loadDocs(paths) {
  const assets = {};
  const docs = [];
  const packs = [];
  const add = (p) => {
    const json = readJson(p);
    if (Array.isArray(json.brushes)) {
      packs.push({ name: json.name ?? basename(p, '.json'), path: p });
      for (const entry of json.brushes) add(resolve(dirname(resolve(p)), entry));
      return;
    }
    docs.push(loadDoc(p, assets).doc);
  };
  for (const p of paths) {
    let stat;
    try {
      stat = statSync(p);
    } catch {
      throw new Error(`no such brush document: ${p}`);
    }
    if (stat.isDirectory()) {
      const files = readdirSync(p)
        .filter((f) => f.endsWith('.json'))
        .sort();
      if (files.length === 0) throw new Error(`${p}: no .json brush documents here`);
      for (const f of files) add(join(p, f));
    } else {
      add(p);
    }
  }
  if (docs.length === 0) throw new Error('no brush documents given');
  return { docs, assets, packs };
}

/** Reads a plain file (an .abr reference, say) into the asset bag. */
export function loadAsset(path, assets) {
  const file = resolve(path);
  assets[file] ??= { path: file, data: readFileSync(file).toString('base64') };
  return file;
}

export function writeOut(path, data) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, data);
  return path;
}

export function writePngDataUrl(path, dataUrl) {
  return writeOut(path, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

export function writeBase64(path, b64) {
  return writeOut(path, Buffer.from(b64, 'base64'));
}
