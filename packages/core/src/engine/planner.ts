/**
 * Trade planner — turns "buy this token" into an ordered list of UNSIGNED
 * transactions, and nothing else.
 *
 * Planning lives in core; sending does not. `@hoodini/core` deliberately
 * exports no broadcast path (D-023), so the only place a transaction can be
 * signed and sent is the extension's service worker, which is exactly where the
 * LIVE_TRADING gate sits (CLAUDE.md invariant 5).
 *
 * A plan is inert. Producing one costs nothing and commits to nothing.
 */

import type { Address } from 'viem';
import type { Quote, TokenRef, TxRequest, VenueState } from '../venues/types.js';
import type { VenueRouter } from '../venues/router.js';

export type StepKind = 'approve' | 'swap';

export interface TradeStep {
  readonly kind: StepKind;
  readonly tx: TxRequest;
}

export interface TradePlan {
  readonly side: 'buy' | 'sell';
  readonly token: TokenRef;
  readonly venueId: string;
  readonly via: 'override' | 'registry' | 'claims';
  readonly state: VenueState;
  readonly quote: Quote;
  /** Minimum output the built calldata will accept, after slippage. */
  readonly minOut: bigint;
  readonly steps: readonly TradeStep[];
  /**
   * True when the venue may require further approvals after the ones listed.
   * Permit2 needs two grants and the second cannot be built until the first has
   * landed, so the executor re-asks between steps rather than trusting a plan
   * built in one pass.
   */
  readonly mayNeedMoreApprovals: boolean;
}

export class UnsupportedVenueError extends Error {
  constructor(token: Address) {
    super(`no adapter claims ${token} — refusing to guess a router`);
    this.name = 'UnsupportedVenueError';
  }
}

/**
 * Plan a buy. Buys are native-ETH in, so no approval is ever involved — that is
 * a property of paying in the chain's own currency, not an assumption about a
 * particular venue.
 */
export async function planBuy(
  router: VenueRouter,
  token: TokenRef,
  ethIn: bigint,
  slippageBps: number,
): Promise<TradePlan> {
  const resolution = await router.resolve(token);
  if (!resolution) throw new UnsupportedVenueError(token.address);
  const { adapter, via } = resolution;

  const quote = await adapter.quoteBuy(token, ethIn);
  const tx = await adapter.buildBuy(token, ethIn, slippageBps);

  return {
    side: 'buy',
    token,
    venueId: adapter.id,
    via,
    state: quote.state,
    quote,
    minOut: minOutOf(quote.amountOut, slippageBps),
    steps: [{ kind: 'swap', tx }],
    mayNeedMoreApprovals: false,
  };
}

/**
 * Plan a sell. Includes the next required approval, if any — not all of them:
 * Permit2's second grant cannot be constructed until the first is on-chain, so
 * a plan that claimed to list every approval up front would be lying.
 */
export async function planSell(
  router: VenueRouter,
  token: TokenRef,
  amountIn: bigint,
  slippageBps: number,
  owner: Address,
): Promise<TradePlan> {
  const resolution = await router.resolve(token);
  if (!resolution) throw new UnsupportedVenueError(token.address);
  const { adapter, via } = resolution;

  const quote = await adapter.quoteSell(token, amountIn);
  const approval = await adapter.approvalNeeded(token, owner, amountIn);
  const tx = await adapter.buildSell(token, amountIn, slippageBps);

  const steps: TradeStep[] = [];
  if (approval) steps.push({ kind: 'approve', tx: approval });
  steps.push({ kind: 'swap', tx });

  return {
    side: 'sell',
    token,
    venueId: adapter.id,
    via,
    state: quote.state,
    quote,
    minOut: minOutOf(quote.amountOut, slippageBps),
    steps,
    mayNeedMoreApprovals: approval !== null,
  };
}

/**
 * Mirrors the slippage the adapters apply, for display. The number the user is
 * shown must be the number encoded in the calldata, so this rounds down the
 * same way rather than computing something "close enough".
 */
export function minOutOf(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * (10_000n - BigInt(slippageBps))) / 10_000n;
}

/**
 * Total native ETH a plan would spend. Used by the send-side cap, so it counts
 * every step rather than only the swap — an approval carrying value would
 * otherwise slip past the limit.
 */
export function totalValueWei(plan: TradePlan): bigint {
  return plan.steps.reduce((sum, s) => sum + s.tx.value, 0n);
}
