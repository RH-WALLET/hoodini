import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Adapters are DOM code; jsdom lets them be tested without a browser.
  test: { include: ['test/**/*.test.ts'], environment: 'jsdom' },
});
