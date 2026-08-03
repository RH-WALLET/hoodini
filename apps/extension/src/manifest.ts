import { defineManifest } from '@crxjs/vite-plugin';

/**
 * MV3 manifest.
 *
 * Deliberately small. Every permission here has to justify itself, because the
 * permission list is the most legible security claim a user can check
 * (CLAUDE.md invariant 3).
 */
export default defineManifest({
  manifest_version: 3,
  name: 'Hoodini',
  version: '0.0.1',
  description: '0% non-custodial trading overlay for Robinhood Chain.',

  // `storage` only. No `tabs`, no `<all_urls>`, no `webRequest`, no `cookies`.
  permissions: ['storage'],

  // The public RPC, and nothing else. Site adapters add their own narrow hosts
  // in P3/P4; until then the extension can reach exactly one origin.
  host_permissions: ['https://rpc.mainnet.chain.robinhood.com/*'],

  background: { service_worker: 'src/background/index.ts', type: 'module' },

  action: { default_popup: 'src/popup/index.html', default_title: 'Hoodini' },

  content_scripts: [
    {
      // Narrow on purpose: a placeholder that matches nothing broad. P3 widens
      // this to the specific terminal it supports.
      matches: ['https://axiom.trade/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],

  // No 'unsafe-eval', no 'wasm-unsafe-eval', no remote script origins.
  // This is what makes "no remote code" enforceable rather than aspirational.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' https://rpc.mainnet.chain.robinhood.com",
  },
});
