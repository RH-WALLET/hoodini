/**
 * Virtuals adapter — a bonding curve priced in **$VIRTUAL**, not ETH.
 *
 * Every other venue in this project trades against native ETH or WETH. Virtuals
 * does not: `FRouterV3.assetToken()` is the VIRTUAL ERC-20, so buying an agent
 * token means spending VIRTUAL, and selling one returns VIRTUAL.
 *
 * That is why `Quote.quoteAsset` exists. Without it a caller summing
 * `amountOut` would add VIRTUAL into an ETH total and report a portfolio value
 * that is simply wrong (D-044).
 *
 * ## What this adapter does and does not do
 *
 * It quotes and builds trades **in VIRTUAL**. It does **not** pretend to accept
 * ETH: `buildBuy` is given an amount the caller believes is ETH, and spending
 * that many VIRTUAL instead would be a silent, expensive mistake. So a buy is
 * refused unless the caller opts in explicitly by passing VIRTUAL, via
 * `buildBuyWithAsset`.
 *
 * Routing ETH → VIRTUAL → agent token is a multi-hop capability the trade
 * engine does not have, and inventing it here would hide the hop from the
 * confirm sheet.
 */

import { encodeFunctionData, getAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem';
import { BONDING_ABI, ERC20_ABI, FROUTER_ABI } from '../abis.js';
import { VIRTUALS_BONDING, VIRTUALS_ROUTER } from './registry.js';
import type { Quote, TokenRef, TxRequest, VenueAdapter, VenueState } from './types.js';
import { applySlippage } from './uniswapV3.js';

const DEADLINE_SECONDS = 300n;

/** Raised when a caller tries to spend ETH on a VIRTUAL-denominated venue. */
export class WrongDenominationError extends Error {
  constructor(readonly asset: Address) {
    super(
      `virtuals: this venue is priced in ${asset}, not ETH. ` +
        'Use buildBuyWithAsset with a VIRTUAL amount, or route ETH -> VIRTUAL first.',
    );
    this.name = 'WrongDenominationError';
  }
}

interface Info {
  readonly token: Address;
  readonly pair: Address;
  readonly trading: boolean;
  readonly tradingOnUniswap: boolean;
  readonly launchExecuted: boolean;
}

export class VirtualsAdapter implements VenueAdapter {
  readonly id = 'virtuals';

  readonly #client: PublicClient;
  readonly #bonding: Address;
  readonly #router: Address;
  readonly #now: () => number;
  #asset: Address | null = null;

  constructor(
    client: PublicClient,
    options: { bonding?: Address; router?: Address; now?: () => number } = {},
  ) {
    this.#client = client;
    this.#bonding = options.bonding ?? VIRTUALS_BONDING;
    this.#router = options.router ?? VIRTUALS_ROUTER;
    this.#now = options.now ?? (() => Date.now());
  }

  /** The ERC-20 this venue prices in. Cached: it is immutable on the router. */
  async assetToken(): Promise<Address> {
    if (!this.#asset) {
      this.#asset = getAddress(
        (await this.#client.readContract({
          address: this.#router,
          abi: FROUTER_ABI,
          functionName: 'assetToken',
        })) as Address,
      );
    }
    return this.#asset;
  }

  async #info(token: TokenRef): Promise<Info | null> {
    try {
      const r = (await this.#client.readContract({
        address: this.#bonding,
        abi: BONDING_ABI,
        functionName: 'tokenInfo',
        args: [token.address],
      })) as unknown as readonly unknown[];
      const tokenAddr = getAddress(r[1] as Address);
      // A token Bonding never launched reads back an all-zero struct rather
      // than reverting — verified against a Pons token.
      if (isAddressEqual(tokenAddr, zeroAddress)) return null;
      return {
        token: tokenAddr,
        pair: getAddress(r[2] as Address),
        trading: Boolean(r[11]),
        tradingOnUniswap: Boolean(r[12]),
        launchExecuted: Boolean(r[16]),
      };
    } catch {
      return null;
    }
  }

  async claims(token: TokenRef): Promise<boolean> {
    return (await this.#info(token)) !== null;
  }

  /**
   * `tradingOnUniswap` is the graduation flag: liquidity has left the curve for
   * a DEX. `trading` alone means still on the curve.
   */
  async state(token: TokenRef): Promise<VenueState> {
    const info = await this.#info(token);
    if (!info) return 'unknown';
    if (info.tradingOnUniswap) return 'graduated';
    return info.trading ? 'curve' : 'unknown';
  }

  /**
   * Quote a buy **denominated in VIRTUAL**.
   *
   * The interface calls this parameter `ethIn`. Here it is not ETH, and the
   * returned `quoteAsset` says so — which is exactly the case that field was
   * added for.
   */
  async quoteBuy(token: TokenRef, assetIn: bigint): Promise<Quote> {
    assertPositive(assetIn);
    await this.#require(token);
    const asset = await this.assetToken();
    // getAmountsOut branches on whether the third arg equals assetToken:
    // passing the asset means "asset in, token out".
    const amountOut = (await this.#client.readContract({
      address: this.#router,
      abi: FROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [token.address, asset, assetIn],
    })) as bigint;

    return {
      venueId: this.id,
      state: await this.state(token),
      amountIn: assetIn,
      amountOut,
      priceImpactBps: null,
      quoteAsset: asset,
      feeBps: null,
      source: 'view',
    };
  }

  /** Sell an agent token; proceeds are VIRTUAL, not ETH. */
  async quoteSell(token: TokenRef, amountIn: bigint): Promise<Quote> {
    assertPositive(amountIn);
    await this.#require(token);
    const asset = await this.assetToken();
    // Anything that is not the asset selects the "token in, asset out" branch.
    const amountOut = (await this.#client.readContract({
      address: this.#router,
      abi: FROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [token.address, token.address, amountIn],
    })) as bigint;

    return {
      venueId: this.id,
      state: await this.state(token),
      amountIn,
      amountOut,
      priceImpactBps: null,
      quoteAsset: asset,
      feeBps: null,
      source: 'view',
    };
  }

  /**
   * Refused deliberately. A caller reaching `buildBuy` believes it is spending
   * ETH; spending that many VIRTUAL instead is a silent and expensive mistake,
   * and VIRTUAL is worth far more than nothing.
   */
  async buildBuy(): Promise<TxRequest> {
    throw new WrongDenominationError(await this.assetToken());
  }

  /** Explicit opt-in: the caller states the amount is VIRTUAL. */
  async buildBuyWithAsset(token: TokenRef, assetIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(assetIn);
    assertSlippage(slippageBps);
    const info = await this.#require(token);
    if (!info.trading || !info.launchExecuted) {
      throw new Error(`virtuals: ${token.address} is not tradeable on the curve`);
    }
    const { amountOut } = await this.quoteBuy(token, assetIn);
    const minOut = applySlippage(amountOut, slippageBps);

    return {
      to: this.#bonding,
      data: encodeFunctionData({
        abi: BONDING_ABI,
        functionName: 'buy',
        args: [assetIn, token.address, minOut, this.#deadline()],
      }),
      // Paid in VIRTUAL, pulled by the contract — no native value is sent.
      value: 0n,
      description: `Buy ${token.symbol ?? token.address} — ${assetIn} wei VIRTUAL in, min ${minOut} out (${slippageBps} bps)`,
    };
  }

  async buildSell(token: TokenRef, amountIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(amountIn);
    assertSlippage(slippageBps);
    const info = await this.#require(token);
    if (!info.trading) throw new Error(`virtuals: ${token.address} is not tradeable on the curve`);
    const { amountOut } = await this.quoteSell(token, amountIn);
    const minOut = applySlippage(amountOut, slippageBps);

    return {
      to: this.#bonding,
      data: encodeFunctionData({
        abi: BONDING_ABI,
        functionName: 'sell',
        args: [amountIn, token.address, minOut, this.#deadline()],
      }),
      value: 0n,
      description: `Sell ${token.symbol ?? token.address} — ${amountIn} wei in, min ${minOut} wei VIRTUAL out (${slippageBps} bps)`,
    };
  }

  /** Plain ERC-20 allowance to the Bonding contract; no Permit2 here. */
  async approvalNeeded(token: TokenRef, owner: Address, amountIn: bigint): Promise<TxRequest | null> {
    assertPositive(amountIn);
    const allowance = await this.#client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, this.#bonding],
    });
    if (allowance >= amountIn) return null;
    return {
      to: token.address,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [this.#bonding, amountIn] }),
      value: 0n,
      description: `Approve ${amountIn} wei of ${token.symbol ?? token.address} to Virtuals Bonding`,
    };
  }

  async #require(token: TokenRef): Promise<Info> {
    const info = await this.#info(token);
    if (!info) throw new Error(`virtuals: ${token.address} is not a Virtuals agent token`);
    return info;
  }

  #deadline(): bigint {
    return BigInt(Math.floor(this.#now() / 1000)) + DEADLINE_SECONDS;
  }
}

function assertPositive(amount: bigint): void {
  if (amount <= 0n) throw new Error('amount must be > 0');
}

function assertSlippage(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error(`slippageBps out of range: ${bps}`);
}
