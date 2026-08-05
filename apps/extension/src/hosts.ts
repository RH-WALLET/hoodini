/**
 * Where the overlay runs, listed once.
 *
 * A leaf module on purpose. The manifest is built at *build* time and imports
 * `defineManifest` from the CRXJS plugin; the popup runs in a browser. Sharing
 * this list by importing the manifest pulls the build plugin — and through it
 * Vite's internals — into the extension bundle, which fails the build outright.
 * Nothing here imports anything.
 *
 * One list rather than two: the popup answers "is Hoodini active on this tab?"
 * from the same source the manifest is generated from, so a site added in one
 * place cannot go missing in the other (D-064).
 *
 * Each host is explicit. No wildcards across TLDs, no `<all_urls>`: this is the
 * clearest statement of where the extension can read, and a user should be able
 * to check it at a glance.
 */

export const SUPPORTED_MATCHES = [
  'https://axiom.trade/*',
  'https://gmgn.ai/*',
  'https://trade.padre.gg/*',
  'https://x.com/*',
  'https://www.x.com/*',
  'https://web.telegram.org/*',
  'https://dexscreener.com/*',
] as const;

/**
 * Just the hostnames, for matching a tab URL.
 *
 * Parsed from the match patterns rather than written out again, so the two can
 * never disagree about what `https://www.x.com/*` means.
 */
export const SUPPORTED_HOSTS: readonly string[] = SUPPORTED_MATCHES.map(
  (m) => new URL(m.replace('/*', '/')).hostname,
);
