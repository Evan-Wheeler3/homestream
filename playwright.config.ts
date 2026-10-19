import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the production build against the built-in sample library
// with a throwaway database, so they never touch real data.
const PORT = 4310;
// The config is evaluated again in each test worker; reuse the main process's choice.
const dataDir = (process.env.WH_E2E_DATA ??= path.join(
  os.tmpdir(),
  `wheelhouse-e2e-${Date.now()}`,
));
// Disc ripping runs against stand-in tools (e2e/fixtures/bin); a test "inserts"
// a disc by creating a folder in this Volumes directory.
const volumesDir = path.join(dataDir, 'Volumes');
process.env.WH_E2E_VOLUMES = volumesDir;
const fixtures = path.resolve('e2e/fixtures/bin');

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    // The app's service worker (offline downloads) is only allowed in tests that use it.
    serviceWorkers: 'block',
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 860 } },
      grepInvert: /@phone|@tv/,
    },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
    {
      // The new LG webOS browser, which TV mode must detect on its own.
      name: 'tv',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (Linux; NetCast; U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 SmartTV/10.0 Colt/2.0',
      },
      grep: /@tv/,
    },
  ],
  webServer: {
    command: `npm run build && node -e "for (const d of ['Volumes','Rips','Movies']) require('fs').mkdirSync(require('path').join(process.env.DATA_DIR, d), { recursive: true })" && node dist/server/index.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MEDIA_SOURCE: 'mock',
      MOCK_PASSWORD: 'demo',
      DATA_DIR: dataDir,
      RIPPER_ENABLED: 'true',
      DISC_VOLUMES_DIR: volumesDir,
      RIPS_DIR: path.join(dataDir, 'Rips'),
      MOVIES_DIR: path.join(dataDir, 'Movies'),
      MAKEMKVCON: path.join(fixtures, 'makemkvcon.cjs'),
      HANDBRAKE_CLI: path.join(fixtures, 'HandBrakeCLI.cjs'),
      RIP_MIN_FREE_GB: '0',
      RIP_POLL_MS: '1000',
    },
  },
});
