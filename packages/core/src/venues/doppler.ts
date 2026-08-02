/**
 * Doppler adapter — Uniswap V4, hook-managed bonding curve.
 *
 * Doppler inverts the shape every other venue here has. There is no launch
 * factory to trace and no curve contract to call: the launchpad *is* a V4 hook,
 * so the hook is simultaneously the attribution source, the state oracle, and
 * the thing that prices each swap via a dynamic fee.
 *
 * ## Read path only (P1b-1)
 *
 * `claims`, `state`, `quoteBuy` and `quoteSell` are implemented and verified
 * against the live chain. `buildBuy`, `buildSell` and `approvalNeeded` throw:
 * a V4 swap goes through UniversalRouter's `execute(commands, inputs)` with
 * Permit2-based approvals, and that encoding has not yet been verified against
 * the deployed source the way the V3 path was. Guessing it would risk real
 * funds, so it lands in P1b-2 instead (D-018).
 */

import { getAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem';
import { DOPPLER_HOOK_ABI, DOPPLER_POOL_STATUS, V4_DYNAMIC_FEE_FLAG, V4_QUOTER_ABI } from '../abis.js';
import { DOPPLER_HOOK, V4_QUOTER } from './registry.js';
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

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`doppler: ${what} is not implemented yet (P1b-2 — V4 write path)`);
    this.name = 'NotImplementedError';
  }
}

export class DopplerAdapter implements VenueAdapter {
  readonly id = 'doppler';

  readonly #client: PublicClient;
  readonly #hook: Address;
  readonly #quoter: Address;

  constructor(client: PublicClient, hook: Address = DOPPLER_HOOK, quoter: Address = V4_QUOTER) {
    this.#client = client;
    this.#hook = hook;
    this.#quoter = quoter;
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

  // ── write path: P1b-2 ─────────────────────────────────────────────────────

  async buildBuy(): Promise<TxRequest> {
    throw new NotImplementedError('buildBuy');
  }

  async buildSell(): Promise<TxRequest> {
    throw new NotImplementedError('buildSell');
  }

  async approvalNeeded(): Promise<TxRequest | null> {
    // Not "no approval needed" — V4 routes through Permit2, so returning null
    // here would tell the engine a sell is ready to send when it is not.
    throw new NotImplementedError('approvalNeeded');
  }
}
