import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.js';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    // Readable output: a reviewer (and the Chrome Web Store) should be able to
    // follow the shipped bundle back to this source.
    minify: false,
    sourcemap: true,
    target: 'esnext',
  },
});
