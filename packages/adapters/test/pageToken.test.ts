/**
 * Deciding whether a page is about one token (D-067).
 */

import { describe, expect, it } from 'vitest';
import { addressesInUrl, pageToken, pageTokenAddress } from '../src/pageToken.js';

const A = '0x2f360ea7212403948ceb19b0b0dc3e0e1e0e1e0e' as const;
const B = '0x3CfDc3924d405c98230099e1826fF846BDBbb804' as const;
const CHAIN = 4663;

describe('addressesInUrl', () => {
  it('reads the address out of a real coin route', () => {
    expect(addressesInUrl(`https://axiom.trade/meme/${A}?chains=robinhood`)).toHaveLength(1);
  });

  it('ignores the fragment, where sites keep state that is not the subject', () => {
    expect(addressesInUrl(`https://x.example/coin#${A}`)).toEqual([]);
  });

  it('finds nothing on a list route', () => {
    expect(addressesInUrl('https://axiom.trade/pulse')).toEqual([]);
  });
});

describe('pageTokenAddress', () => {
  it('answers the single address a route names', () => {
    expect(pageTokenAddress(`https://gmgn.ai/robinhood/token/${A}`)?.toLowerCase()).toBe(A.toLowerCase());
  });

  it('refuses when a route names two different tokens', () => {
    // Picking the first would be a guess about which coin someone is looking at.
    expect(pageTokenAddress(`https://x.example/pair/${A}/${B}`)).toBeNull();
  });

  it('accepts the same address repeated, which is one token', () => {
    expect(pageTokenAddress(`https://x.example/${A}?ref=${A}`)).not.toBeNull();
  });

  it('answers null on a list', () => {
    expect(pageTokenAddress('https://axiom.trade/pulse')).toBeNull();
  });
});

describe('pageToken — the fast path', () => {
  it('returns the token when the adapter also found it', () => {
    const detected = [{ address: A, chainId: CHAIN }];
    expect(pageToken(`https://axiom.trade/meme/${A}`, detected)?.address).toBe(A);
  });

  it('answers null when the adapter found only OTHER tokens', () => {
    // The case that kept the panel shut: on a coin page the adapters detect the
    // related cards in the sidebar, not the coin the route is about. The caller
    // must fall through to the on-chain gate rather than treat this as "no".
    const sidebar = [{ address: B, chainId: CHAIN }];
    expect(pageToken(`https://axiom.trade/meme/${A}`, sidebar)).toBeNull();
    // ...while the route itself still plainly names a token.
    expect(pageTokenAddress(`https://axiom.trade/meme/${A}`)).not.toBeNull();
  });
});
