/**
 * Positions.
 *
 * There is no indexer and no backend, so "what do I hold?" cannot be answered
 * by asking a server. It is answered by reading `balanceOf` for tokens the user
 * has actually interacted with — a list the extension accumulates locally.
 *
 * That means positions are **not** a complete portfolio: a token bought
 * elsewhere will not appear until it is seen. Saying so plainly is better than
 * showing a total that looks authoritative and is quietly wrong.
 */

import { formatUnits, type Address, type PublicClient } from 'viem';
import { ERC20_ABI } from './abis.js';
import type { VenueRouter } from './venues/router.js';

export interface Position {
  readonly token: Address;
  readonly symbol: string | null;
  readonly decimals: number;
  readonly balance: bigint;
  readonly balanceFormatted: string;
  /** ETH the balance would fetch right now, or null when unquotable. */
  readonly valueWei: bigint | null;
  /**
   * What `valueWei` is denominated in — null for native ETH, otherwise the
   * ERC-20 the venue prices in. Virtuals quotes in $VIRTUAL, so a caller that
   * assumed ETH would report a wrong portfolio value (D-044).
   */
  readonly valueAsset: Address | null;
  /**
   * Why a value is missing. Two venues are known to refuse sells in some
   * states (D-021, D-033), so "no value" is often a real venue condition
   * rather than a failure worth hiding.
   */
  readonly valueUnavailableReason: string | null;
  readonly venueId: string | null;
}

export interface PositionsOptions {
  readonly client: PublicClient;
  readonly router: VenueRouter;
  readonly owner: Address;
  readonly chainId: number;
  /** Skip dust rather than filling the panel with zero rows. */
  readonly minBalance?: bigint;
}

/**
 * Read balances and, where possible, current sell value.
 *
 * Each token is independent: one failing must not blank the panel, so failures
 * become a row with a reason rather than an exception.
 */
export async function loadPositions(tokens: readonly Address[], options: PositionsOptions): Promise<Position[]> {
  const { client, router, owner, chainId, minBalance = 1n } = options;

  const results = await Promise.all(
    tokens.map(async (token): Promise<Position | null> => {
      let balance: bigint;
      let decimals = 18;
      let symbol: string | null = null;

      try {
        [balance, decimals] = await Promise.all([
          client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }),
          client
            .readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })
            .then((d) => Number(d))
            .catch(() => 18),
        ]);
      } catch {
        // Not a readable ERC-20 at this address; drop it rather than showing a
        // row that means nothing.
        return null;
      }

      if (balance < minBalance) return null;

      try {
        symbol = await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' });
      } catch {
        symbol = null;
      }

      const base = {
        token,
        symbol,
        decimals,
        balance,
        balanceFormatted: formatUnits(balance, decimals),
      };

      const resolution = await router.resolve({ address: token, chainId }).catch(() => null);
      if (!resolution) {
        return {
          ...base,
          valueWei: null,
          valueAsset: null,
          valueUnavailableReason: 'no venue found for this token',
          venueId: null,
        };
      }

      try {
        const quote = await resolution.adapter.quoteSell({ address: token, chainId }, balance);
        return {
          ...base,
          valueWei: quote.amountOut,
          valueAsset: quote.quoteAsset,
          valueUnavailableReason: null,
          venueId: resolution.adapter.id,
        };
      } catch (e) {
        return {
          ...base,
          valueWei: null,
          valueAsset: null,
          // Surfaced, not swallowed: a token that cannot be sold right now is
          // exactly what a holder needs to know.
          valueUnavailableReason: e instanceof Error ? (e.message.split('\n')[0] ?? 'cannot quote') : 'cannot quote',
          venueId: resolution.adapter.id,
        };
      }
    }),
  );

  return results.filter((p): p is Position => p !== null);
}

/**
 * Total of the positions that could be valued **in ETH**, and how many could
 * not.
 *
 * A position priced in another asset is counted as unvalued rather than added:
 * summing VIRTUAL into an ETH total would produce a number that is not wrong by
 * a little but meaningless, and it would look perfectly plausible (D-044).
 */
export function summarise(positions: readonly Position[]): { totalWei: bigint; valued: number; unvalued: number } {
  let totalWei = 0n;
  let valued = 0;
  let unvalued = 0;
  for (const p of positions) {
    if (p.valueWei === null || p.valueAsset !== null) unvalued++;
    else {
      totalWei += p.valueWei;
      valued++;
    }
  }
  // Reported alongside the total so a partial figure is never mistaken for a
  // complete one.
  return { totalWei, valued, unvalued };
}
