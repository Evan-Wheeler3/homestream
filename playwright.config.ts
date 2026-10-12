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
      grepInvert: /@phone/,
    },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
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
