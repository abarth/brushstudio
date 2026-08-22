/**
 * Brings up the harness in a headless browser.
 *
 * The brush engine is WebGPU code, so there is no Node-only path to a
 * rendered mark: every command runs against a real page. Vite serves the
 * TypeScript directly, so the CLI works straight after `npm install` with no
 * build step, and Chromium runs WebGPU on SwiftShader so it does not need a
 * GPU to be present.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

const ROOT = new URL('../..', import.meta.url).pathname;

/**
 * Where Chromium lives. Sandboxes and CI images often ship a browser that
 * predates the pinned Playwright, and `playwright install` may be blocked
 * there, so an existing one is used when the pinned download is absent.
 */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync(PREINSTALLED_CHROMIUM)) return PREINSTALLED_CHROMIUM;
  return undefined; // let Playwright use the browser it installed
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Starts vite, opens the harness page, and returns it with a teardown. */
export async function openHarness({ verbose = false } = {}) {
  const port = process.env.PORT ? Number(process.env.PORT) : await freePort();
  const viteBin = new URL('../../node_modules/vite/bin/vite.js', import.meta.url).pathname;
  const server = spawn(
    process.execPath,
    [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: ROOT,
      stdio: ['ignore', verbose ? 'inherit' : 'ignore', 'inherit'],
      env: { ...process.env, BRUSHSTUDIO_HEADLESS: '1' },
    },
  );
  let serverDead = false;
  server.on('exit', () => {
    serverDead = true;
  });

  const killServer = () => {
    if (!serverDead) server.kill();
  };

  /**
   * Tear-down that survives an interrupt.
   *
   * `process.on('exit')` alone is not enough: it does not run for SIGINT or
   * SIGTERM, which is exactly how this gets stopped in practice — a Ctrl-C,
   * or a `timeout` around the command. Without this, the dev server and a
   * whole Chromium tree are left behind holding the CPU, and the next run
   * is measured against them.
   */
  const teardown = { run: killServer };
  const onExit = () => teardown.run();
  const onSignal = (signal) => {
    teardown.run();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('exit', onExit);
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    return await connect(server, port, { verbose, killServer, teardown });
  } catch (err) {
    killServer();
    throw err;
  }
}

async function connect(server, port, { verbose, killServer, teardown }) {
  const url = `http://127.0.0.1:${port}/harness.html`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error('vite exited before serving the harness');
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: [
      '--no-sandbox',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--enable-webgpu-developer-features',
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    if (verbose) console.error('[page]', e.message);
  });
  page.on('console', (m) => {
    if (verbose) console.error(`[console.${m.type()}]`, m.text());
  });
  await page.goto(url);
  try {
    await page.waitForFunction(() => !!window.__brushstudio?.ready, null, { timeout: 60_000 });
  } catch (err) {
    await browser.close().catch(() => {});
    if (errors.length) throw new Error(`harness failed to load:\n  ${errors.join('\n  ')}`);
    throw err;
  }

  // From here an interrupt has a browser to clean up as well. `kill()` is
  // the synchronous path a signal handler can actually finish.
  teardown.run = () => {
    try {
      browser.process()?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    killServer();
  };

  const close = async () => {
    await browser.close().catch(() => {});
    killServer();
  };
  return { page, close, errors };
}

/** Opens the harness, runs one call against it, and always tears down. */
export async function withHarness(fn, opts = {}) {
  const { page, close } = await openHarness(opts);
  try {
    return await fn(page);
  } finally {
    await close();
  }
}
