/**
 * Doppler adapter — V4 read path, and the deliberate refusals on the write path.
 *
 * The refusal tests matter as much as the quote tests: an adapter that silently
 * returned `null` from `approvalNeeded` would tell the trade engine a sell was
 * ready to broadcast when the Permit2 approval had never been built.
 */

import { describe, expect, it } from 'vitest';
import { getAddress, zeroAddress, type Address } from 'viem';
import { DopplerAdapter, NotImplementedError } from '../src/venues/doppler.js';
import { DOPPLER_HOOK, V4_QUOTER, WETH } from '../src/venues/registry.js';
import { DOPPLER_POOL_STATUS, V4_DYNAMIC_FEE_FLAG } from '../src/abis.js';
import { createStubClient } from './stubClient.js';
import type { TokenRef } from '../src/venues/types.js';

const TOKEN = getAddress('0x8B18800B8D7991aeAF8A7D8F10d34F06eA811bA3');
const token: TokenRef = { address: TOKEN, chainId: 4663 };

/** getState tuple: [numeraire, reserves, beneficiary, extra, status, poolKey] */
function stateTuple(status: number, opts: { numeraire?: Address; fee?: number; currency0?: Address } = {}) {
  const numeraire = opts.numeraire ?? WETH;
  const currency0 = opts.currency0 ?? numeraire;
  return [
    numeraire,
    85_000_000n * 10n ** 18n,
    getAddress('0x9982538F41f2ae29ddb9d3D9307010052984FDbB'),
    '0x',
    status,
    {
      currency0,
      currency1: currency0 === numeraire ? TOKEN : numeraire,
      fee: opts.fee ?? V4_DYNAMIC_FEE_FLAG,
      tickSpacing: 200,
      hooks: DOPPLER_HOOK,
    },
  ];
}

function adapterWith(state: unknown, amountOut = 18_099_829n * 10n ** 18n) {
  const { client, calls } = createStubClient({
    reads: { [`${DOPPLER_HOOK.toLowerCase()}.getState`]: state },
    simulates: { [`${V4_QUOTER.toLowerCase()}.quoteExactInputSingle`]: [amountOut, 963_521n] },
  });
  return { adapter: new DopplerAdapter(client), calls };
}

describe('claims', () => {
  it('claims a live Doppler asset', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    expect(await adapter.claims(token)).toBe(true);
  });

  it('rejects a token the hook does not know', async () => {
    // Uninitialized reads back as a zero struct rather than reverting, so the
    // zero numeraire is the actual discriminator.
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Uninitialized, { numeraire: zeroAddress }));
    expect(await adapter.claims(token)).toBe(false);
  });

  it('rejects a token with a numeraire set but status still Uninitialized', async () => {
    // The zero-numeraire case above short-circuits before the status check ever
    // runs, so it does not exercise the status guard at all. This one does:
    // numeraire is a real address and only `status` says the pool is not live.
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Uninitialized));
    expect(await adapter.claims(token)).toBe(false);
  });

  it('rejects when the hook read reverts entirely', async () => {
    const { client } = createStubClient({ reads: {} });
    expect(await new DopplerAdapter(client).claims(token)).toBe(false);
  });
});

describe('state — maps Doppler PoolStatus', () => {
  it.each([
    [DOPPLER_POOL_STATUS.Initialized, 'curve'],
    [DOPPLER_POOL_STATUS.Locked, 'curve'],
    [DOPPLER_POOL_STATUS.Graduated, 'graduated'],
    [DOPPLER_POOL_STATUS.Exited, 'graduated'],
  ])('status %i -> %s', async (status, expected) => {
    const { adapter } = adapterWith(stateTuple(status));
    expect(await adapter.state(token)).toBe(expected);
  });

  it('is unknown for a token the hook does not track', async () => {
    const { adapter } = adapterWith(stateTuple(0, { numeraire: zeroAddress }));
    expect(await adapter.state(token)).toBe('unknown');
  });

  it('re-reads rather than caching — status advances during the auction', async () => {
    const { adapter, calls } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    await adapter.state(token);
    await adapter.state(token);
    expect(calls.filter((c) => c.endsWith('.getState'))).toHaveLength(2);
  });
});

describe('quotes', () => {
  it('quotes a buy through the bound V4 quoter', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    const q = await adapter.quoteBuy(token, 10n ** 15n);
    expect(q.venueId).toBe('doppler');
    expect(q.amountOut).toBe(18_099_829n * 10n ** 18n);
    expect(q.source).toBe('simulation');
  });

  it('reports a dynamic fee as null, never a sentinel or a fake zero', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    const q = await adapter.quoteBuy(token, 10n ** 15n);
    // A negative or zero placeholder would silently poison downstream maths.
    expect(q.feeBps).toBeNull();
  });

  it('converts a static fee tier to bps when the pool has one', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked, { fee: 10_000 }));
    expect((await adapter.quoteBuy(token, 1n)).feeBps).toBe(100);
  });

  it('rejects a zero amount', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    await expect(adapter.quoteBuy(token, 0n)).rejects.toThrow(/> 0/);
  });

  it('refuses to quote a token that is not a Doppler asset', async () => {
    const { adapter } = adapterWith(stateTuple(0, { numeraire: zeroAddress }));
    await expect(adapter.quoteBuy(token, 1n)).rejects.toThrow(/not a Doppler asset/);
  });

  it('uses the numeraire from the hook, which is not always WETH', async () => {
    // One observed pool used a non-WETH numeraire, so assuming WETH would
    // silently quote the wrong direction.
    const other = getAddress('0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4');
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked, { numeraire: other, currency0: other }));
    expect(await adapter.numeraire(token)).toBe(other);
  });

  it('exposes the PoolKey the write path will need', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    const key = await adapter.poolKey(token);
    expect(key?.hooks).toBe(DOPPLER_HOOK);
    expect(key?.tickSpacing).toBe(200);
  });
});

describe('write path is refused, not faked (P1b-2)', () => {
  it('throws rather than emitting unverified V4 calldata', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    await expect(adapter.buildBuy()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.buildSell()).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('approvalNeeded throws instead of returning null', async () => {
    // null means "nothing to approve". V4 sells need a Permit2 approval, so a
    // null here would tell the engine a sell was ready to broadcast when it
    // was not — a silently wrong answer is worse than a loud refusal.
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    await expect(adapter.approvalNeeded()).rejects.toBeInstanceOf(NotImplementedError);
  });
});
