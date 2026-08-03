/**
 * flap.sh adapter — a true bonding curve, traded through its Portal.
 *
 * ## The trade surface is NOT buy()/sell()
 *
 * The Portal still exposes `buy(token, recipient, minAmount)` and
 * `sell(token, amount, minEth)`, and an earlier census recorded those as flap's
 * trade path on the strength of the ABI. Reading the deployed source shows both
 * bodies are `revert FeatureDisabled()`. They are dead entry points.
 *
 * The live path is `swapExactInput`, which uses `address(0)` for the native
 * asset in either direction and pays out to `msg.sender` — so, as with the V3
 * adapter, built calldata is bound to whoever signs it and needs no owner
 * parameter (D-032).
 *
 * The Portal is an upgradeable proxy behind a 1-of-3 Safe and its
 * implementation has already changed once during this project, so nothing here
 * is inferred from an ABI listing alone.
 */

import { encodeFunctionData, getAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem';
import { ERC20_ABI, FLAP_PORTAL_ABI } from '../abis.js';
import { FLAP_PORTAL } from './registry.js';
import type { Quote, TokenRef, TxRequest, VenueAdapter, VenueState } from './types.js';
import { applySlippage } from './uniswapV3.js';

/** Native ETH is `address(0)` on both sides of a flap swap. */
const NATIVE = zeroAddress;

interface FlapState {
  readonly status: number;
  readonly reserve: bigint;
  readonly quoteToken: Address;
  readonly pool: Address;
  readonly progress: bigint;
  readonly buyTaxRate: number;
  readonly sellTaxRate: number;
  readonly bondingCurveFeeRate: number;
}

export class FlapAdapter implements VenueAdapter {
  readonly id = 'flap';

  readonly #client: PublicClient;
  readonly #portal: Address;

  constructor(client: PublicClient, portal: Address = FLAP_PORTAL) {
    this.#client = client;
    this.#portal = portal;
  }

  /**
   * One call. `getTokenV9Safe` reverts for anything the Portal has not
   * launched — verified against a Pons token, which reverts — so the call
   * succeeding *is* the membership test.
   */
  async #state(token: TokenRef): Promise<FlapState | null> {
    try {
      const s = (await this.#client.readContract({
        address: this.#portal,
        abi: FLAP_PORTAL_ABI,
        functionName: 'getTokenV9Safe',
        args: [token.address],
      })) as unknown as {
        status: number;
        reserve: bigint;
        quoteTokenAddress: Address;
        pool: Address;
        progress: bigint;
        buyTaxRate: bigint;
        sellTaxRate: bigint;
        bondingCurveFeeRate: number;
      };
      return {
        status: Number(s.status),
        reserve: s.reserve,
        quoteToken: getAddress(s.quoteTokenAddress),
        pool: getAddress(s.pool),
        progress: s.progress,
        buyTaxRate: Number(s.buyTaxRate),
        sellTaxRate: Number(s.sellTaxRate),
        bondingCurveFeeRate: Number(s.bondingCurveFeeRate),
      };
    } catch {
      return null;
    }
  }

  async claims(token: TokenRef): Promise<boolean> {
    return (await this.#state(token)) !== null;
  }

  /**
   * Keyed on `pool`, not on `status`.
   *
   * A pool address only exists once liquidity has migrated off the curve, which
   * is a direct observable. The `status` enum's meaning is not documented in the
   * verified source and no graduated flap token was found during recon, so
   * mapping it would be a guess dressed as a fact.
   */
  async state(token: TokenRef): Promise<VenueState> {
    const s = await this.#state(token);
    if (!s) return 'unknown';
    return isAddressEqual(s.pool, zeroAddress) ? 'curve' : 'graduated';
  }

  async quoteBuy(token: TokenRef, ethIn: bigint): Promise<Quote> {
    const s = await this.#require(token);
    this.#assertNative(s, token);
    return this.#quote(token, s, NATIVE, token.address, ethIn, 'buy');
  }

  async quoteSell(token: TokenRef, amountIn: bigint): Promise<Quote> {
    const s = await this.#require(token);
    this.#assertNative(s, token);
    return this.#quote(token, s, token.address, NATIVE, amountIn, 'sell');
  }

  async #quote(
    token: TokenRef,
    s: FlapState,
    inputToken: Address,
    outputToken: Address,
    inputAmount: bigint,
    side: 'buy' | 'sell',
  ): Promise<Quote> {
    assertPositive(inputAmount);
    const { result } = await this.#client.simulateContract({
      address: this.#portal,
      abi: FLAP_PORTAL_ABI,
      functionName: 'quoteExactInput',
      args: [{ inputToken, outputToken, inputAmount }],
    });

    return {
      venueId: this.id,
      state: await this.state(token),
      amountIn: inputAmount,
      amountOut: result as unknown as bigint,
      priceImpactBps: null,
      quoteAsset: null, // native ETH
      // Total venue-side cost, not just the curve fee: flap tokens can carry a
      // transfer tax (10% was observed), and reporting only the 1.25% curve fee
      // would understate what the trade actually costs.
      feeBps: s.bondingCurveFeeRate + (side === 'buy' ? s.buyTaxRate : s.sellTaxRate),
      source: 'simulation',
    };
  }

  async buildBuy(token: TokenRef, ethIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(ethIn);
    assertSlippage(slippageBps);
    const s = await this.#require(token);
    this.#assertNative(s, token);
    const { amountOut } = await this.quoteBuy(token, ethIn);
    const minOut = applySlippage(amountOut, slippageBps);

    return {
      to: this.#portal,
      data: encodeFunctionData({
        abi: FLAP_PORTAL_ABI,
        functionName: 'swapExactInput',
        args: [{ inputToken: NATIVE, outputToken: token.address, inputAmount: ethIn, minOutputAmount: minOut, permitData: '0x' }],
      }),
      value: ethIn,
      description: `Buy ${token.symbol ?? token.address} — ${ethIn} wei ETH in, min ${minOut} out (${slippageBps} bps)`,
    };
  }

  async buildSell(token: TokenRef, amountIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(amountIn);
    assertSlippage(slippageBps);
    const s = await this.#require(token);
    this.#assertNative(s, token);
    const { amountOut } = await this.quoteSell(token, amountIn);
    const minOut = applySlippage(amountOut, slippageBps);

    return {
      to: this.#portal,
      data: encodeFunctionData({
        abi: FLAP_PORTAL_ABI,
        functionName: 'swapExactInput',
        args: [{ inputToken: token.address, outputToken: NATIVE, inputAmount: amountIn, minOutputAmount: minOut, permitData: '0x' }],
      }),
      // Selling sends no ETH; the token is pulled by the Portal.
      value: 0n,
      description: `Sell ${token.symbol ?? token.address} — ${amountIn} wei in, min ${minOut} wei ETH out (${slippageBps} bps)`,
    };
  }

  /**
   * `permitData` is left empty, so the Portal pulls the token with a plain
   * `transferFrom` and needs an ordinary ERC-20 allowance — no Permit2 here,
   * unlike the V4 path. Approves the exact amount rather than unlimited.
   */
  async approvalNeeded(token: TokenRef, owner: Address, amountIn: bigint): Promise<TxRequest | null> {
    assertPositive(amountIn);
    const allowance = await this.#client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, this.#portal],
    });
    if (allowance >= amountIn) return null;

    return {
      to: token.address,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [this.#portal, amountIn] }),
      value: 0n,
      description: `Approve ${amountIn} wei of ${token.symbol ?? token.address} to the flap Portal`,
    };
  }

  async #require(token: TokenRef): Promise<FlapState> {
    const s = await this.#state(token);
    if (!s) throw new Error(`flap: ${token.address} is not a flap token`);
    return s;
  }

  /**
   * flap supports non-native quote assets. Those pools would need the quote
   * token supplied rather than ETH, which is a different flow — refuse instead
   * of building a trade that cannot settle.
   */
  #assertNative(s: FlapState, token: TokenRef): void {
    if (!isAddressEqual(s.quoteToken, zeroAddress)) {
      throw new Error(`flap: ${token.address} is quoted in ${s.quoteToken}, not native ETH; unsupported`);
    }
  }
}

function assertPositive(amount: bigint): void {
  if (amount <= 0n) throw new Error('amount must be > 0');
}

function assertSlippage(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error(`slippageBps out of range: ${bps}`);
}
