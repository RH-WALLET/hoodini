/**
 * Generic Uniswap V4 hook adapter.
 *
 * Several launchpads on this chain are just "a V4 pool with our hook attached,
 * always with the same parameters". Clanker, CashCat, PumpV4 and
 * EthCreatorFeeHookV3 each open every pool with a fixed fee, tickSpacing and
 * numeraire, so the `PoolKey` is derivable from the token address exactly as it
 * is for klik.
 *
 * That makes each of them a **config entry** rather than an adapter, which is
 * what P1d promised and mostly had not delivered until now.
 *
 * ## Proving the pool exists
 *
 * klik can verify a constructed key against its own `getTokenPrice`, which
 * returns the poolId it uses. These hooks expose no such getter, so membership
 * is proved against Uniswap itself: hash the key into a poolId and ask
 * `StateView.getSlot0`. An uninitialised pool returns `sqrtPriceX96 == 0`.
 *
 * Verified live for all four, including a negative control — the same token
 * with a different hook hashes to a poolId that reads back zero (D-045).
 */

import { encodeFunctionData, getAddress, isAddressEqual, keccak256, encodeAbiParameters, parseAbiParameters, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { ERC20_ABI, PERMIT2_ABI, STATE_VIEW_ABI, V4_DYNAMIC_FEE_FLAG, V4_QUOTER_ABI } from '../abis.js';
import { PERMIT2, STATE_VIEW, UNIVERSAL_ROUTER, V4_QUOTER } from './registry.js';
import type { PoolKey } from './doppler.js';
import type { Quote, TokenRef, TxRequest, VenueAdapter, VenueState } from './types.js';
import { applySlippage } from './uniswapV3.js';
import { encodeV4Buy, encodeV4Sell } from './v4.js';

const DEADLINE_SECONDS = 300n;
const PERMIT2_EXPIRY_SECONDS = 1_800n;

export interface V4HookVenue {
  readonly id: string;
  readonly displayName: string;
  readonly hook: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  /** `address(0)` for native ETH, otherwise the ERC-20 the pool pairs against. */
  readonly numeraire: Address;
}

/** V4 requires currency0 < currency1. */
export function hookPoolKey(token: Address, venue: V4HookVenue): PoolKey {
  const a = venue.numeraire.toLowerCase();
  const b = token.toLowerCase();
  const [c0, c1] = a < b ? [venue.numeraire, token] : [token, venue.numeraire];
  return {
    currency0: getAddress(c0),
    currency1: getAddress(c1),
    fee: venue.fee,
    tickSpacing: venue.tickSpacing,
    hooks: venue.hook,
  };
}

export function poolIdOfKey(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('(address,address,uint24,int24,address)'), [
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ]),
  );
}

export class V4HookAdapter implements VenueAdapter {
  readonly id: string;

  readonly #client: PublicClient;
  readonly #venue: V4HookVenue;
  readonly #stateView: Address;
  readonly #quoter: Address;
  readonly #now: () => number;

  constructor(
    client: PublicClient,
    venue: V4HookVenue,
    options: { stateView?: Address; quoter?: Address; now?: () => number } = {},
  ) {
    this.#client = client;
    this.#venue = venue;
    this.id = venue.id;
    this.#stateView = options.stateView ?? STATE_VIEW;
    this.#quoter = options.quoter ?? V4_QUOTER;
    this.#now = options.now ?? (() => Date.now());
  }

  get venue(): V4HookVenue {
    return this.#venue;
  }

  /**
   * One call. A pool that was never initialised reads back `sqrtPriceX96 == 0`,
   * so this distinguishes "this venue launched the token" from "this key is a
   * plausible-looking guess".
   */
  async claims(token: TokenRef): Promise<boolean> {
    try {
      const key = hookPoolKey(token.address, this.#venue);
      const slot0 = (await this.#client.readContract({
        address: this.#stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getSlot0',
        args: [poolIdOfKey(key)],
      })) as unknown as readonly [bigint, ...unknown[]];
      return slot0[0] !== 0n;
    } catch {
      return false;
    }
  }

  /** These venues launch straight into a live pool; there is no curve phase. */
  async state(token: TokenRef): Promise<VenueState> {
    return (await this.claims(token)) ? 'graduated' : 'unknown';
  }

  async quoteBuy(token: TokenRef, amountIn: bigint): Promise<Quote> {
    return this.#quote(token, amountIn, true);
  }

  async quoteSell(token: TokenRef, amountIn: bigint): Promise<Quote> {
    return this.#quote(token, amountIn, false);
  }

  async #quote(token: TokenRef, amountIn: bigint, buying: boolean): Promise<Quote> {
    assertPositive(amountIn);
    const key = await this.#requireKey(token);
    const numeraireIsCurrency0 = isAddressEqual(key.currency0, this.#venue.numeraire);
    const zeroForOne = buying === numeraireIsCurrency0;

    const { result } = await this.#client.simulateContract({
      address: this.#quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    });

    return {
      venueId: this.id,
      state: 'graduated',
      amountIn,
      amountOut: (result as unknown as readonly [bigint, bigint])[0],
      priceImpactBps: null,
      // These pools are ETH- or WETH-denominated either way, so the quote is
      // in ETH terms and the caller can total it.
      quoteAsset: null,
      // A dynamic-fee pool has no fixed rate, and a fee of 0 in the key means
      // the hook charges instead — neither is a number worth reporting as if
      // it were the cost.
      feeBps: this.#venue.fee === V4_DYNAMIC_FEE_FLAG || this.#venue.fee === 0 ? null : this.#venue.fee / 100,
      source: 'simulation',
    };
  }

  async buildBuy(token: TokenRef, ethIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(ethIn);
    assertSlippage(slippageBps);
    const key = await this.#requireKey(token);
    const { amountOut } = await this.quoteBuy(token, ethIn);
    const minOut = applySlippage(amountOut, slippageBps);

    const call = encodeV4Buy({
      poolKey: key,
      numeraire: this.#venue.numeraire,
      token: token.address,
      amountIn: ethIn,
      minOut,
      deadline: this.#deadline(),
    });
    return { ...call, description: `Buy ${token.symbol ?? token.address} — ${ethIn} wei ETH in, min ${minOut} out (${slippageBps} bps)` };
  }

  async buildSell(token: TokenRef, amountIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(amountIn);
    assertSlippage(slippageBps);
    const key = await this.#requireKey(token);
    const { amountOut } = await this.quoteSell(token, amountIn);
    const minOut = applySlippage(amountOut, slippageBps);

    const call = encodeV4Sell({
      poolKey: key,
      numeraire: this.#venue.numeraire,
      token: token.address,
      amountIn,
      minOut,
      deadline: this.#deadline(),
    });
    return { ...call, description: `Sell ${token.symbol ?? token.address} — ${amountIn} wei in, min ${minOut} wei ETH out (${slippageBps} bps)` };
  }

  /** V4 sells are pulled through Permit2, so two grants are needed. */
  async approvalNeeded(token: TokenRef, owner: Address, amountIn: bigint): Promise<TxRequest | null> {
    assertPositive(amountIn);

    const erc20 = await this.#client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, PERMIT2],
    });
    if (erc20 < amountIn) {
      return {
        to: token.address,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, amountIn] }),
        value: 0n,
        description: `Step 1 of 2 — approve ${amountIn} wei of ${token.symbol ?? token.address} to Permit2`,
      };
    }

    const [amount, expiration] = await this.#client.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [owner, token.address, UNIVERSAL_ROUTER],
    });
    const nowSec = BigInt(Math.floor(this.#now() / 1000));
    if (BigInt(amount) >= amountIn && BigInt(expiration) > nowSec) return null;

    return {
      to: PERMIT2,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [token.address, UNIVERSAL_ROUTER, amountIn, Number(nowSec + PERMIT2_EXPIRY_SECONDS)],
      }),
      value: 0n,
      description: `Step 2 of 2 — allow UniversalRouter to spend ${amountIn} wei via Permit2 (expires in 30 min)`,
    };
  }

  async #requireKey(token: TokenRef): Promise<PoolKey> {
    if (!(await this.claims(token))) {
      throw new Error(`${this.id}: no initialised pool for ${token.address} on this hook`);
    }
    return hookPoolKey(token.address, this.#venue);
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
