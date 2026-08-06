/**
 * Deciding whether a page is about one token (D-067).
 *
 * Getting this wrong opens a trading panel on the wrong coin, so the tests are
 * mostly about the cases where it must answer "no".
 */

import { describe, expect, it } from 'vitest';
import { pageToken, addressesInUrl } from '../src/pageToken.js';

const A = '0x3CfDc3924d405c98230099e1826fF846BDBbb804' as const;
const B = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const;
const CHAIN = 4663;
const ref = (address: string) => ({ address: address as `0x${string}`, chainId: CHAIN });

describe('addressesInUrl', () => {
  it('finds the address in a coin route', () => {
    expect(addressesInUrl(`https://gmgn.ai/robinhood/token/${A}`)).toEqual([A]);
    expect(addressesInUrl(`https://axiom.trade/meme/${A}?ref=x`)).toEqual([A]);
  });

  it('ignores the fragment, which is state rather than subject', () => {
    expect(addressesInUrl(`https://axiom.trade/pulse#${A}`)).toEqual([]);
  });

  it('checksums what it returns, so comparisons are not case-sensitive', () => {
    expect(addressesInUrl(`https://gmgn.ai/robinhood/token/${A.toLowerCase()}`)).toEqual([A]);
  });

  it('survives something that is not a URL at all', () => {
    expect(addressesInUrl('not a url')).toEqual([]);
  });
});

describe('pageToken', () => {
  it('answers with the token when the route names one the adapter also found', () => {
    expect(pageToken(`https://gmgn.ai/robinhood/token/${A}`, [ref(A)])).toEqual(ref(A));
  });

  it('answers null on a list, where the route names nothing', () => {
    // Pulse gets the row controls and no panel; that is the whole point.
    expect(pageToken('https://axiom.trade/pulse', [ref(A), ref(B)])).toBeNull();
  });

  it('answers null when the route names a token the adapter did not accept', () => {
    // The adapter's list is already chain-gated (D-050), so a token missing
    // from it is one this extension must not offer to trade.
    expect(pageToken(`https://gmgn.ai/solana/token/${B}`, [ref(A)])).toBeNull();
  });

  it('answers null when the route names two tokens that are both present', () => {
    // A route this code does not understand. Picking the first would be a guess
    // about which coin someone is looking at.
    expect(pageToken(`https://x.example/pair/${A}/${B}`, [ref(A), ref(B)])).toBeNull();
  });

  it('matches regardless of the case the route used', () => {
    expect(pageToken(`https://gmgn.ai/robinhood/token/${A.toLowerCase()}`, [ref(A)])).toEqual(ref(A));
  });

  it('answers null when nothing was detected, however promising the route', () => {
    expect(pageToken(`https://gmgn.ai/robinhood/token/${A}`, [])).toBeNull();
  });
});
