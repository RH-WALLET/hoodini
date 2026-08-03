/**
 * Positions.
 *
 * The panel is computed from local reads with no indexer, so the important
 * behaviours are all about honesty: one bad token must not blank the list, a
 * token that cannot be sold must say why, and a partial total must never look
 * complete.
 */

import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { loadPositions, summarise } from '../src/positions.js';
import { createStubClient } from './stubClient.js';
import type { VenueRouter } from '../src/venues/router.js';
import type { Quote, TokenRef } from '../src/venues/types.js';

const T1 = getAddress('0xb84e494158976b4e14da155d1cdae16eb6d1c477');
const T2 = getAddress('0x8b18800b8d7991aeaf8a7d8f10d34f06ea811ba3');
const OWNER = getAddress('0x0000000000000000000000000000000000000003');

const quote = (amountOut: bigint): Quote => ({
  venueId: 'uniswap-v3',
  state: 'graduated',
  amountIn: 0n,
  amountOut,
  priceImpactBps: null,
  feeBps: 100,
  source: 'simulation',
});

function routerWith(fn: (t: TokenRef) => Promise<Quote>): VenueRouter {
  return {
    resolve: async () => ({ adapter: { id: 'uniswap-v3', quoteSell: fn }, via: 'registry' }),
  } as unknown as VenueRouter;
}

function client(balances: Record<string, bigint>, over: Record<string, unknown> = {}) {
  const reads: Record<string, unknown> = { ...over };
  for (const [addr, bal] of Object.entries(balances)) {
    reads[`${addr.toLowerCase()}.balanceOf`] = bal;
    reads[`${addr.toLowerCase()}.decimals`] ??= 18;
    reads[`${addr.toLowerCase()}.symbol`] ??= 'TOK';
  }
  return createStubClient({ reads }).client;
}

describe('loadPositions', () => {
  const opts = (c: ReturnType<typeof client>, r: VenueRouter) => ({ client: c, router: r, owner: OWNER, chainId: 4663 });

  it('reads balance and current sell value', async () => {
    const c = client({ [T1]: 5n * 10n ** 18n });
    const p = await loadPositions([T1], opts(c, routerWith(async () => quote(10n ** 15n))));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ token: T1, balanceFormatted: '5', valueWei: 10n ** 15n, venueId: 'uniswap-v3' });
  });

  it('omits dust rather than padding the panel with zero rows', async () => {
    const c = client({ [T1]: 0n });
    expect(await loadPositions([T1], opts(c, routerWith(async () => quote(1n))))).toEqual([]);
  });

  it('keeps a position whose value cannot be quoted, with the reason', async () => {
    // Two venues are known to refuse sells in some states, so "no value" is a
    // real condition a holder needs to see — not something to hide.
    const c = client({ [T1]: 10n ** 18n });
    const r = routerWith(async () => {
      throw new Error('execution reverted: arithmetic underflow');
    });
    const [p] = await loadPositions([T1], opts(c, r));
    expect(p!.balance).toBe(10n ** 18n);
    expect(p!.valueWei).toBeNull();
    expect(p!.valueUnavailableReason).toMatch(/underflow/);
  });

  it('marks a token no venue claims', async () => {
    const c = client({ [T1]: 10n ** 18n });
    const r = { resolve: async () => null } as unknown as VenueRouter;
    const [p] = await loadPositions([T1], opts(c, r));
    expect(p!.venueId).toBeNull();
    expect(p!.valueUnavailableReason).toMatch(/no venue/);
  });

  it('one unreadable token does not blank the rest of the list', async () => {
    // balanceOf is stubbed for T2 only, so T1 throws.
    const c = client({ [T2]: 2n * 10n ** 18n });
    const p = await loadPositions([T1, T2], opts(c, routerWith(async () => quote(5n))));
    expect(p).toHaveLength(1);
    expect(p[0]!.token).toBe(T2);
  });

  it('falls back to 18 decimals when the token does not report them', async () => {
    const c = client({ [T1]: 10n ** 18n }, { [`${T1.toLowerCase()}.decimals`]: new Error('no decimals()') });
    const [p] = await loadPositions([T1], opts(c, routerWith(async () => quote(1n))));
    expect(p!.decimals).toBe(18);
  });

  it('tolerates a missing symbol', async () => {
    const c = client({ [T1]: 10n ** 18n }, { [`${T1.toLowerCase()}.symbol`]: new Error('none') });
    const [p] = await loadPositions([T1], opts(c, routerWith(async () => quote(1n))));
    expect(p!.symbol).toBeNull();
  });
});

describe('summarise', () => {
  it('reports how many positions could not be valued alongside the total', async () => {
    // A total that silently omitted unvalued rows would read as complete.
    const positions = [
      { valueWei: 10n } as never,
      { valueWei: 5n } as never,
      { valueWei: null } as never,
    ];
    expect(summarise(positions)).toEqual({ totalWei: 15n, valued: 2, unvalued: 1 });
  });

  it('is zero for an empty portfolio', () => {
    expect(summarise([])).toEqual({ totalWei: 0n, valued: 0, unvalued: 0 });
  });
});
