import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Some tests solve real proofs of work, spawn node or drive Chromium, which is slower on CI runners.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
