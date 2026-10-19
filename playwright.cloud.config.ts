import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Browser tests for the cloud edition. By default they run against Cloudflare's
// local simulator (wrangler dev) with a throwaway database and storage, seeded
// through the Mac API. Set CLOUD_URL (plus E2E_USERNAME / E2E_PASSWORD for an
// existing account) to run the read-only checks against the deployed site.
const PORT = 8790;
const deployed = process.env.CLOUD_URL;
// PW_CHANNEL=chrome uses the installed Google Chrome instead of Playwright's own.
const channel = () => (process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const persist = (process.env.WH_CLOUD_E2E ??= path.join(
  os.tmpdir(),
  `wheelhouse-cloud-e2e-${Date.now()}`,
));

export default defineConfig({
  testDir: 'e2e-cloud',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e-cloud/setup.ts',
  use: {
    baseURL: deployed ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 860 }, ...channel() },
      grepInvert: /@phone|@tv/,
    },
    { name: 'phone', use: { ...devices['Pixel 7'], ...channel() }, grep: /@phone/ },
    {
      name: 'tv',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        ...channel(),
        userAgent:
          'Mozilla/5.0 (Linux; NetCast; U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 SmartTV/10.0 Colt/2.0',
      },
      grep: /@tv/,
    },
  ],
  webServer: deployed
    ? undefined
    : {
        command: [
          'npm run build:client',
          `npx wrangler d1 migrations apply wheelhouse --local --persist-to "${persist}"`,
          `npx wrangler r2 object put wheelhouse-media/movies/e2e-1/video.mp4 --file assets/sample/sample.mp4 --content-type video/mp4 --local --persist-to "${persist}"`,
          `npx wrangler r2 object put wheelhouse-media/movies/e2e-2/video.mp4 --file assets/sample/sample.mp4 --content-type video/mp4 --local --persist-to "${persist}"`,
          `npx wrangler r2 object put wheelhouse-media/movies/e2e-1/subtitles.eng.disc.vtt --file assets/sample/sample.en.vtt --content-type text/vtt --local --persist-to "${persist}"`,
          `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to "${persist}"`,
        ].join(' && '),
        url: `http://127.0.0.1:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 180_000,
      },
});
