/**
 * Loading the harness, whichever renderer is asked for.
 *
 * The CPU path runs in this process: the TypeScript is bundled with esbuild
 * (a few tens of milliseconds, cached on disk by content) and imported. The
 * GPU path is the browser one — see page.mjs — and exists so a design can be
 * checked against the renderer the interactive app uses.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withHarness } from './page.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const CACHE_DIR = join(ROOT, 'node_modules', '.brushstudio');

/** Newest mtime under src/, so an edit invalidates the cached bundle. */
function sourceStamp(dir = join(ROOT, 'src'), acc = { at: 0 }) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceStamp(path, acc);
    else if (entry.name.endsWith('.ts')) acc.at = Math.max(acc.at, statSync(path).mtimeMs);
  }
  return acc.at;
}

let cached = null;

/** Bundles `src/node/api.ts` for this process and imports it. */
export async function loadCpuHarness() {
  if (cached) return cached;
  const stamp = createHash('sha1')
    .update(`${sourceStamp()}:${process.version}`)
    .digest('hex')
    .slice(0, 16);
  const out = join(CACHE_DIR, `api-${stamp}.mjs`);
  if (!existsSync(out)) {
    const { build } = await import('esbuild');
    mkdirSync(CACHE_DIR, { recursive: true });
    await build({
      entryPoints: [resolve(ROOT, 'src/node/api.ts')],
      outfile: out,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      sourcemap: 'inline',
      // the WebGPU engine is reachable from the shared modules but never
      // called here; leaving it in costs a few KB and keeps the graph honest
      logLevel: 'silent',
    });
  }
  cached = await import(pathToFileURL(out).href);
  return cached;
}

/**
 * Runs one command against the chosen renderer.
 *
 * `cpu` gets the module directly. `gpu` gets a proxy that forwards the call
 * into the page and returns what comes back, with PNGs converted from the
 * data URLs the browser produces into the Buffers the CLI writes — so a
 * command reads the same either way.
 */
export async function withBackend(backend, fn, opts = {}) {
  if (backend === 'cpu') return fn(await loadCpuHarness());
  return withHarness(async (page) => {
    const call = (name) => async (...args) => {
      const result = await page.evaluate(
        ([name, args]) => window.__brushstudio[name](...args),
        [name, args],
      );
      if (result && typeof result.png === 'string') {
        return { ...result, png: Buffer.from(result.png.split(',')[1], 'base64') };
      }
      if (result && typeof result.abr === 'string') {
        return { ...result, abr: Buffer.from(result.abr, 'base64') };
      }
      return result;
    };
    // Every command that paints has to be *told* to paint with WebGPU: the
    // shared command layer defaults to the CPU renderer, so forwarding the
    // options through untouched would quietly run the CPU renderer inside
    // the browser and report it as a GPU run.
    const paint = (name, optionIndex) => {
      const forward = call(name);
      return (...args) => {
        const withBackend = args.slice();
        while (withBackend.length < optionIndex) withBackend.push(undefined);
        withBackend[optionIndex] = { ...(withBackend[optionIndex] ?? {}), backend: 'gpu' };
        return forward(...withBackend);
      };
    };

    return fn({
      catalog: await page.evaluate(() => window.__brushstudio.catalog),
      plate: paint('plate', 2),
      comparePlate: paint('comparePlate', 3),
      measure: paint('measure', 2),
      renderEntries: paint('renderPlate', 1),
      resolvedSettings: call('resolvedSettings'),
      exportAbr: call('exportAbr'),
      inspectAbr: async (bytes, path) =>
        call('inspectAbr')(Buffer.from(bytes).toString('base64'), path),
      tipSheet: call('renderTipSheet'),
      abrEntries: async (bytes, path, want, label) =>
        call('abrEntries')(Buffer.from(bytes).toString('base64'), path, want, label),
    });
  }, opts);
}

export function readAsset(path) {
  return readFileSync(resolve(path));
}
