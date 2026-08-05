/**
 * VenueRouter — resolves a contract address to the adapter that can trade it.
 *
 * Resolution order:
 *   1. bundled registry (TOKEN_VENUE_OVERRIDES, then factory attribution)
 *   2. claims() probed across registered adapters, for tokens the registry
 *      doesn't know — the runtime fallback
 *
 * Registry-first matters for more than speed: attribution from bundled data is
 * reviewable in a diff, whereas claims() trusts what the token says about
 * itself. Both paths end at the same adapter, so a lying token gains nothing —
 * but the common case never depends on the token's own claims.
 */

import { getAddress, isAddressEqual, type Address, type PublicClient } from 'viem';
import type { TokenRef, VenueAdapter } from './types.js';
import { PONS_TOKEN_ABI } from '../abis.js';
import { TOKEN_VENUE_OVERRIDES, VENUE_REGISTRY, type VenueRegistryEntry } from './registry.js';

export interface VenueResolution {
  readonly adapter: VenueAdapter;
  /** How the token was attributed, so the UI can show provenance. */
  readonly via: 'override' | 'registry' | 'claims';
}

export class VenueRouter {
  readonly #adapters: readonly VenueAdapter[];
  /** Positive resolutions, per token. See #remember for why not negatives. */
  readonly #resolved = new Map<string, VenueResolution>();
  readonly #registry: readonly VenueRegistryEntry[];
  readonly #client: PublicClient | undefined;

  constructor(
    adapters: readonly VenueAdapter[],
    registry: readonly VenueRegistryEntry[] = VENUE_REGISTRY,
    client?: PublicClient,
  ) {
    this.#adapters = adapters;
    this.#registry = registry;
    this.#client = client;
  }

  /**
   * Resolve a token to its venue. Returns null when no adapter claims it — the
   * UI must then show "unsupported venue" rather than guessing a router.
   */
  async resolve(token: TokenRef): Promise<VenueResolution | null> {
    const cached = this.#resolved.get(token.address.toLowerCase());
    if (cached) return cached;

    // 1a. Explicit override.
    const override = TOKEN_VENUE_OVERRIDES[token.address.toLowerCase()];
    if (override) {
      const adapter = this.#byId(override);
      if (adapter) return this.#remember(token, { adapter, via: 'override' });
    }

    // 1b. Factory attribution from bundled data.
    const factory = await this.#launchFactory(token);
    if (factory) {
      for (const entry of this.#registry) {
        if (entry.status !== 'VERIFIED') continue;
        if (!entry.factories?.some((f) => isAddressEqual(f, factory))) continue;
        const adapter = this.#byId(entry.id);
        if (adapter) return this.#remember(token, { adapter, via: 'registry' });
      }
    }

    // 2. Runtime fallback for tokens the bundle doesn't know.
    //
    // Probed **concurrently**, then decided by registry rank. Sequentially this
    // cost one RPC round trip per adapter — measured at 3.6s cold on a chain
    // whose round trip is ~200ms — which is unusable for a product whose whole
    // point is being fast on a new token.
    //
    // The answer is identical to the sequential one: rank still decides, so a
    // broad claimer like hookless V4 still loses to a specific venue. The only
    // difference is that every adapter is asked rather than stopping at the
    // first yes, which costs some read load and buys back seconds.
    const ordered = this.#orderedAdapters();
    const claims = await Promise.all(
      // An adapter that throws simply does not claim the token.
      ordered.map((a) => a.claims(token).then((c) => c === true, () => false)),
    );
    const winner = claims.findIndex(Boolean);
    if (winner >= 0) return this.#remember(token, { adapter: ordered[winner]!, via: 'claims' });

    return null;
  }

  /**
   * Cache a resolution for this token.
   *
   * Positives only, and deliberately: a token's venue does not change once its
   * pool exists, but a token that has *just* launched can legitimately go from
   * unclaimed to claimed within seconds. Caching that negative would leave the
   * newest tokens — the ones this product exists for — permanently
   * "unsupported" for the life of the worker.
   */
  #remember(token: TokenRef, resolution: VenueResolution): VenueResolution {
    this.#resolved.set(token.address.toLowerCase(), resolution);
    return resolution;
  }

  /** Adapters in registry priority order, with any unregistered ones last. */
  #orderedAdapters(): readonly VenueAdapter[] {
    const rank = new Map(this.#registry.map((e, i) => [e.id, i]));
    return [...this.#adapters].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  #byId(id: string): VenueAdapter | undefined {
    return this.#adapters.find((a) => a.id === id);
  }

  /** One static call. Absent on non-launchpad tokens, which is not an error. */
  async #launchFactory(token: TokenRef): Promise<Address | null> {
    if (!this.#client) return null;
    try {
      const factory = await this.#client.readContract({
        address: token.address,
        abi: PONS_TOKEN_ABI,
        functionName: 'launchFactory',
      });
      return factory ? getAddress(factory) : null;
    } catch {
      return null;
    }
  }

  get adapters(): readonly VenueAdapter[] {
    return this.#adapters;
  }

  /** Registry the router resolves against. Bundled data, never fetched. */
  get registry(): readonly VenueRegistryEntry[] {
    return this.#registry;
  }
}
