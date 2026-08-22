import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Two entry points share one bundle of engine code:
 *
 *   index.html    the try-out app — a human paints with a brush by hand
 *   harness.html  the headless surface the CLI drives through Playwright
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  server: {
    // The CLI holds the page open for the length of a command. With HMR on,
    // saving any file mid-run reloads it and the command dies with
    // "execution context was destroyed" — so the harness runs without it.
    hmr: process.env.BRUSHSTUDIO_HEADLESS ? false : undefined,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        harness: resolve(import.meta.dirname, 'harness.html'),
      },
    },
  },
});
