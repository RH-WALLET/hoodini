/**
 * Bundled venue registry.
 *
 * This data ships INSIDE the extension and is updated only by cutting a release
 * (CLAUDE.md invariant 3: no remote config, ever). A compromised or hijacked
 * remote registry would be able to point a buy at an attacker's contract, so the
 * mapping from "token" to "contract we call" must be reviewable in the diff.
 *
 * P0: shape only. Addresses are filled in from the verified census in
 * DATA_SOURCES.md as each adapter lands (P1a onward); nothing here is wired to
 * an adapter yet.
 */

import type { Address } from 'viem';

/** How a venue creates its tokens — determines how the router recognises them. */
export type VenueKind = 'instant-pool' | 'bonding-curve' | 'dex';

export interface VenueRegistryEntry {
  /** Matches VenueAdapter.id. */
  readonly id: string;
  readonly displayName: string;
  readonly kind: VenueKind;
  /**
   * The launchpad factory. Tokens are attributed to a venue by their creation
   * transaction's `to` (or the factory's own registry getter), never by name.
   */
  readonly factory?: Address;
  /** DEX factory that holds liquidity once a token graduates, when applicable. */
  readonly dexFactory?: Address;
  /** Router used to execute swaps for this venue's tokens. */
  readonly router?: Address;
  /**
   * VERIFIED = confirmed on-chain by scripts/recon.ts.
   * UNCONFIRMED = harvested from notes or docs, not yet re-checked.
   * Only VERIFIED entries may ever be used to build a transaction.
   */
  readonly status: 'VERIFIED' | 'UNCONFIRMED';
}

/**
 * Ordered: the router tries entries in this order when resolving an unknown
 * token via claims(). Order is a pending decision — see DECISIONS.md D-006.
 */
export const VENUE_REGISTRY: readonly VenueRegistryEntry[] = [];

/** Known token -> venue overrides, for tokens whose provenance needs pinning. */
export const TOKEN_VENUE_OVERRIDES: Readonly<Record<Address, string>> = {};
