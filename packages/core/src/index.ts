/**
 * @hoodini/core — chain client, keystore, and trade engine.
 *
 * P0 ships the venue abstraction only. The keystore (P2) and trade engine
 * (P1a) are not written yet; there is deliberately no send path in this
 * package.
 */

export type { TokenRef, VenueState, Quote, TxRequest, VenueAdapter } from './venues/types.js';
export type { VenueKind, VenueRegistryEntry } from './venues/registry.js';
export { VENUE_REGISTRY, TOKEN_VENUE_OVERRIDES } from './venues/registry.js';
export { VenueRouter, type VenueResolution } from './venues/router.js';
