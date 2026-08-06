/**
 * Landing page invariants.
 *
 * The page displays a contract address people will copy and send funds to, so
 * the parts that matter are checked rather than eyeballed.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_SURFACES,
  NEVER_PAGE_ACCESSIBLE,
  isAllowed,
  type RequestType,
} from '../../../apps/extension/src/background/protocol.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(
  resolve(fileURLToPath(import.meta.url), '../../../../docs/index.html'),
  'utf8',
);

/**
 * Prose assertions run against whitespace-normalised text: HTML line-wrapping
 * is arbitrary and splits phrases across lines, so matching the raw source
 * would fail on reformatting rather than on a missing disclosure.
 */
const prose = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('token contract address', () => {
  it('is a hard-coded constant, never fetched', () => {
    // If the page fetched its CA, a compromised endpoint could swap the address
    // visitors copy. That is the single most damaging thing this page could do.
    expect(html).toMatch(/const TOKEN_CA = '/);
    expect(html).not.toMatch(/fetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest|EventSource|WebSocket/);
  });

  it('loads no third-party script or resource', () => {
    // Also keeps the page free of analytics, which PRIVACY.md promises.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/googletagmanager|google-analytics|plausible|fathom/i);

    // Every `<link>` that would cause a fetch. `rel="canonical"` is excluded by
    // name because it is metadata a crawler reads and never a request the
    // browser makes — the assertion is about network activity, not about the
    // string "https" appearing in the head. Stylesheets, icons, preloads and
    // preconnects all still fail here.
    for (const [tag, rel] of [...html.matchAll(/<link\s[^>]*rel="([a-z-]+)"[^>]*>/gi)].map((m) => [m[0], m[1]])) {
      if (rel === 'canonical') continue;
      expect(tag, `${rel} link would fetch from a third party`).not.toMatch(/href="https?:/i);
    }
  });

  it('renders nothing copyable unless the address is well formed', () => {
    const guard = html.match(/\/\^0x\[0-9a-fA-F\]\{40\}\$\//);
    expect(guard).not.toBeNull();
    // The copy button starts hidden and is only revealed inside that branch.
    expect(html).toMatch(/id="copy" hidden/);
  });

  it('does not currently ship a placeholder that looks like a real address', () => {
    const m = html.match(/const TOKEN_CA = '([^']*)'/);
    const value = m?.[1] ?? '';
    // Either empty (not launched) or a genuine address — never 0x000…, never
    // a truncated stub someone might paste into a wallet.
    if (value !== '') expect(value).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(value).not.toMatch(/^0x0{40}$/);
  });
});

describe('required disclosures', () => {
  it('carries the Robinhood non-affiliation disclaimer', () => {
    // Required by D-015: the name sits on Robinhood Chain and must not imply
    // endorsement by Robinhood Markets, Inc.
    expect(prose).toMatch(/not affiliated with[^.]{0,80}Robinhood Markets, Inc/i);
  });

  it('states the risk plainly rather than only promising upside', () => {
    expect(prose).toMatch(/you can lose everything|Trading is risky/i);
  });

  it('tells people to verify the contract address independently', () => {
    expect(prose).toMatch(/verify the contract address/i);
  });

  it('does not claim to be on the Chrome Web Store before it is', () => {
    expect(prose).toMatch(/not yet on the Chrome Web Store/i);
  });
});


/**
 * The security section has to agree with the code it describes.
 *
 * This section is the page's central credibility claim, and it went stale
 * without anyone noticing: it said a page holds "a fixed list of four
 * capabilities" long after the real list had reached nine, and it described
 * `settings.get` as read-only after `settings.setPresets` had made preset
 * editing page-writable. Both drifted in the flattering direction — the site
 * claimed a tighter boundary than the extension actually enforces, which is the
 * worst direction for a claim like this to be wrong in.
 *
 * So the page is pinned against the same exact list the boundary test pins, and
 * widening the surface now fails here too until somebody updates the page.
 */
describe('the trust boundary section matches the shipped surface policy', () => {
  const pageAllowed = (Object.keys(ALLOWED_SURFACES) as RequestType[])
    .filter((t) => isAllowed(t, 'page'))
    .sort();

  it('names every capability a page actually holds', () => {
    for (const cap of pageAllowed) {
      expect(html, `${cap} is page-allowed but the page does not mention it`).toContain(cap);
    }
  });

  it('states the right number of them in the prose', () => {
    // Nine today. The word, not the digit — it is written out in the sentence.
    const words = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
    expect(prose).toContain(`exact list of ${words[pageAllowed.length]} capabilities`);
  });

  it('draws exactly that many as crossing the boundary', () => {
    const allowed = [...html.matchAll(/class="cap"[^>]*data-cap="([a-z]+)"/g)];
    expect(allowed).toHaveLength(pageAllowed.length);
  });

  it('does not claim a capability is refused when it is allowed', () => {
    // The specific error this test exists for: the page said writing settings
    // was refused, while `settings.setPresets` was reachable from a page.
    for (const cap of pageAllowed) {
      const denied = new RegExp(`data-cap="[a-z]+"[^>]*aria-label="${cap.replace('.', '\\.')}, permanently refused"`);
      expect(html, `${cap} is allowed but drawn as refused`).not.toMatch(denied);
    }
  });

  it('never draws a never-page-accessible capability as allowed', () => {
    for (const cap of NEVER_PAGE_ACCESSIBLE) {
      const asAllowed = new RegExp(`class="cap"[^>]*aria-label="${cap.replace('.', '\\.')}, allowed"`);
      expect(html, `${cap} may never reach a page but is drawn as allowed`).not.toMatch(asAllowed);
    }
  });
});

/**
 * Link previews. This page is handed around as a URL pasted into X and Telegram
 * — the two sites the extension itself runs on — so a blank card is the first
 * impression most people ever get of the project.
 */
describe('link preview metadata', () => {
  it.each(['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card'])('declares %s', (tag) => {
    expect(html).toMatch(new RegExp(`(property|name)="${tag}"`));
  });

  it('points at absolute URLs, which is the whole requirement', () => {
    // A crawler does not resolve a relative one, so a relative og:image is the
    // same as having none.
    const img = html.match(/(?:property|name)="og:image"\s+content="([^"]+)"/)?.[1];
    expect(img).toMatch(/^https:\/\//);
  });

  it('keeps the page free of network requests of its own', () => {
    // The same property the extension claims. The favicon is inlined as a data
    // URI rather than fetched for exactly this reason.
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)="https?:\/\/(?!rh-wallet\.github\.io)/);
  });
});
