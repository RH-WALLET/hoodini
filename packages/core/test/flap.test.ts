/**
 * flap.sh adapter.
 *
 * The load-bearing assertion here is that trades encode `swapExactInput` and
 * never `buy`/`sell`. Those two still exist in the deployed ABI but their
 * bodies are `revert FeatureDisabled()`, so an adapter written from the ABI
 * alone would compile, look right, and fail for every user.
 */

import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, zeroAddress, type Address } from 'viem';
import { FlapAdapter } from '../src/venues/flap.js';
import { FLAP_PORTAL } from '../src/venues/registry.js';
import { FLAP_PORTAL_ABI, ERC20_ABI } from '../src/abis.js';
import { createStubClient } from './stubClient.js';
import type { TokenRef } from '../src/venues/types.js';

const TOKEN = getAddress('0x59b3ae7570Ca4ce4ad110DC1D0D3a12Fc5d17777');
const token: TokenRef = { address: TOKEN, chainId: 4663 };
const OWNER = getAddress('0x0000000000000000000000000000000000000003');

function stateStruct(over: Partial<Record<string, unknown>> = {}) {
  return {
    status: 1,
    reserve: 534_000_000_000n,
    circulatingSupply: 10n ** 27n,
    price: 1_733_439_079n,
    tokenVersion: 6,
    r: 0n,
    h: 0n,
    k: 0n,
    dexSupplyThresh: 0n,
    quoteTokenAddress: zeroAddress,
    nativeToQuoteSwapEnabled: false,
    extensionID: `0x${'00'.repeat(32)}`,
    buyTaxRate: 1000n,
    sellTaxRate: 1000n,
    pool: zeroAddress,
    progress: 106_800_000_000n,
    lpFeeProfile: 0,
    dexId: 0,
    bondingCurveFeeRate: 125,
    ...over,
  };
}

function adapterWith(state: unknown, quoteOut = 513_192n * 10n ** 18n, extra: Record<string, unknown> = {}) {
  const { client, calls } = createStubClient({
    reads: { [`${FLAP_PORTAL.toLowerCase()}.getTokenV9Safe`]: state, ...extra },
    simulates: { [`${FLAP_PORTAL.toLowerCase()}.quoteExactInput`]: quoteOut },
  });
  return { adapter: new FlapAdapter(client), calls };
}

const decode = (data: `0x${string}`) => decodeFunctionData({ abi: FLAP_PORTAL_ABI, data });

describe('claims', () => {
  it('claims a token the Portal knows', async () => {
    const { adapter } = adapterWith(stateStruct());
    expect(await adapter.claims(token)).toBe(true);
  });

  it('rejects a token the Portal did not launch', async () => {
    // Verified live: getTokenV9Safe reverts for a Pons token. The call
    // succeeding IS the membership test.
    const { client } = createStubClient({ reads: {} });
    expect(await new FlapAdapter(client).claims(token)).toBe(false);
  });
});

describe('state', () => {
  it('is curve while no pool exists', async () => {
    const { adapter } = adapterWith(stateStruct({ pool: zeroAddress }));
    expect(await adapter.state(token)).toBe('curve');
  });

  it('is graduated once a pool address appears', async () => {
    // Keyed on `pool`, a direct observable, rather than on the undocumented
    // `status` enum — no graduated flap token was found during recon, so
    // mapping the enum would be a guess.
    const { adapter } = adapterWith(stateStruct({ pool: getAddress('0x1111111111111111111111111111111111111111') }));
    expect(await adapter.state(token)).toBe('graduated');
  });

  it('does not key off status, which is undocumented', async () => {
    // Same status, different pool: the answer must follow the pool.
    const a = adapterWith(stateStruct({ status: 1, pool: zeroAddress }));
    const b = adapterWith(stateStruct({ status: 1, pool: getAddress('0x2222222222222222222222222222222222222222') }));
    expect(await a.adapter.state(token)).toBe('curve');
    expect(await b.adapter.state(token)).toBe('graduated');
  });

  it('is unknown for a token the Portal rejects', async () => {
    const { client } = createStubClient({ reads: {} });
    expect(await new FlapAdapter(client).state(token)).toBe('unknown');
  });
});

describe('quotes', () => {
  it('quotes a buy from native ETH', async () => {
    const { adapter } = adapterWith(stateStruct());
    const q = await adapter.quoteBuy(token, 10n ** 15n);
    expect(q.venueId).toBe('flap');
    expect(q.amountOut).toBe(513_192n * 10n ** 18n);
    expect(q.source).toBe('simulation');
  });

  it('reports curve fee PLUS the token tax, not just the curve fee', async () => {
    // 1.25% curve + 10% buy tax. Reporting only 125 bps would understate the
    // real cost of a tax token by an order of magnitude.
    const { adapter } = adapterWith(stateStruct());
    expect((await adapter.quoteBuy(token, 1n)).feeBps).toBe(1125);
  });

  it('uses the sell tax when selling', async () => {
    const { adapter } = adapterWith(stateStruct({ buyTaxRate: 0n, sellTaxRate: 500n }));
    expect((await adapter.quoteSell(token, 1n)).feeBps).toBe(625);
  });

  it('rejects a zero amount', async () => {
    const { adapter } = adapterWith(stateStruct());
    await expect(adapter.quoteBuy(token, 0n)).rejects.toThrow(/> 0/);
  });

  it('refuses a pool quoted in something other than native ETH', async () => {
    // flap supports non-native quote assets; those need the quote token
    // supplied instead of ETH, so building an ETH trade would never settle.
    const usdg = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
    const { adapter } = adapterWith(stateStruct({ quoteTokenAddress: usdg }));
    await expect(adapter.quoteBuy(token, 1n)).rejects.toThrow(/not native ETH/);
  });
});

describe('build', () => {
  it('encodes swapExactInput, never the dead buy() entry point', async () => {
    const { adapter } = adapterWith(stateStruct());
    const tx = await adapter.buildBuy(token, 10n ** 15n, 100);
    const d = decode(tx.data);
    expect(d.functionName).toBe('swapExactInput');
    // buy() reverts FeatureDisabled() on-chain; encoding it would fail for
    // every user while looking perfectly correct in review.
    expect(d.functionName).not.toBe('buy');
  });

  it('buys with native ETH in and the token out', async () => {
    const { adapter } = adapterWith(stateStruct());
    const tx = await adapter.buildBuy(token, 10n ** 15n, 100);
    const p = decode(tx.data).args[0] as {
      inputToken: Address;
      outputToken: Address;
      inputAmount: bigint;
      minOutputAmount: bigint;
    };
    expect(p.inputToken).toBe(zeroAddress); // native
    expect(p.outputToken).toBe(TOKEN);
    expect(p.inputAmount).toBe(10n ** 15n);
    expect(tx.value).toBe(10n ** 15n);
    expect(tx.to).toBe(FLAP_PORTAL);
  });

  it('sells the token for native ETH and sends no value', async () => {
    const { adapter } = adapterWith(stateStruct());
    const tx = await adapter.buildSell(token, 500n, 100);
    const p = decode(tx.data).args[0] as { inputToken: Address; outputToken: Address };
    expect(p.inputToken).toBe(TOKEN);
    expect(p.outputToken).toBe(zeroAddress);
    expect(tx.value).toBe(0n);
  });

  it('applies slippage to minOutputAmount', async () => {
    const { adapter } = adapterWith(stateStruct());
    const tx = await adapter.buildBuy(token, 10n ** 15n, 100);
    const p = decode(tx.data).args[0] as { minOutputAmount: bigint };
    expect(p.minOutputAmount).toBe((513_192n * 10n ** 18n * 9900n) / 10_000n);
  });

  it('rejects out-of-range slippage', async () => {
    const { adapter } = adapterWith(stateStruct());
    await expect(adapter.buildBuy(token, 1n, 10_000)).rejects.toThrow(/slippageBps/);
  });
});

describe('approvalNeeded', () => {
  it('approves the Portal directly — no Permit2 on this venue', async () => {
    const { adapter } = adapterWith(stateStruct(), 1n, { [`${TOKEN.toLowerCase()}.allowance`]: 0n });
    const tx = await adapter.approvalNeeded(token, OWNER, 500n);
    expect(tx!.to).toBe(TOKEN);
    const [spender, amount] = decodeFunctionData({ abi: ERC20_ABI, data: tx!.data }).args as readonly [Address, bigint];
    expect(spender).toBe(FLAP_PORTAL);
    // Exact amount, never unlimited.
    expect(amount).toBe(500n);
  });

  it('returns null when the allowance already covers it', async () => {
    const { adapter } = adapterWith(stateStruct(), 1n, { [`${TOKEN.toLowerCase()}.allowance`]: 10n ** 30n });
    expect(await adapter.approvalNeeded(token, OWNER, 500n)).toBeNull();
  });
});
