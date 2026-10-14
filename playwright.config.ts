import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the production build against the built-in sample library
// with a throwaway database, so they never touch real data.
const PORT = 4310;
const dataDir = path.join(os.tmpdir(), `wheelhouse-e2e-${Date.now()}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
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
    command: 'npm run build && node dist/server/index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MEDIA_SOURCE: 'mock',
      MOCK_PASSWORD: 'demo',
      DATA_DIR: dataDir,
    },
  },
});
