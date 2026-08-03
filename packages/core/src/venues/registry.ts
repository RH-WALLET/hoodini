/**
 * Bundled venue registry.
 *
 * This data ships INSIDE the extension and is updated only by cutting a release
 * (CLAUDE.md invariant 3: no remote config, ever). A compromised or hijacked
 * remote registry would be able to point a buy at an attacker's contract, so the
 * mapping from "token" to "contract we call" must be reviewable in the diff.
 *
 * Every address below is VERIFIED in DATA_SOURCES.md — confirmed on-chain by
 * scripts/recon.ts. Only VERIFIED entries may be used to build a transaction
 * (D-010).
 */

import { getAddress, type Address } from 'viem';

/** How a venue creates its tokens — determines how the router recognises them. */
export type VenueKind = 'instant-pool' | 'bonding-curve' | 'dex';

export interface VenueRegistryEntry {
  /** Matches VenueAdapter.id. */
  readonly id: string;
  readonly displayName: string;
  readonly kind: VenueKind;
  /**
   * Launchpad factories whose tokens this venue trades. A set, not a single
   * address: the Pons interface has been cloned repeatedly and every clone
   * settles to the same pool infrastructure, so they are one adapter (D-013).
   */
  readonly factories?: readonly Address[];
  /** DEX factory holding the liquidity. */
  readonly dexFactory?: Address;
  /** Router used to execute swaps. */
  readonly router?: Address;
  /** Quoter used to price swaps, bound to `dexFactory` by its own factory(). */
  readonly quoter?: Address;
  readonly status: 'VERIFIED' | 'UNCONFIRMED';
}

// ── Core infrastructure (DATA_SOURCES.md §2) ────────────────────────────────

export const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
export const UNISWAP_V3_FACTORY = getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');

/**
 * Both bind to UNISWAP_V3_FACTORY via their own factory(), and SwapRouter02 is
 * additionally the router Pons itself names in getDexConfig(0) (D-009). Name is
 * not evidence on this chain — several same-named contracts bind to *other*
 * factories — so these were selected by binding, never by name.
 */
export const SWAP_ROUTER_02 = getAddress('0xCaf681a66D020601342297493863E78C959E5cb2');
export const QUOTER_V2 = getAddress('0x238ECf693467381E6402AD7d7833880FfeA33D88');

/**
 * Fee tiers to probe when locating a pool, most likely first. Every Pons launch
 * config uses 10000 (1%), so the first probe hits for the dominant venue.
 */
export const V3_FEE_TIERS = [10_000, 3_000, 500, 100] as const;

/**
 * Every known Pons-interface factory (DATA_SOURCES.md §7). All nine declare an
 * identical dex config — same V3 factory, same router, same fee tier.
 *
 * This list is a convenience, not a requirement: `claims()` reads the factory
 * off the *token*, so a clone deployed after our last release still resolves.
 * Adding a tenth is a data-only change.
 */
export const PONS_FACTORIES: readonly Address[] = [
  getAddress('0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'), // Pons V1 — the real one
  getAddress('0x78A3613eac99d072EFFd3e07feC462Da28b67F54'),
  getAddress('0x7A8dB326E50A6e8CBc0616E0636B63737b5E84c8'),
  getAddress('0x75eCa6306fFA2d6A66Ad841072CF6E805f0D35A7'),
  getAddress('0x966ffA3957a6d3621D3EfC96E22160806f0EF141'),
  getAddress('0xce9BA2D14F320627F177ABE20885C6363f012634'),
  getAddress('0xf830DA401D45494129b8ED844744F08296557a97'),
  getAddress('0xB8e6519b16BFc4487Ed931DaCb6Fb739e1d7e008'),
  getAddress('0x9eCb03CED43dc1e10aC07d268E3dd5c00349b947'),
];

/** NOXA — launches disabled since 2026-07-11, but its tokens still trade on V3. */
export const NOXA_FACTORY = getAddress('0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB');


// ── Uniswap V4 / Doppler (DATA_SOURCES.md §7b) ──────────────────────────────

export const V4_POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951');
export const DOPPLER_HOOK = getAddress('0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544');
export const DOPPLER_AIRLOCK = getAddress('0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862');

/** Bound to V4_POOL_MANAGER via its own poolManager(). Four deployments answer
 *  identically; this one is pinned so quotes are reproducible. */
export const V4_QUOTER = getAddress('0x218AfB5850b862580A60eEA20AA4d5FA4400ae41');

/**
 * The two UniversalRouters that both carry real traffic AND bind to
 * V4_POOL_MANAGER. Every contract merely *named* UniversalRouter on this chain
 * binds to a different PoolManager, so these were selected by binding (D-009's
 * rule), never by name. Reserved for the P1b-2 write path.
 */
export const V4_UNIVERSAL_ROUTERS: readonly Address[] = [
  getAddress('0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77'),
  getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904'),
];

/**
 * The canonical UniversalRouter — pinned. Its constructor args wire it to OUR
 * infrastructure: Permit2, WETH `0x0Bd7D308…`, the V3 factory
 * `0x1f7d7550…` and the V4 PoolManager `0x8366a39C…`.
 *
 * The other bound router (`0x8876789976…`) is a fork with a different command
 * mask and an extra `executeSigned`, so it is deliberately not used.
 */
export const UNIVERSAL_ROUTER = getAddress('0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77');

/** Canonical Permit2 — constructor arg [0] of UNIVERSAL_ROUTER. */
export const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3');

/**
 * flap.sh Portal (a TransparentUpgradeableProxy). Its implementation has
 * already changed once during this project, so the adapter reads state and
 * quotes from the proxy and never caches an implementation address.
 */
export const FLAP_PORTAL = getAddress('0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09');

export const VENUE_REGISTRY: readonly VenueRegistryEntry[] = [
  {
    id: 'uniswap-v3',
    displayName: 'Uniswap V3',
    kind: 'dex',
    factories: [...PONS_FACTORIES, NOXA_FACTORY],
    dexFactory: UNISWAP_V3_FACTORY,
    router: SWAP_ROUTER_02,
    quoter: QUOTER_V2,
    status: 'VERIFIED',
  },
  {
    id: 'flap',
    displayName: 'flap.sh',
    kind: 'bonding-curve',
    // No factory attribution: the Portal itself answers whether it launched a
    // token, so claims() is one call and needs no bundled token list.
    router: FLAP_PORTAL,
    status: 'VERIFIED',
  },
  {
    id: 'doppler',
    displayName: 'Doppler (Uniswap V4)',
    kind: 'bonding-curve',
    // No factory: on V4 the launchpad is the hook, so attribution comes from
    // the hook's own getState() rather than from a creation trace.
    dexFactory: V4_POOL_MANAGER,
    router: UNIVERSAL_ROUTER,
    quoter: V4_QUOTER,
    status: 'VERIFIED',
  },
];

/** Known token -> venue overrides, for tokens whose provenance needs pinning. */
export const TOKEN_VENUE_OVERRIDES: Readonly<Record<string, string>> = {};
