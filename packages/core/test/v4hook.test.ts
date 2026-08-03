/**
 * Generic V4 hook adapter.
 *
 * These venues derive their pool identity from fixed constants, which is only
 * safe because existence is then proved against Uniswap's own StateView. The
 * tests that matter are the ones that stop a plausible-looking guess being
 * traded against.
 */

import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, zeroAddress, type Address } from 'viem';
import { V4HookAdapter, hookPoolKey, poolIdOfKey, type V4HookVenue } from '../src/venues/v4hook.js';
import { STATE_VIEW, V4_QUOTER, V4_HOOK_VENUES, WETH, UNIVERSAL_ROUTER, PERMIT2 } from '../src/venues/registry.js';
import { UNIVERSAL_ROUTER_ABI, UR_COMMANDS, ERC20_ABI } from '../src/abis.js';
import { createStubClient } from './stubClient.js';
import type { TokenRef } from '../src/venues/types.js';

// Real values from the live probe.
const CLANKER = V4_HOOK_VENUES.find((v) => v.id === 'clanker')! as V4HookVenue;
const CASHCAT = V4_HOOK_VENUES.find((v) => v.id === 'cashcat')! as V4HookVenue;
const CLANKER_TOKEN = getAddress('0x0cB6EBbFF67Eea819832b95c01847c241B0a5B07');
const CASHCAT_TOKEN = getAddress('0x811AAC76fe443C3870F986003F6cBA50766e2Bcc');
const OWNER = getAddress('0x0000000000000000000000000000000000000003');

function make(venue: V4HookVenue, over: Record<string, unknown> = {}, out = 1_000_893n * 10n ** 18n) {
  const { client } = createStubClient({
    reads: { [`${STATE_VIEW.toLowerCase()}.getSlot0`]: [123n, 0, 0, 0], ...over },
    simulates: { [`${V4_QUOTER.toLowerCase()}.quoteExactInputSingle`]: [out, 1n] },
  });
  return new V4HookAdapter(client, venue, { now: () => 1_700_000_000_000 });
}

describe('config table', () => {
  it('covers the four fixed-parameter hooks found in the census', () => {
    expect(V4_HOOK_VENUES.map((v) => v.id).sort()).toEqual(['cashcat', 'clanker', 'eth-creator-fee', 'pump-v4']);
  });

  it('pins each venue\'s parameters, which are what the key is built from', () => {
    // A drifted constant would silently point every trade at another pool.
    expect(CLANKER.fee).toBe(8_388_608);
    expect(CLANKER.tickSpacing).toBe(200);
    expect(CLANKER.numeraire).toBe(WETH);
    expect(CASHCAT.numeraire).toBe(zeroAddress);
  });
});

describe('pool key derivation', () => {
  it('sorts currencies as V4 requires', () => {
    for (const v of V4_HOOK_VENUES) {
      const key = hookPoolKey(CLANKER_TOKEN, v as V4HookVenue);
      expect(key.currency0.toLowerCase() < key.currency1.toLowerCase()).toBe(true);
    }
  });

  it('a different hook yields a different pool id', () => {
    // The negative control from the live probe: same token, wrong hook, and
    // the resulting pool does not exist.
    const a = poolIdOfKey(hookPoolKey(CLANKER_TOKEN, CLANKER));
    const b = poolIdOfKey(hookPoolKey(CLANKER_TOKEN, { ...CLANKER, hook: getAddress('0x1111111111111111111111111111111111111111') }));
    expect(a).not.toBe(b);
  });

  it('a different token yields a different pool id', () => {
    expect(poolIdOfKey(hookPoolKey(CLANKER_TOKEN, CLANKER))).not.toBe(poolIdOfKey(hookPoolKey(CASHCAT_TOKEN, CLANKER)));
  });
});

describe('claims — existence proved, not assumed', () => {
  const token: TokenRef = { address: CLANKER_TOKEN, chainId: 4663 };

  it('claims a token whose pool is initialised', async () => {
    expect(await make(CLANKER).claims(token)).toBe(true);
  });

  it('refuses when the pool was never initialised', async () => {
    // sqrtPriceX96 == 0 is Uniswap saying "this pool does not exist". Without
    // this check the adapter would happily quote a derived key that is fiction.
    const a = make(CLANKER, { [`${STATE_VIEW.toLowerCase()}.getSlot0`]: [0n, 0, 0, 0] });
    expect(await a.claims(token)).toBe(false);
  });

  it('refuses when StateView reverts', async () => {
    const { client } = createStubClient({ reads: {} });
    expect(await new V4HookAdapter(client, CLANKER).claims(token)).toBe(false);
  });

  it('will not quote or build for an absent pool', async () => {
    const a = make(CLANKER, { [`${STATE_VIEW.toLowerCase()}.getSlot0`]: [0n, 0, 0, 0] });
    await expect(a.quoteBuy(token, 1n)).rejects.toThrow(/no initialised pool/);
    await expect(a.buildBuy(token, 1n, 100)).rejects.toThrow(/no initialised pool/);
  });
});

describe('quotes', () => {
  const token: TokenRef = { address: CLANKER_TOKEN, chainId: 4663 };

  it('quotes in ETH terms, so a caller may total it', async () => {
    const q = await make(CLANKER).quoteBuy(token, 10n ** 14n);
    expect(q.quoteAsset).toBeNull();
    expect(q.amountOut).toBe(1_000_893n * 10n ** 18n);
  });

  it('reports no fixed fee for a dynamic-fee pool', async () => {
    expect((await make(CLANKER).quoteBuy(token, 1n)).feeBps).toBeNull();
  });

  it('reports no fixed fee when the key says 0 and the hook charges', async () => {
    // A literal 0 would read as "free".
    expect((await make(CASHCAT).quoteBuy({ address: CASHCAT_TOKEN, chainId: 4663 }, 1n)).feeBps).toBeNull();
  });

  it('rejects a zero amount', async () => {
    await expect(make(CLANKER).quoteBuy(token, 0n)).rejects.toThrow(/> 0/);
  });
});

describe('build — wrapping follows the numeraire', () => {
  const commands = (data: `0x${string}`) => {
    const d = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data });
    const [c] = d.args as readonly [`0x${string}`, unknown, bigint];
    return (c.slice(2).match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
  };

  it('a WETH-paired venue wraps before swapping', async () => {
    const tx = await make(CLANKER).buildBuy({ address: CLANKER_TOKEN, chainId: 4663 }, 10n ** 14n, 100);
    expect(commands(tx.data)).toEqual([UR_COMMANDS.WRAP_ETH, UR_COMMANDS.V4_SWAP]);
  });

  it('a native-paired venue does not wrap', async () => {
    // Wrapping a native pool settles the wrong currency and reverts.
    const tx = await make(CASHCAT).buildBuy({ address: CASHCAT_TOKEN, chainId: 4663 }, 10n ** 14n, 100);
    expect(commands(tx.data)).toEqual([UR_COMMANDS.V4_SWAP]);
  });

  it('a WETH-paired sell unwraps back to the signer', async () => {
    const tx = await make(CLANKER).buildSell({ address: CLANKER_TOKEN, chainId: 4663 }, 500n, 100);
    expect(commands(tx.data)).toEqual([UR_COMMANDS.V4_SWAP, UR_COMMANDS.UNWRAP_WETH]);
    expect(tx.value).toBe(0n);
  });

  it('routes through the pinned UniversalRouter', async () => {
    const tx = await make(CLANKER).buildBuy({ address: CLANKER_TOKEN, chainId: 4663 }, 10n ** 14n, 100);
    expect(tx.to).toBe(UNIVERSAL_ROUTER);
  });
});

describe('approvalNeeded', () => {
  const token: TokenRef = { address: CLANKER_TOKEN, chainId: 4663 };

  it('step 1 targets Permit2', async () => {
    const a = make(CLANKER, { [`${CLANKER_TOKEN.toLowerCase()}.allowance`]: 0n });
    const tx = await a.approvalNeeded(token, OWNER, 500n);
    const [spender] = decodeFunctionData({ abi: ERC20_ABI, data: tx!.data }).args as readonly [Address, bigint];
    expect(spender).toBe(PERMIT2);
  });

  it('returns null only when both grants are live', async () => {
    const future = Math.floor(1_700_000_000_000 / 1000) + 3600;
    const a = make(CLANKER, {
      [`${CLANKER_TOKEN.toLowerCase()}.allowance`]: 10n ** 30n,
      [`${PERMIT2.toLowerCase()}.allowance`]: [10n ** 30n, future, 0],
    });
    expect(await a.approvalNeeded(token, OWNER, 500n)).toBeNull();
  });
});
