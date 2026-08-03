/**
 * Doppler adapter — Uniswap V4, hook-managed bonding curve.
 *
 * Doppler inverts the shape every other venue here has. There is no launch
 * factory to trace and no curve contract to call: the launchpad *is* a V4 hook,
 * so the hook is simultaneously the attribution source, the state oracle, and
 * the thing that prices each swap via a dynamic fee.
 *
 * ## Paths
 *
 * Read and write paths are both implemented. Every command, action and struct
 * used by the write path was read out of the deployed UniversalRouter's
 * verified source rather than assumed from upstream Uniswap — the chain hosts a
 * forked router with a different command mask, so upstream constants are not
 * automatically correct here (D-020).
 */

import { encodeFunctionData, getAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem';
import { DOPPLER_HOOK_ABI, DOPPLER_POOL_STATUS, ERC20_ABI, PERMIT2_ABI, V4_DYNAMIC_FEE_FLAG, V4_QUOTER_ABI } from '../abis.js';
import { DOPPLER_HOOK, PERMIT2, UNIVERSAL_ROUTER, V4_QUOTER, WETH } from './registry.js';
import { applySlippage } from './uniswapV3.js';
import { encodeV4Buy, encodeV4Sell } from './v4.js';
import type { Quote, TokenRef, TxRequest, VenueAdapter, VenueState } from './types.js';

/** A V4 pool identity. Unlike V3 there is no pool address — the key *is* the pool. */
export interface PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

interface DopplerState {
  readonly numeraire: Address;
  readonly status: number;
  readonly poolKey: PoolKey;
}

/** Permit2 allowances expire; 30 minutes is enough for one trade, not a standing grant. */
const PERMIT2_EXPIRY_SECONDS = 1_800n;
const DEADLINE_SECONDS = 300n;

export class DopplerAdapter implements VenueAdapter {
  readonly id = 'doppler';

  readonly #client: PublicClient;
  readonly #hook: Address;
  readonly #quoter: Address;
  readonly #now: () => number;

  constructor(
    client: PublicClient,
    options: { hook?: Address; quoter?: Address; now?: () => number } = {},
  ) {
    this.#client = client;
    this.#hook = options.hook ?? DOPPLER_HOOK;
    this.#quoter = options.quoter ?? V4_QUOTER;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * One static call on the hook. Deliberately not memoised: `status` moves as a
   * token progresses through the auction, and the V3 adapter's cache is only
   * safe because a pool address never changes.
   */
  async #state(token: TokenRef): Promise<DopplerState | null> {
    try {
      const res = await this.#client.readContract({
        address: this.#hook,
        abi: DOPPLER_HOOK_ABI,
        functionName: 'getState',
        args: [token.address],
      });
      const [numeraire, , , , status, poolKey] = res as unknown as [Address, bigint, Address, `0x${string}`, number, PoolKey];
      // Uninitialized reads as a zero struct — that is the discriminator, and it
      // is what a non-Doppler token returns rather than reverting.
      if (!numeraire || isAddressEqual(numeraire, zeroAddress)) return null;
      return { numeraire: getAddress(numeraire), status: Number(status), poolKey };
    } catch {
      return null;
    }
  }

  async claims(token: TokenRef): Promise<boolean> {
    const s = await this.#state(token);
    return s !== null && s.status !== DOPPLER_POOL_STATUS.Uninitialized;
  }

  /**
   * Maps Doppler's own `PoolStatus` enum, read from the hook's verified source:
   * `{ Uninitialized, Initialized, Locked, Graduated, Exited }`.
   *
   * Initialized and Locked are the auction — the hook still governs pricing, so
   * they are `curve`. Graduated and Exited mean liquidity has migrated out to a
   * static pool.
   *
   * Caveat: no Graduated or Exited token was observed on-chain during recon (no
   * `Graduate` event in 200k blocks), so those two mappings are reasoned from
   * the enum rather than witnessed. See DATA_SOURCES.md.
   */
  async state(token: TokenRef): Promise<VenueState> {
    const s = await this.#state(token);
    if (!s) return 'unknown';
    switch (s.status) {
      case DOPPLER_POOL_STATUS.Initialized:
      case DOPPLER_POOL_STATUS.Locked:
        return 'curve';
      case DOPPLER_POOL_STATUS.Graduated:
      case DOPPLER_POOL_STATUS.Exited:
        return 'graduated';
      default:
        return 'unknown';
    }
  }

  async quoteBuy(token: TokenRef, amountIn: bigint): Promise<Quote> {
    const s = await this.#require(token);
    // Buying spends the numeraire to receive the asset.
    return this.#quote(token, s, s.numeraire, amountIn);
  }

  async quoteSell(token: TokenRef, amountIn: bigint): Promise<Quote> {
    const s = await this.#require(token);
    return this.#quote(token, s, token.address, amountIn);
  }

  async #quote(token: TokenRef, s: DopplerState, tokenIn: Address, amountIn: bigint): Promise<Quote> {
    if (amountIn <= 0n) throw new Error('amount must be > 0');
    // V4 has no tokenIn/tokenOut — direction is a flag over the ordered key.
    const zeroForOne = isAddressEqual(s.poolKey.currency0, tokenIn);

    const { result } = await this.#client.simulateContract({
      address: this.#quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: s.poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    });
    const [amountOut] = result as unknown as [bigint, bigint];

    return {
      venueId: this.id,
      state: await this.state(token),
      amountIn,
      amountOut,
      priceImpactBps: null,
      // Doppler pools carry V4's dynamic-fee flag, so PoolKey.fee is a marker,
      // not a rate — the hook sets the real fee per swap. Reporting 0 would be a
      // lie and a sentinel would be worse; the fee is already inside amountOut.
      feeBps: s.poolKey.fee === V4_DYNAMIC_FEE_FLAG ? null : s.poolKey.fee / 100,
      source: 'simulation',
    };
  }

  async #require(token: TokenRef): Promise<DopplerState> {
    const s = await this.#state(token);
    if (!s) throw new Error(`doppler: ${token.address} is not a Doppler asset`);
    return s;
  }

  /** The numeraire this asset trades against — often WETH, but not always. */
  async numeraire(token: TokenRef): Promise<Address | null> {
    return (await this.#state(token))?.numeraire ?? null;
  }

  /** The V4 PoolKey, which the P1b-2 write path will need verbatim. */
  async poolKey(token: TokenRef): Promise<PoolKey | null> {
    return (await this.#state(token))?.poolKey ?? null;
  }

  // ── write path (P1b-2) ────────────────────────────────────────────────────

  /**
   * Buy: native ETH in, Doppler asset out.
   *
   * Doppler pools pair against WETH-the-ERC20, not V4's native-ETH currency, so
   * the router wraps first and settles from its own balance:
   *
   *   WRAP_ETH(ADDRESS_THIS, ethIn)          msg.value -> WETH held by router
   *   V4_SWAP:
   *     SWAP_EXACT_IN_SINGLE                 minOut enforced here
   *     SETTLE(WETH, ethIn, payerIsUser=false)   pay from the router's WETH
   *     TAKE_ALL(asset, minOut)              credit to the signer, min enforced
   *
   * `payerIsUser=false` is what keeps a buy Permit2-free: the user never has to
   * approve anything to buy, because they pay in native ETH.
   */
  async buildBuy(token: TokenRef, ethIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(ethIn);
    assertSlippage(slippageBps);
    const s = await this.#require(token);
    if (!isAddressEqual(s.numeraire, WETH)) {
      // RWA-paired pools exist (USDG, NVDA…). Buying those means supplying that
      // token via Permit2, which is a different flow — refuse rather than
      // silently build something that cannot work.
      throw new Error(`doppler: buy only supports WETH-paired pools; ${token.address} pairs against ${s.numeraire}`);
    }

    const { amountOut } = await this.quoteBuy(token, ethIn);
    const minOut = applySlippage(amountOut, slippageBps);
    const call = encodeV4Buy({
      poolKey: s.poolKey,
      numeraire: s.numeraire,
      token: token.address,
      amountIn: ethIn,
      minOut,
      deadline: this.#deadline(),
    });
    return {
      ...call,
      description: `Buy ${token.symbol ?? token.address} — ${ethIn} wei ETH in, min ${minOut} out (${slippageBps} bps)`,
    };
  }

  async buildSell(token: TokenRef, amountIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(amountIn);
    assertSlippage(slippageBps);
    const s = await this.#require(token);
    const { amountOut } = await this.quoteSell(token, amountIn);
    const minOut = applySlippage(amountOut, slippageBps);
    const call = encodeV4Sell({
      poolKey: s.poolKey,
      numeraire: s.numeraire,
      token: token.address,
      amountIn,
      minOut,
      deadline: this.#deadline(),
    });
    return {
      ...call,
      description: `Sell ${token.symbol ?? token.address} — ${amountIn} wei in, min ${minOut} wei ${isAddressEqual(s.numeraire, WETH) ? 'ETH' : 'numeraire'} out (${slippageBps} bps)`,
    };
  }

  /**
   * V4 sells are pulled by the router through **Permit2**, so an ERC-20
   * allowance to the router alone is not enough. Two grants are required:
   *
   *   1. ERC-20 `approve(PERMIT2, …)` on the token
   *   2. `PERMIT2.approve(token, router, amount, expiration)`
   *
   * This returns whichever is missing next, so the engine calls it again after
   * each approval lands. Returning both at once would imply they can be sent in
   * parallel — they cannot, since step 2 depends on step 1.
   *
   * Buys need none of this: they are paid in native ETH.
   */
  async approvalNeeded(token: TokenRef, owner: Address, amountIn: bigint): Promise<TxRequest | null> {
    assertPositive(amountIn);

    const erc20Allowance = await this.#client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, PERMIT2],
    });
    if (erc20Allowance < amountIn) {
      return {
        to: token.address,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, amountIn] }),
        value: 0n,
        description: `Step 1 of 2 — approve ${amountIn} wei of ${token.symbol ?? token.address} to Permit2`,
      };
    }

    const [permitAmount, expiration] = await this.#client.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [owner, token.address, UNIVERSAL_ROUTER],
    });
    const nowSec = BigInt(Math.floor(this.#now() / 1000));
    // An allowance that has expired is worth nothing even if the amount is large.
    if (BigInt(permitAmount) >= amountIn && BigInt(expiration) > nowSec) return null;

    const newExpiration = nowSec + PERMIT2_EXPIRY_SECONDS;
    return {
      to: PERMIT2,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [token.address, UNIVERSAL_ROUTER, amountIn, Number(newExpiration)],
      }),
      value: 0n,
      description: `Step 2 of 2 — allow UniversalRouter to spend ${amountIn} wei via Permit2 (expires in 30 min)`,
    };
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
