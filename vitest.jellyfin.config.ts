import { defineConfig } from 'vitest/config';

// Live integration tests against a real Jellyfin server. Requires
// JELLYFIN_TEST_URL, JELLYFIN_TEST_USER and JELLYFIN_TEST_PASSWORD.
export default defineConfig({
  test: {
    include: ['tests/jellyfin/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    fileParallelism: false,
  },
});
