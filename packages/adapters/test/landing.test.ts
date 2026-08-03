/**
 * Landing page invariants.
 *
 * The page displays a contract address people will copy and send funds to, so
 * the parts that matter are checked rather than eyeballed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(
  resolve(fileURLToPath(import.meta.url), '../../../../docs/landing/index.html'),
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
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(html).not.toMatch(/googletagmanager|google-analytics|plausible|fathom/i);
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
