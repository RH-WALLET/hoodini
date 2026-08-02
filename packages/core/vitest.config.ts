import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only: every test here runs against a stub client, never the
    // network. Chain-dependent verification is the harness's job, so the suite
    // stays deterministic and offline.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
