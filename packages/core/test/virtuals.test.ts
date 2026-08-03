/**
 * Virtuals adapter.
 *
 * Virtuals is the only venue here priced in something other than ETH, so the
 * tests that matter most are about denomination: the quote must say what it is
 * denominated in, and an ETH-denominated buy must be refused rather than
 * quietly spending $VIRTUAL.
 */

import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, zeroAddress, type Address } from 'viem';
import { VirtualsAdapter, WrongDenominationError } from '../src/venues/virtuals.js';
import { VIRTUALS_BONDING, VIRTUALS_ROUTER, VIRTUAL_TOKEN } from '../src/venues/registry.js';
import { BONDING_ABI, ERC20_ABI } from '../src/abis.js';
import { createStubClient } from './stubClient.js';
import type { TokenRef } from '../src/venues/types.js';

const TOKEN = getAddress('0x8b1A89aae4140F0f67d05E0430a7aa675Eb22163');
const PAIR = getAddress('0x0F1B7755D26800e85D479C14A1233033EF36B999');
const token: TokenRef = { address: TOKEN, chainId: 4663 };
const OWNER = getAddress('0x0000000000000000000000000000000000000003');

/** tokenInfo tuple: [creator, token, pair, agentToken, data, ...strings, trading, tradingOnUniswap, appId, initialPurchase, virtualId, launchExecuted] */
function info(over: { token?: Address; trading?: boolean; onUniswap?: boolean; launched?: boolean } = {}) {
  const r: unknown[] = new Array(17).fill('');
  r[0] = OWNER;
  r[1] = over.token ?? TOKEN;
  r[2] = PAIR;
  r[3] = zeroAddress;
  r[4] = {};
  r[11] = over.trading ?? true;
  r[12] = over.onUniswap ?? false;
  r[13] = 0n;
  r[14] = 0n;
  r[15] = 0n;
  r[16] = over.launched ?? true;
  return r;
}

function adapter(over: Record<string, unknown> = {}, amountOut = 93n * 10n ** 18n) {
  const { client } = createStubClient({
    reads: {
      [`${VIRTUALS_BONDING.toLowerCase()}.tokenInfo`]: info(),
      [`${VIRTUALS_ROUTER.toLowerCase()}.assetToken`]: VIRTUAL_TOKEN,
      [`${VIRTUALS_ROUTER.toLowerCase()}.getAmountsOut`]: amountOut,
      ...over,
    },
  });
  return new VirtualsAdapter(client, { now: () => 1_700_000_000_000 });
}

describe('claims', () => {
  it('claims an agent token Bonding launched', async () => {
    expect(await adapter().claims(token)).toBe(true);
  });

  it('rejects a token Bonding never launched', async () => {
    // Verified live: a Pons token reads back an all-zero struct.
    expect(await adapter({ [`${VIRTUALS_BONDING.toLowerCase()}.tokenInfo`]: info({ token: zeroAddress }) }).claims(token)).toBe(false);
  });
});

describe('state', () => {
  it('is curve while trading on the bonding curve', async () => {
    expect(await adapter().state(token)).toBe('curve');
  });

  it('is graduated once trading moved to a DEX', async () => {
    const a = adapter({ [`${VIRTUALS_BONDING.toLowerCase()}.tokenInfo`]: info({ onUniswap: true }) });
    expect(await a.state(token)).toBe('graduated');
  });

  it('is unknown for a token it does not know', async () => {
    const a = adapter({ [`${VIRTUALS_BONDING.toLowerCase()}.tokenInfo`]: info({ token: zeroAddress }) });
    expect(await a.state(token)).toBe('unknown');
  });
});

describe('denomination — the whole point of this venue', () => {
  it('reports quotes as denominated in $VIRTUAL, not ETH', async () => {
    const q = await adapter().quoteBuy(token, 10n ** 15n);
    // Without this, a caller summing amountOut adds VIRTUAL into an ETH total.
    expect(q.quoteAsset).toBe(VIRTUAL_TOKEN);
    expect(q.quoteAsset).not.toBeNull();
  });

  it('sell quotes are also VIRTUAL-denominated', async () => {
    expect((await adapter().quoteSell(token, 10n ** 18n)).quoteAsset).toBe(VIRTUAL_TOKEN);
  });

  it('refuses buildBuy, because the caller believes it is spending ETH', async () => {
    // Spending that many VIRTUAL instead would be silent and expensive.
    await expect(adapter().buildBuy()).rejects.toBeInstanceOf(WrongDenominationError);
  });

  it('allows a buy only when the caller states the amount is VIRTUAL', async () => {
    const tx = await adapter().buildBuyWithAsset(token, 10n ** 18n, 100);
    expect(tx.to).toBe(VIRTUALS_BONDING);
    // Paid in an ERC-20, so no native value rides along.
    expect(tx.value).toBe(0n);
    expect(tx.description).toMatch(/VIRTUAL/);
  });
});

describe('build', () => {
  const decode = (data: `0x${string}`) => decodeFunctionData({ abi: BONDING_ABI, data });

  it('encodes buy(amountIn, token, minOut, deadline)', async () => {
    const tx = await adapter().buildBuyWithAsset(token, 10n ** 18n, 100);
    const d = decode(tx.data);
    expect(d.functionName).toBe('buy');
    const [amountIn, tokenAddr, minOut] = d.args as readonly [bigint, Address, bigint, bigint];
    expect(amountIn).toBe(10n ** 18n);
    expect(tokenAddr).toBe(TOKEN);
    expect(minOut).toBe((93n * 10n ** 18n * 9900n) / 10_000n);
  });

  it('encodes sell and sends no ETH', async () => {
    const tx = await adapter().buildSell(token, 500n, 100);
    expect(decode(tx.data).functionName).toBe('sell');
    expect(tx.value).toBe(0n);
  });

  it('refuses to trade a token that has not launched', async () => {
    const a = adapter({ [`${VIRTUALS_BONDING.toLowerCase()}.tokenInfo`]: info({ launched: false }) });
    await expect(a.buildBuyWithAsset(token, 1n, 100)).rejects.toThrow(/not tradeable/);
  });

  it('refuses to trade a token whose trading flag is off', async () => {
    const a = adapter({ [`${VIRTUALS_BONDING.toLowerCase()}.tokenInfo`]: info({ trading: false }) });
    await expect(a.buildSell(token, 1n, 100)).rejects.toThrow(/not tradeable/);
  });
});

describe('approvalNeeded', () => {
  it('approves the Bonding contract for the exact amount', async () => {
    const a = adapter({ [`${TOKEN.toLowerCase()}.allowance`]: 0n });
    const tx = await a.approvalNeeded(token, OWNER, 500n);
    const [spender, amount] = decodeFunctionData({ abi: ERC20_ABI, data: tx!.data }).args as readonly [Address, bigint];
    expect(spender).toBe(VIRTUALS_BONDING);
    expect(amount).toBe(500n);
  });

  it('returns null when the allowance suffices', async () => {
    const a = adapter({ [`${TOKEN.toLowerCase()}.allowance`]: 10n ** 30n });
    expect(await a.approvalNeeded(token, OWNER, 500n)).toBeNull();
  });
});
