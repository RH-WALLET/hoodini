/**
 * klik.finance adapter.
 *
 * klik's pool identity is *derived* rather than looked up, which is only safe
 * because it is then checked against the chain. The verification test is the
 * important one: without it, a drifted constant would quote and trade against
 * the wrong pool while looking perfectly healthy.
 */

import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, zeroAddress, type Address } from 'viem';
import { KlikAdapter, klikPoolKey, poolIdOf, KLIK_POOL_FEE, KLIK_TICK_SPACING } from '../src/venues/klik.js';
import { KLIK_FACTORY, KLIK_HOOK, V4_QUOTER, UNIVERSAL_ROUTER, PERMIT2 } from '../src/venues/registry.js';
import { UNIVERSAL_ROUTER_ABI, UR_COMMANDS, ERC20_ABI } from '../src/abis.js';
import { createStubClient } from './stubClient.js';
import type { TokenRef } from '../src/venues/types.js';

// The live token this was verified against.
const TOKEN = getAddress('0xf9b3ef2B2eCD0f42c8f8F711CAFB4755B2ddCDFD');
const REAL_POOL_ID = '0xa4d8acff07b964e5e12f33238364f9b8174006cd6b0f5d1d84f1846b68ae40be';
const token: TokenRef = { address: TOKEN, chainId: 4663 };
const OWNER = getAddress('0x0000000000000000000000000000000000000003');

const info = (t: Address = TOKEN) => [t, 'Trust In Trump', 'TRUST', OWNER, 1_785_771_692n, 'ipfs://x', 1n, 0n];
const price = (id: string = REAL_POOL_ID) => [id, 2_505_411_999n, 1_000_001_982n, 1_000_001_982_000_000_000n];

function adapter(over: Record<string, unknown> = {}, quoteOut = 984_779n * 10n ** 18n) {
  const { client } = createStubClient({
    reads: {
      [`${KLIK_FACTORY.toLowerCase()}.tokenInfoByAddress`]: info(),
      [`${KLIK_FACTORY.toLowerCase()}.getTokenPrice`]: price(),
      ...over,
    },
    simulates: { [`${V4_QUOTER.toLowerCase()}.quoteExactInputSingle`]: [quoteOut, 1n] },
  });
  return new KlikAdapter(client, { now: () => 1_700_000_000_000 });
}

describe('pool key derivation', () => {
  it('reproduces the pool id the chain reports', () => {
    // Verified live: this constructed key, the Initialize event and klik's own
    // getTokenPrice all produced the same id.
    expect(poolIdOf(klikPoolKey(TOKEN))).toBe(REAL_POOL_ID);
  });

  it('sorts native first, as V4 requires currency0 < currency1', () => {
    const key = klikPoolKey(TOKEN);
    expect(key.currency0).toBe(zeroAddress);
    expect(key.currency1).toBe(TOKEN);
    expect(key.currency0.toLowerCase() < key.currency1.toLowerCase()).toBe(true);
  });

  it('pins klik\'s fixed pool parameters', () => {
    const key = klikPoolKey(TOKEN);
    expect(key.fee).toBe(KLIK_POOL_FEE);
    expect(key.tickSpacing).toBe(KLIK_TICK_SPACING);
    expect(key.hooks).toBe(KLIK_HOOK);
  });
});

describe('claims', () => {
  it('claims a token klik launched', async () => {
    expect(await adapter().claims(token)).toBe(true);
  });

  it('rejects a token klik did not launch', async () => {
    // Verified live: a Pons token reads back an all-zero struct rather than
    // reverting, so the zero address is the discriminator.
    const a = adapter({ [`${KLIK_FACTORY.toLowerCase()}.tokenInfoByAddress`]: info(zeroAddress) });
    expect(await a.claims(token)).toBe(false);
  });

  it('rejects when the read reverts', async () => {
    const { client } = createStubClient({ reads: {} });
    expect(await new KlikAdapter(client).claims(token)).toBe(false);
  });
});

describe('pool id verification', () => {
  it('refuses to trade when the chain disagrees with the constructed key', async () => {
    // The failure this prevents: a changed constant silently pointing every
    // quote and trade at a different pool.
    const a = adapter({ [`${KLIK_FACTORY.toLowerCase()}.getTokenPrice`]: price(`0x${'11'.repeat(32)}`) });
    await expect(a.quoteBuy(token, 10n ** 15n)).rejects.toThrow(/pool id mismatch/);
    await expect(a.buildBuy(token, 10n ** 15n, 100)).rejects.toThrow(/pool id mismatch/);
  });
});

describe('quotes', () => {
  it('quotes a buy', async () => {
    const q = await adapter().quoteBuy(token, 10n ** 15n);
    expect(q.venueId).toBe('klik');
    expect(q.amountOut).toBe(984_779n * 10n ** 18n);
  });

  it('reports no fixed fee — the hook charges, the key says 0', async () => {
    // A literal 0 would read as "free"; the cost is inside amountOut.
    expect((await adapter().quoteBuy(token, 1n)).feeBps).toBeNull();
  });

  it('rejects a zero amount', async () => {
    await expect(adapter().quoteBuy(token, 0n)).rejects.toThrow(/> 0/);
  });
});

describe('build — native-paired, so no wrapping', () => {
  const decode = (data: `0x${string}`) => {
    const d = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data });
    const [commands] = d.args as readonly [`0x${string}`, readonly `0x${string}`[], bigint];
    return (commands.slice(2).match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
  };

  it('buys with V4_SWAP alone — no WRAP_ETH', async () => {
    const tx = await adapter().buildBuy(token, 10n ** 15n, 100);
    // Wrapping a native-paired pool would settle the wrong currency and revert.
    expect(decode(tx.data)).toEqual([UR_COMMANDS.V4_SWAP]);
    expect(tx.value).toBe(10n ** 15n);
    expect(tx.to).toBe(UNIVERSAL_ROUTER);
  });

  it('sells with V4_SWAP alone — no UNWRAP_WETH', async () => {
    const tx = await adapter().buildSell(token, 500n, 100);
    expect(decode(tx.data)).toEqual([UR_COMMANDS.V4_SWAP]);
    expect(tx.value).toBe(0n);
  });
});

describe('approvalNeeded — Permit2, same as any V4 sell', () => {
  it('step 1 approves Permit2, not the router', async () => {
    const a = adapter({ [`${TOKEN.toLowerCase()}.allowance`]: 0n });
    const tx = await a.approvalNeeded(token, OWNER, 500n);
    const [spender] = decodeFunctionData({ abi: ERC20_ABI, data: tx!.data }).args as readonly [Address, bigint];
    expect(spender).toBe(PERMIT2);
  });

  it('returns null only when both grants are live', async () => {
    const future = Math.floor(1_700_000_000_000 / 1000) + 3600;
    const a = adapter({
      [`${TOKEN.toLowerCase()}.allowance`]: 10n ** 30n,
      [`${PERMIT2.toLowerCase()}.allowance`]: [10n ** 30n, future, 0],
    });
    expect(await a.approvalNeeded(token, OWNER, 500n)).toBeNull();
  });

  it('re-approves an expired Permit2 allowance however large', async () => {
    const past = Math.floor(1_700_000_000_000 / 1000) - 1;
    const a = adapter({
      [`${TOKEN.toLowerCase()}.allowance`]: 10n ** 30n,
      [`${PERMIT2.toLowerCase()}.allowance`]: [10n ** 30n, past, 0],
    });
    expect(await a.approvalNeeded(token, OWNER, 500n)).not.toBeNull();
  });
});
