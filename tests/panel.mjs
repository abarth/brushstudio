/**
 * The panel reaches every knob the engine has.
 *
 * The try-out app is where a brush is judged by hand, and a setting the panel
 * cannot reach is a setting that gets tuned by editing JSON and re-rendering
 * a plate — the slow path the app exists to avoid. Worse, it is invisible:
 * nothing about a panel missing a row says so. This walks the engine defaults
 * against `web/groups.ts` and fails in both directions, so adding a field to
 * `BrushSettings` breaks the suite until the app grows a control for it, and
 * renaming one breaks it until the control follows.
 *
 * Renderer-independent, so `run.mjs` appends it whichever backend it ran.
 */
import { build } from 'esbuild';

const ROOT = new URL('..', import.meta.url).pathname;

/** Bundles the panel table and the engine defaults together and imports them. */
async function load() {
  const { outputFiles } = await build({
    stdin: {
      contents: [
        "export { GROUPS } from './web/groups.ts';",
        "export { defaultBrush } from './src/brush/defaults.ts';",
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const b64 = Buffer.from(outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${b64}`);
}

export async function checkPanel() {
  const out = [];
  const test = (name, fn) => {
    try {
      fn();
      out.push({ name, ok: true });
    } catch (err) {
      out.push({ name, ok: false, detail: err.message });
    }
  };

  let GROUPS;
  let defaultBrush;
  try {
    ({ GROUPS, defaultBrush } = await load());
  } catch (err) {
    return [{ name: 'the panel table loads', ok: false, detail: err.message }];
  }

  // every settings path the panel binds a control to
  const covered = new Set();
  for (const group of GROUPS) {
    if (group.toggle) covered.add(`${group.toggle}.enabled`);
    for (const item of group.items) {
      if (item.row === 'paint') continue; // the paint is not a brush setting
      covered.add(item.path.join('.'));
      if (item.mode) covered.add(item.mode.join('.'));
    }
  }

  // every settings path the engine actually has
  const engine = [];
  for (const [section, value] of Object.entries(defaultBrush())) {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) engine.push(`${section}.${key}`);
    } else {
      engine.push(section);
    }
  }

  test('the panel reaches every brush setting', () => {
    const missing = engine.filter((path) => !covered.has(path));
    if (missing.length) {
      throw new Error(`no control in web/groups.ts for: ${missing.join(', ')}`);
    }
  });

  test('the panel binds nothing the engine dropped', () => {
    const stale = [...covered].filter((path) => !engine.includes(path));
    if (stale.length) {
      throw new Error(`web/groups.ts binds settings that no longer exist: ${stale.join(', ')}`);
    }
  });

  return out;
}
