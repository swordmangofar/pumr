import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * Captures the README screenshots (`docs/screenshot.png`, `docs/features/*.png`)
 * from the real frontend against the e2e fake backend, seeded with demo data:
 *
 *   pnpm docs:screenshots
 *
 * Kept out of `pnpm e2e`: the scenes are `*.docs.ts`, not `*.spec.ts`.
 */
export default defineConfig({
  ...base,
  testDir: 'e2e/docs',
  testMatch: '*.docs.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/docs',
  use: { ...base.use, trace: 'off' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      },
    },
  ],
});
