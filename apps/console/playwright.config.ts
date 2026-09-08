import { defineConfig } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * There is deliberately **no `webServer`**. The specs serve the built artifact
 * themselves through request interception, so the whole suite runs against the
 * real bundle in a real browser without binding a port or leaving a process
 * behind. That also means the tests exercise exactly what `vite build` produced,
 * not a development transform of it.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    browserName: 'chromium',
    headless: true,
    // A desktop operator viewport; one spec overrides it to check the reflow.
    viewport: { width: 1280, height: 900 },
    baseURL: 'https://console.test/',
  },
});
