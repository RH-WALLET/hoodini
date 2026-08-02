/**
 * VenueRouter resolution order.
 *
 * The order is a security property, not a performance one: bundled attribution
 * is reviewable in a diff, whereas claims() trusts what a token says about
 * itself. These tests pin that the registry is consulted first and that an
 * unresolvable token fails closed.
 */

import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { VenueRouter } from '../src/venues/router.js';
import { PONS_FACTORIES, type VenueRegistryEntry } from '../src/venues/registry.js';
import { createStubClient } from './stubClient.js';
import type { Quote, TokenRef, TxRequest, VenueAdapter, VenueState } from '../src/venues/types.js';

const TOKEN = getAddress('0xB84e494158976B4e14da155d1cdaE16EB6D1C477');
const PONS = PONS_FACTORIES[0] as Address;
const token: TokenRef = { address: TOKEN, chainId: 4663 };

/** Minimal adapter that records whether claims() was consulted. */
function fakeAdapter(id: string, claimsResult: boolean | Error): VenueAdapter & { claimsCalls: number } {
  const adapter = {
    id,
    claimsCalls: 0,
    async claims(): Promise<boolean> {
      adapter.claimsCalls++;
      if (claimsResult instanceof Error) throw claimsResult;
      return claimsResult;
    },
    async state(): Promise<VenueState> {
      return 'unknown';
    },
    async quoteBuy(): Promise<Quote> {
      throw new Error('unused');
    },
    async buildBuy(): Promise<TxRequest> {
      throw new Error('unused');
    },
    async quoteSell(): Promise<Quote> {
      throw new Error('unused');
    },
    async buildSell(): Promise<TxRequest> {
      throw new Error('unused');
    },
    async approvalNeeded(): Promise<TxRequest | null> {
      return null;
    },
  };
  return adapter;
}

const registry: VenueRegistryEntry[] = [
  { id: 'uniswap-v3', displayName: 'Uniswap V3', kind: 'dex', factories: [PONS], status: 'VERIFIED' },
];

describe('VenueRouter.resolve', () => {
  it('attributes via the bundled registry without consulting claims()', async () => {
    const { client } = createStubClient({ reads: { [`${TOKEN.toLowerCase()}.launchFactory`]: PONS } });
    const adapter = fakeAdapter('uniswap-v3', true);
    const router = new VenueRouter([adapter], registry, client);

    const res = await router.resolve(token);
    expect(res?.via).toBe('registry');
    expect(res?.adapter.id).toBe('uniswap-v3');
    // The whole point of registry-first: the token's own claim was not needed.
    expect(adapter.claimsCalls).toBe(0);
  });

  it('falls back to claims() for a token the bundle does not know', async () => {
    const unknownFactory = getAddress('0x00000000000000000000000000000000dEaDbeef');
    const { client } = createStubClient({ reads: { [`${TOKEN.toLowerCase()}.launchFactory`]: unknownFactory } });
    const adapter = fakeAdapter('uniswap-v3', true);
    const router = new VenueRouter([adapter], registry, client);

    const res = await router.resolve(token);
    expect(res?.via).toBe('claims');
    expect(adapter.claimsCalls).toBe(1);
  });

  it('falls back to claims() when the token has no launchFactory at all', async () => {
    const { client } = createStubClient({ reads: {} }); // read throws -> not a launchpad token
    const adapter = fakeAdapter('uniswap-v3', true);
    const router = new VenueRouter([adapter], registry, client);

    expect((await router.resolve(token))?.via).toBe('claims');
  });

  it('returns null when nothing claims the token — never guesses a router', async () => {
    const { client } = createStubClient({ reads: {} });
    const adapter = fakeAdapter('uniswap-v3', false);
    const router = new VenueRouter([adapter], registry, client);

    expect(await router.resolve(token)).toBeNull();
  });

  it('treats a throwing adapter as simply not claiming', async () => {
    const { client } = createStubClient({ reads: {} });
    const broken = fakeAdapter('broken', new Error('rpc exploded'));
    const good = fakeAdapter('uniswap-v3', true);
    const router = new VenueRouter([broken, good], registry, client);

    const res = await router.resolve(token);
    expect(res?.adapter.id).toBe('uniswap-v3');
  });

  it('ignores UNCONFIRMED registry entries for attribution (D-010)', async () => {
    const { client } = createStubClient({ reads: { [`${TOKEN.toLowerCase()}.launchFactory`]: PONS } });
    const adapter = fakeAdapter('sketchy', true);
    const unconfirmed: VenueRegistryEntry[] = [
      { id: 'sketchy', displayName: 'Unverified', kind: 'dex', factories: [PONS], status: 'UNCONFIRMED' },
    ];
    const router = new VenueRouter([adapter], unconfirmed, client);

    // It may still be reached via claims(), but never via bundled attribution.
    const res = await router.resolve(token);
    expect(res?.via).not.toBe('registry');
  });

  it('probes adapters in registry priority order', async () => {
    const { client } = createStubClient({ reads: {} });
    const first = fakeAdapter('uniswap-v3', true);
    const other = fakeAdapter('other', true);
    // Registered out of order; registry rank should still win.
    const router = new VenueRouter([other, first], registry, client);

    expect((await router.resolve(token))?.adapter.id).toBe('uniswap-v3');
    expect(other.claimsCalls).toBe(0);
  });
});
