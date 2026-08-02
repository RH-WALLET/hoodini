/**
 * VenueAdapter — the one interface every trading venue on Robinhood Chain hides
 * behind. Bonding-curve launchpads (flap-style), instant-pool launchpads
 * (Pons/NOXA-style), and plain Uniswap pools all implement this identically, so
 * the UI and trade engine never learn which venue a token lives on.
 *
 * P0: interface only. No implementations exist yet, by design.
 */

import type { Address, Hex } from 'viem';

/** A token we might trade. `address` is the only thing we ever trust. */
export interface TokenRef {
  readonly address: Address;
  readonly chainId: number;
  /** Display-only. Scraped from a page or an explorer; never used for routing. */
  readonly symbol?: string;
}

/** Where a token sits in its venue's lifecycle. */
export type VenueState = 'curve' | 'graduated' | 'unknown';

/**
 * A read-only price quote. Every field is exact on-chain math or a simulation
 * result — never an estimate derived from a display price.
 */
export interface Quote {
  /** Venue that produced this quote. */
  readonly venueId: string;
  /** Lifecycle state the quote was computed against. */
  readonly state: VenueState;
  /** Exact input amount, in wei of the input asset. */
  readonly amountIn: bigint;
  /** Expected output before slippage, in wei of the output asset. */
  readonly amountOut: bigint;
  /**
   * Price impact in basis points, or null when the venue exposes no way to
   * compute it without a reference price. Never guessed.
   */
  readonly priceImpactBps: number | null;
  /**
   * Venue-side trading fee in basis points (the launchpad's or pool's own fee).
   * nock adds nothing to this — the 0% platform fee is a product invariant.
   */
  readonly feeBps: number;
  /** How the quote was obtained, for display and for debugging bad fills. */
  readonly source: 'view' | 'simulation';
}

/**
 * An unsigned transaction. Produced by build* methods, signed only in the
 * service worker, and broadcast only when LIVE_TRADING is true.
 */
export interface TxRequest {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  /** Present when the adapter has a reliable estimate; the engine re-estimates. */
  readonly gasLimit?: bigint;
  /** Human-readable summary for the confirm sheet. Never trusted for execution. */
  readonly description: string;
}

export interface VenueAdapter {
  /** Stable identifier, e.g. 'pons' | 'noxa' | 'flap' | 'klik' | 'uniswap-v3'. */
  readonly id: string;

  /**
   * Cheap on-chain membership check: does this venue trade this token?
   * Runtime fallback for tokens missing from the bundled registry, so it must be
   * a single call (one mapping read or getter) — never an unbounded log scan.
   */
  claims(token: TokenRef): Promise<boolean>;

  /** Curve vs graduated decides which code path quotes and builds the trade. */
  state(token: TokenRef): Promise<VenueState>;

  quoteBuy(token: TokenRef, ethIn: bigint): Promise<Quote>;
  buildBuy(token: TokenRef, ethIn: bigint, slippageBps: number): Promise<TxRequest>;

  quoteSell(token: TokenRef, amountIn: bigint): Promise<Quote>;
  buildSell(token: TokenRef, amountIn: bigint, slippageBps: number): Promise<TxRequest>;

  /**
   * Returns the approval tx when `owner`'s allowance is short of `amountIn`, or
   * null when no approval is needed (native-ETH buys, or allowance already set).
   * Callers must await this before buildSell.
   */
  approvalNeeded(token: TokenRef, owner: Address, amountIn: bigint): Promise<TxRequest | null>;
}
