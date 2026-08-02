/**
 * VenueRouter — resolves a contract address to the adapter that can trade it.
 *
 * Resolution order:
 *   1. bundled registry (TOKEN_VENUE_OVERRIDES, then factory attribution)
 *   2. claims() probed across registered adapters, for tokens the registry
 *      doesn't know — the runtime fallback
 *
 * P0: stub only. Every method throws; P1a implements them against real adapters.
 */

import type { TokenRef, VenueAdapter } from './types.js';
import { VENUE_REGISTRY, type VenueRegistryEntry } from './registry.js';

export interface VenueResolution {
  readonly adapter: VenueAdapter;
  /** How the token was attributed, so the UI can show provenance. */
  readonly via: 'registry' | 'claims';
}

export class VenueRouter {
  readonly #adapters: readonly VenueAdapter[];
  readonly #registry: readonly VenueRegistryEntry[];

  constructor(adapters: readonly VenueAdapter[], registry: readonly VenueRegistryEntry[] = VENUE_REGISTRY) {
    this.#adapters = adapters;
    this.#registry = registry;
  }

  /**
   * Resolve a token to its venue. Returns null when no adapter claims it — the
   * UI must then show "unsupported venue" rather than guessing a router.
   */
  resolve(_token: TokenRef): Promise<VenueResolution | null> {
    throw new Error('VenueRouter.resolve: not implemented (P1a)');
  }

  /** Adapters currently registered, in registry priority order. */
  get adapters(): readonly VenueAdapter[] {
    return this.#adapters;
  }

  /** Registry the router resolves against. Bundled data, never fetched. */
  get registry(): readonly VenueRegistryEntry[] {
    return this.#registry;
  }
}
