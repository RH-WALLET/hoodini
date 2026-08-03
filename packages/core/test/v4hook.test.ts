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
import { V4HookAdapter, hookPoolKey, poolIdOfKey, numeraireFor, type V4HookVenue } from '../src/venues/v4hook.js';
import { STATE_VIEW, V4_QUOTER, V4_HOOK_VENUES, WETH, UNIVERSAL_ROUTER, PERMIT2 } from '../src/venues/registry.js';
import { UNIVERSAL_ROUTER_ABI, UR_COMMANDS, ERC20_ABI } from '../src/abis.js';
import { createStubClient } from './stubClient.js';
import type { TokenRef } from '../src/venues/types.js';

// Real values from the live probe.
const CLANKER = V4_HOOK_VENUES.find((v) => v.id === "clanker")! as unknown as V4HookVenue;
const CASHCAT = V4_HOOK_VENUES.find((v) => v.id === "cashcat")! as unknown as V4HookVenue;
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

const V1 = { fee: 8_388_608, tickSpacing: 200 };
const RWA = V4_HOOK_VENUES.find((v) => v.id === 'rwa-pairs')! as unknown as V4HookVenue;
const RWA_TOKEN = getAddress('0x12f190a9F9d7D37a250758b26824B97CE941bF54');
const RWA_PAIRED = getAddress('0x6B4dbb976aDc3E2982784911C008DC785AfAa5D3');

describe('config table', () => {
  it('covers the five derivable hooks found in the census', () => {
    expect(V4_HOOK_VENUES.map((v) => v.id).sort()).toEqual([
      'cashcat', 'clanker', 'eth-creator-fee', 'pump-v4', 'rwa-pairs',
    ]);
  });

  it('pins each venue\'s parameters, which are what the key is built from', () => {
    // A drifted constant would silently point every trade at another pool.
    expect(CLANKER.variants[0]!.fee).toBe(8_388_608);
    expect(CLANKER.variants[0]!.tickSpacing).toBe(200);
    expect(CLANKER.numeraire).toBe(WETH);
    expect(CASHCAT.numeraire).toBe(zeroAddress);
  });

  it('the RWA venue bundles both directions of every pair', () => {
    // Either side may be the token the user is looking at, so a one-way map
    // would silently fail for half of them.
    for (const [token, counter] of Object.entries(RWA.pairs ?? {})) {
      expect(RWA.pairs?.[counter.toLowerCase()]).toBeDefined();
      expect(RWA.pairs?.[counter.toLowerCase()]?.toLowerCase()).toBe(token);
    }
  });
});

describe('numeraireFor', () => {
  it('uses the fixed numeraire when a venue has one', () => {
    expect(numeraireFor(CLANKER_TOKEN, CLANKER)).toBe(WETH);
  });

  it('looks up the bundled counterparty for a pair venue', () => {
    expect(numeraireFor(RWA_TOKEN, RWA)).toBe(RWA_PAIRED);
  });

  it('returns null for a token the pair venue does not know', () => {
    // Without this the adapter would build a key against address(0) and
    // "discover" a pool that has nothing to do with the token.
    expect(numeraireFor(CLANKER_TOKEN, RWA)).toBeNull();
  });
});

describe('pool key derivation', () => {
  it('sorts currencies as V4 requires', () => {
    for (const v of V4_HOOK_VENUES) {
      const venue = v as unknown as V4HookVenue;
      const num = numeraireFor(CLANKER_TOKEN, venue) ?? zeroAddress;
      const key = hookPoolKey(CLANKER_TOKEN, venue, venue.variants[0]!, num);
      expect(key.currency0.toLowerCase() < key.currency1.toLowerCase()).toBe(true);
    }
  });

  it('a different hook yields a different pool id', () => {
    // The negative control from the live probe: same token, wrong hook, and
    // the resulting pool does not exist.
    const a = poolIdOfKey(hookPoolKey(CLANKER_TOKEN, CLANKER, V1, WETH));
    const b = poolIdOfKey(hookPoolKey(CLANKER_TOKEN, { ...CLANKER, hook: getAddress('0x1111111111111111111111111111111111111111') }, V1, WETH));
    expect(a).not.toBe(b);
  });

  it('a different token yields a different pool id', () => {
    expect(poolIdOfKey(hookPoolKey(CLANKER_TOKEN, CLANKER, V1, WETH))).not.toBe(
      poolIdOfKey(hookPoolKey(CASHCAT_TOKEN, CLANKER, V1, WETH)),
    );
  });

  it('a different variant yields a different pool id', () => {
    // A venue opening two shapes per token must not confuse them.
    const a = poolIdOfKey(hookPoolKey(CLANKER_TOKEN, CLANKER, { fee: 100, tickSpacing: 1 }, zeroAddress));
    const b = poolIdOfKey(hookPoolKey(CLANKER_TOKEN, CLANKER, { fee: 300, tickSpacing: 10 }, zeroAddress));
    expect(a).not.toBe(b);
  });
});

describe('multi-variant probing', () => {
  const twoShapes: V4HookVenue = {
    id: 'two-shapes',
    displayName: 'Two shapes',
    hook: getAddress('0x593dA569c2a5A6999f59fCC5b06477d8BB4dC080'),
    variants: [{ fee: 100, tickSpacing: 1 }, { fee: 300, tickSpacing: 10 }],
    numeraire: zeroAddress,
  };
  const token: TokenRef = { address: CLANKER_TOKEN, chainId: 4663 };

  it('finds a pool that only exists under the second shape', async () => {
    const first = poolIdOfKey(hookPoolKey(CLANKER_TOKEN, twoShapes, twoShapes.variants[0]!, zeroAddress));
    let calls = 0;
    const { client } = createStubClient({
      reads: {
        // Stub returns zero for the first shape, non-zero for anything else.
        [`${STATE_VIEW.toLowerCase()}.getSlot0`]: [1n, 0, 0, 0],
      },
    });
    const patched = {
      ...client,
      async readContract(args: { args?: readonly unknown[] }) {
        calls++;
        return args.args?.[0] === first ? [0n, 0, 0, 0] : [7n, 0, 0, 0];
      },
    } as never;
    const a = new V4HookAdapter(patched, twoShapes);
    expect(await a.claims(token)).toBe(true);
    // Probed the first shape, then the second — bounded, not a scan.
    expect(calls).toBe(2);
  });

  it('gives up after trying every declared shape', async () => {
    const { client } = createStubClient({ reads: { [`${STATE_VIEW.toLowerCase()}.getSlot0`]: [0n, 0, 0, 0] } });
    expect(await new V4HookAdapter(client, twoShapes).claims(token)).toBe(false);
  });
});

describe('token/token venue', () => {
  const token: TokenRef = { address: RWA_TOKEN, chainId: 4663 };
  const rwa = (out = 337n * 10n ** 18n) => {
    const { client } = createStubClient({
      reads: { [`${STATE_VIEW.toLowerCase()}.getSlot0`]: [123n, 0, 0, 0] },
      simulates: { [`${V4_QUOTER.toLowerCase()}.quoteExactInputSingle`]: [out, 1n] },
    });
    return new V4HookAdapter(client, RWA, { now: () => 1_700_000_000_000 });
  };

  it('quotes denominated in the counterparty, not ETH', async () => {
    const q = await rwa().quoteSell(token, 10n ** 16n);
    // Reporting null here would let this be summed into an ETH portfolio total.
    expect(q.quoteAsset).toBe(RWA_PAIRED);
  });

  it('refuses an ETH-funded buy on a pool with no ETH side', async () => {
    await expect(rwa().buildBuy(token, 10n ** 16n, 100)).rejects.toThrow(/not ETH/);
  });

  it('does not claim a token missing from the bundled pairs', async () => {
    expect(await rwa().claims({ address: CLANKER_TOKEN, chainId: 4663 })).toBe(false);
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
