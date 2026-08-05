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

import { getAddress, zeroAddress, type Address } from 'viem';
import type { V4HookVenue } from './v4hook.js';

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

/** klik.finance — every pool is native-ETH paired, fee 0, tickSpacing 200. */
export const KLIK_FACTORY = getAddress('0x16cF6788B762EE8969744586eD16fc5705140dd7');
export const KLIK_HOOK = getAddress('0x745d717620052a97a22dEEE2e5Eba59583f3e0CC');

/**
 * Virtuals. Priced in $VIRTUAL rather than ETH, which is why the registry entry
 * records the asset explicitly.
 */
export const VIRTUALS_BONDING = getAddress('0xd4cCBFA37e2f35611b3042e4096Ad7a3459Bd007');
export const VIRTUALS_ROUTER = getAddress('0xCa6395246B4382Ba70F886526dD9a9De984F6081');
export const VIRTUAL_TOKEN = getAddress('0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31');

/** Bound to V4_POOL_MANAGER via its own poolManager(). Used for pool existence. */
export const STATE_VIEW = getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b');

/**
 * V4 launchpads that are "a pool with our hook, always the same parameters".
 * Each is a config entry rather than an adapter (D-045). Every fee/tickSpacing/
 * numeraire below was read off that hook's own Initialize events, and every
 * constructed pool id was checked against the event and against StateView.
 */
/**
 * Plain Uniswap V4 — a pool with **no hook at all**.
 *
 * Not a launchpad. `scripts/v4-hooks.ts` found that 88% of pool initialisations
 * on this chain carry `hooks = address(0)`, and every other V4 entry here is
 * keyed to a hook, so that entire class was untradeable.
 *
 * The dominant deployer is `UERC20Factory` at `0x000000e2…` — pools.trade. Its
 * launch transaction creates the token, initialises the pool, adds liquidity
 * and swaps in one `Multicall3` call, so the token is tradeable from block one.
 * That is Pons's shape (D-007) moved to V4: the launchpad has no trade surface,
 * the DEX does.
 *
 * Deliberately *not* a pools.trade-specific venue. There is nothing
 * pools.trade-shaped to encode — no hook, no curve, no launchpad getter — so a
 * venue keyed to it would cover one deployer's share of a class this covers
 * whole (D-013's reasoning).
 *
 * **Registered last**, and it must stay last: `claims()` here means "a hookless
 * ETH pool exists at one of these shapes", which is broad enough to swallow a
 * token that a specific venue would have claimed on better evidence. The router
 * probes in registry order (D-005).
 *
 * Verified live: `0x354D146C60D52BD775c6e826F94A45265C539633`
 * (`#sufferingfromsuccess`, created by UERC20Factory) — pool
 * `0xbdfc3fd4…`, native ETH / token, fee 2500, tickSpacing 60, and a real
 * 0.25 ETH swap in the launch block.
 */
export const HOOKLESS_V4_VENUE = {
  id: 'uniswap-v4',
  displayName: 'Uniswap V4 (no hook)',
  hook: zeroAddress,
  /** Ordered by how often each shape appears in the census. */
  variants: [
    { fee: 2500, tickSpacing: 60 },
    { fee: 2500, tickSpacing: 25 },
    { fee: 10000, tickSpacing: 200 },
  ],
  /** Native ETH — these pools use `address(0)`, not WETH. */
  numeraire: zeroAddress,
} as const satisfies V4HookVenue;

export const V4_HOOK_VENUES = [
  {
    id: 'clanker',
    displayName: 'Clanker',
    hook: getAddress('0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc'),
    variants: [{ fee: 8_388_608, tickSpacing: 200 }], // dynamic-fee flag
    numeraire: getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'), // WETH
  },
  {
    id: 'cashcat',
    displayName: 'CashCat',
    hook: getAddress('0xEfe669814e5Eec33406Bd50ffa8331618D076aEc'),
    variants: [{ fee: 0, tickSpacing: 200 }],
    numeraire: getAddress('0x0000000000000000000000000000000000000000'), // native
  },
  {
    id: 'pump-v4',
    displayName: 'Pump (V4)',
    hook: getAddress('0x14bcC18fDB0e7a427122b9C2F1A40fF7D63EAACC'),
    variants: [{ fee: 0, tickSpacing: 200 }],
    numeraire: getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'), // WETH
  },
  {
    id: 'eth-creator-fee',
    displayName: 'EthCreatorFee',
    hook: getAddress('0xd7d69905657Ff6551d086ca0eb1d606a948f20cc'),
    variants: [{ fee: 0, tickSpacing: 200 }],
    numeraire: getAddress('0x0000000000000000000000000000000000000000'), // native
  },
  {
    /**
     * Token/token pools with no ETH side, so the counterparty cannot be derived
     * from the token and is bundled instead (D-046). Six pools were observed;
     * a new one needs a release, which is the bundled-registry model working as
     * intended rather than a limitation.
     */
    id: 'rwa-pairs',
    displayName: 'RWA pairs',
    hook: getAddress('0x3bFF0Db34DdB6D2e82050945b754d3580ff85Ac8'),
    variants: [{ fee: 10_000, tickSpacing: 60 }],
    pairs: {
      '0x1859202d4bebdd9d933055e2b6e43de7f1ada9bf': getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
      '0x5fc5360d0400a0fd4f2af552add042d716f1d168': getAddress('0x1859202d4beBDd9D933055e2B6e43De7f1adA9bf'),
      '0x117cc2133c37b721f49de2a7a74833232b3b4c0c': getAddress('0x7ab5Caf7EE74b0f774fDaEC56e28C0b2632443dC'),
      '0x7ab5caf7ee74b0f774fdaec56e28c0b2632443dc': getAddress('0x117CC2133c37b721F49dE2a7a74833232b3b4C0C'),
      '0x12a531d505e1e457d5775702bec430e2879624b2': getAddress('0x322F0929c4625ed5BaD873c95208d54E1c003b2d'),
      '0x322f0929c4625ed5bad873c95208d54e1c003b2d': getAddress('0x12a531d505e1e457d5775702bEC430e2879624B2'),
      '0x5324dba22a87c747043dd81081001e5b1810a6c8': getAddress('0xE93237c50D904957cF27E7B1133b510C669C2E74'),
      '0xe93237c50d904957cf27e7b1133b510c669c2e74': getAddress('0x5324dbA22A87C747043dd81081001e5B1810a6c8'),
      '0x12f190a9f9d7d37a250758b26824b97ce941bf54': getAddress('0x6B4dbb976aDc3E2982784911C008DC785AfAa5D3'),
      '0x6b4dbb976adc3e2982784911c008dc785afaa5d3': getAddress('0x12f190a9F9d7D37a250758b26824B97CE941bF54'),
      '0x219fffc7709a7890744501ccfb3200a8c6203038': getAddress('0xC0d6457c16CC70d6790dD43521c899C87CE02F35'),
      '0xc0d6457c16cc70d6790dd43521c899c87ce02f35': getAddress('0x219fFfc7709A7890744501CCFb3200A8C6203038'),
    },
  },
] as const;

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
    id: 'klik',
    displayName: 'klik.finance',
    kind: 'dex',
    // Pool identity is derivable from the token address and verified against
    // the factory's own pool id, so no bundled token list is needed.
    dexFactory: V4_POOL_MANAGER,
    router: UNIVERSAL_ROUTER,
    quoter: V4_QUOTER,
    status: 'VERIFIED',
  },
  ...V4_HOOK_VENUES.map((v) => ({
    id: v.id,
    displayName: v.displayName,
    kind: 'dex' as const,
    dexFactory: V4_POOL_MANAGER,
    router: UNIVERSAL_ROUTER,
    quoter: V4_QUOTER,
    status: 'VERIFIED' as const,
  })),
  {
    id: 'virtuals',
    displayName: 'Virtuals',
    kind: 'bonding-curve',
    router: VIRTUALS_BONDING,
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
  // LAST, deliberately. Its claims() is the broadest here — see
  // HOOKLESS_V4_VENUE — so every specific venue must get the chance first.
  {
    id: HOOKLESS_V4_VENUE.id,
    displayName: HOOKLESS_V4_VENUE.displayName,
    kind: 'dex',
    dexFactory: V4_POOL_MANAGER,
    router: UNIVERSAL_ROUTER,
    quoter: V4_QUOTER,
    status: 'VERIFIED',
  },
];

/** Known token -> venue overrides, for tokens whose provenance needs pinning. */
export const TOKEN_VENUE_OVERRIDES: Readonly<Record<string, string>> = {};
