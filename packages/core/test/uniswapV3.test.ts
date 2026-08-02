/**
 * Uniswap V3 adapter — encoding and money math.
 *
 * These tests decode the calldata the adapter produces and assert on the actual
 * fields, rather than comparing hex strings. A hex snapshot would pass while
 * meaning something completely different; decoding proves the router will see
 * what we intend.
 */

import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { UniswapV3Adapter, applySlippage } from '../src/venues/uniswapV3.js';
import { SWAP_ROUTER_02_ABI, MSG_SENDER, ADDRESS_THIS } from '../src/abis.js';
import { SWAP_ROUTER_02, WETH, QUOTER_V2, PONS_FACTORIES } from '../src/venues/registry.js';
import { createStubClient } from './stubClient.js';
import type { TokenRef } from '../src/venues/types.js';

const TOKEN = getAddress('0xB84e494158976B4e14da155d1cdaE16EB6D1C477');
const POOL = getAddress('0xac2e451a6b141a0b2b2d9fd746fff4724491db5e');
const PONS = PONS_FACTORIES[0] as Address;
const token: TokenRef = { address: TOKEN, chainId: 4663 };

const NOW = () => 1_700_000_000_000; // fixed clock so deadlines are assertable

/** A Pons token with a live pool, graduated, quoting 1 ETH -> 1000 tokens. */
function ponsAdapter(overrides: Record<string, unknown> = {}) {
  const { client, calls } = createStubClient({
    reads: {
      [`${TOKEN.toLowerCase()}.liquidityPool`]: POOL,
      [`${TOKEN.toLowerCase()}.poolFee`]: 10_000,
      [`${TOKEN.toLowerCase()}.launchFactory`]: PONS,
      [`${POOL.toLowerCase()}.liquidity`]: 12345n,
      [`${PONS.toLowerCase()}.graduationStatus`]: [5n * 10n ** 18n, 42n * 10n ** 17n, true],
      ...overrides,
    },
    simulates: {
      [`${QUOTER_V2.toLowerCase()}.quoteExactInputSingle`]: [1000n * 10n ** 18n, 0n, 0, 90_000n],
    },
  });
  return { adapter: new UniswapV3Adapter(client, { now: NOW }), calls };
}

/** Decode a multicall into its inner calls. */
function innerCalls(data: Hex): { functionName: string; args: readonly unknown[] }[] {
  const outer = decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data });
  expect(outer.functionName).toBe('multicall');
  const [, batch] = outer.args as readonly [bigint, readonly Hex[]];
  return batch.map((d) => {
    const inner = decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data: d });
    return { functionName: inner.functionName, args: (inner.args ?? []) as readonly unknown[] };
  });
}

describe('applySlippage', () => {
  it('reduces the output by exactly the given basis points', () => {
    expect(applySlippage(1000n, 100)).toBe(990n); // 1%
    expect(applySlippage(10_000n, 50)).toBe(9950n); // 0.5%
  });

  it('is a no-op at zero slippage', () => {
    expect(applySlippage(123_456_789n, 0)).toBe(123_456_789n);
  });

  it('rounds DOWN, so the on-chain check is never looser than requested', () => {
    // 999 * 9900 / 10000 = 989.01 -> must floor to 989, never 990.
    expect(applySlippage(999n, 100)).toBe(989n);
  });

  it('does not lose precision on wei-scale values', () => {
    const out = 723_850_205_565_077_087_608_645n;
    expect(applySlippage(out, 100)).toBe((out * 9900n) / 10_000n);
  });
});

describe('input guards', () => {
  it('rejects a zero amount — 0 is the router CONTRACT_BALANCE flag', async () => {
    const { adapter } = ponsAdapter();
    // Not merely "nothing happens": 0 would make the router swap its ENTIRE
    // balance of tokenIn, so this must never be encodable.
    await expect(adapter.buildBuy(token, 0n, 100)).rejects.toThrow(/CONTRACT_BALANCE/);
    await expect(adapter.buildSell(token, 0n, 100)).rejects.toThrow(/CONTRACT_BALANCE/);
    await expect(adapter.quoteBuy(token, 0n)).rejects.toThrow(/CONTRACT_BALANCE/);
  });

  it('rejects negative amounts', async () => {
    const { adapter } = ponsAdapter();
    await expect(adapter.buildBuy(token, -1n, 100)).rejects.toThrow();
  });

  it('rejects slippage of 100% or more, and non-integers', async () => {
    const { adapter } = ponsAdapter();
    await expect(adapter.buildBuy(token, 1n, 10_000)).rejects.toThrow(/slippageBps/);
    await expect(adapter.buildBuy(token, 1n, -1)).rejects.toThrow(/slippageBps/);
    await expect(adapter.buildBuy(token, 1n, 12.5)).rejects.toThrow(/slippageBps/);
  });
});

describe('buildBuy', () => {
  it('sends ETH as value and routes through the verified SwapRouter02', async () => {
    const { adapter } = ponsAdapter();
    const tx = await adapter.buildBuy(token, 10n ** 15n, 100);
    expect(tx.to).toBe(SWAP_ROUTER_02);
    expect(tx.value).toBe(10n ** 15n);
  });

  it('encodes exactInputSingle + refundETH, paying the signer', async () => {
    const { adapter } = ponsAdapter();
    const tx = await adapter.buildBuy(token, 10n ** 15n, 100);
    const calls = innerCalls(tx.data);

    expect(calls.map((c) => c.functionName)).toEqual(['exactInputSingle', 'refundETH']);

    const p = calls[0]!.args[0] as {
      tokenIn: Address;
      tokenOut: Address;
      fee: number;
      recipient: Address;
      amountIn: bigint;
      amountOutMinimum: bigint;
    };
    expect(p.tokenIn).toBe(WETH);
    expect(p.tokenOut).toBe(TOKEN);
    expect(p.fee).toBe(10_000);
    expect(p.amountIn).toBe(10n ** 15n);
    // MSG_SENDER binds the payout to whoever signs, so calldata built for one
    // account can never pay out to another.
    expect(p.recipient.toLowerCase()).toBe(MSG_SENDER);
  });

  it('applies slippage to amountOutMinimum on the swap itself', async () => {
    const { adapter } = ponsAdapter();
    const tx = await adapter.buildBuy(token, 10n ** 15n, 100);
    const p = innerCalls(tx.data)[0]!.args[0] as { amountOutMinimum: bigint };
    expect(p.amountOutMinimum).toBe(applySlippage(1000n * 10n ** 18n, 100));
  });

  it('sets a deadline in the future, derived from the injected clock', async () => {
    const { adapter } = ponsAdapter();
    const tx = await adapter.buildBuy(token, 10n ** 15n, 100);
    const [deadline] = decodeFunctionData({ abi: SWAP_ROUTER_02_ABI, data: tx.data }).args as readonly [bigint, unknown];
    expect(deadline).toBe(BigInt(Math.floor(NOW() / 1000)) + 300n);
  });
});

describe('buildSell', () => {
  it('sends no ETH', async () => {
    const { adapter } = ponsAdapter();
    const tx = await adapter.buildSell(token, 500n, 100);
    expect(tx.value).toBe(0n);
    expect(tx.to).toBe(SWAP_ROUTER_02);
  });

  it('routes WETH to the router, then unwraps to the signer', async () => {
    const { adapter } = ponsAdapter();
    const tx = await adapter.buildSell(token, 500n, 100);
    const calls = innerCalls(tx.data);

    expect(calls.map((c) => c.functionName)).toEqual(['exactInputSingle', 'unwrapWETH9']);

    const p = calls[0]!.args[0] as { tokenIn: Address; tokenOut: Address; recipient: Address; amountOutMinimum: bigint };
    expect(p.tokenIn).toBe(TOKEN);
    expect(p.tokenOut).toBe(WETH);
    // WETH must stay in the router so unwrapWETH9 can convert it.
    expect(p.recipient.toLowerCase()).toBe(ADDRESS_THIS);
  });

  it('enforces slippage on the unwrap, not the swap', async () => {
    const { adapter } = ponsAdapter();
    const tx = await adapter.buildSell(token, 500n, 100);
    const calls = innerCalls(tx.data);

    const swapParams = calls[0]!.args[0] as { amountOutMinimum: bigint };
    const [unwrapMin] = calls[1]!.args as readonly [bigint];

    // The swap deliberately does not check: the user-visible ETH amount is what
    // unwrapWETH9 pays out, so checking there is what actually protects them.
    expect(swapParams.amountOutMinimum).toBe(0n);
    expect(unwrapMin).toBe(applySlippage(1000n * 10n ** 18n, 100));
    expect(unwrapMin).toBeGreaterThan(0n);
  });
});

describe('state', () => {
  it('reports graduated when the pool is above the threshold', async () => {
    const { adapter } = ponsAdapter();
    expect(await adapter.state(token)).toBe('graduated');
  });

  it('reports curve when reserves fall back below the threshold', async () => {
    // Not hypothetical: Kolana read graduated=true, then false hours later once
    // holders sold out. The flag tracks live reserves (D-016-amendment).
    const { adapter } = ponsAdapter({
      [`${PONS.toLowerCase()}.graduationStatus`]: [55n * 10n ** 14n, 42n * 10n ** 17n, false],
    });
    expect(await adapter.state(token)).toBe('curve');
  });

  it('re-reads every call rather than caching a reversible flag', async () => {
    const { adapter, calls } = ponsAdapter();
    await adapter.state(token);
    await adapter.state(token);
    const reads = calls.filter((c) => c.endsWith('.graduationStatus'));
    expect(reads).toHaveLength(2);
  });
});

describe('claims', () => {
  it('claims a token with a liquid pool', async () => {
    const { adapter } = ponsAdapter();
    expect(await adapter.claims(token)).toBe(true);
  });

  it('refuses a pool with zero liquidity — it cannot be traded against', async () => {
    const { adapter } = ponsAdapter({ [`${POOL.toLowerCase()}.liquidity`]: 0n });
    expect(await adapter.claims(token)).toBe(false);
  });

  it('memoises pool resolution across calls', async () => {
    const { adapter, calls } = ponsAdapter();
    await adapter.claims(token);
    await adapter.claims(token);
    expect(calls.filter((c) => c.endsWith('.liquidityPool'))).toHaveLength(1);
  });
});

describe('approvalNeeded', () => {
  const owner = getAddress('0x0000000000000000000000000000000000000003');

  it('returns null when the allowance already covers the amount', async () => {
    const { adapter } = ponsAdapter({ [`${TOKEN.toLowerCase()}.allowance`]: 1000n });
    expect(await adapter.approvalNeeded(token, owner, 500n)).toBeNull();
  });

  it('approves the EXACT amount, never unlimited', async () => {
    const { adapter } = ponsAdapter({ [`${TOKEN.toLowerCase()}.allowance`]: 0n });
    const tx = await adapter.approvalNeeded(token, owner, 500n);
    expect(tx).not.toBeNull();
    expect(tx!.to).toBe(TOKEN);
    expect(tx!.value).toBe(0n);

    const decoded = decodeFunctionData({
      abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const,
      data: tx!.data,
    });
    const [spender, amount] = decoded.args as readonly [Address, bigint];
    expect(spender).toBe(SWAP_ROUTER_02);
    expect(amount).toBe(500n);
    expect(amount).not.toBe(2n ** 256n - 1n);
  });
});
