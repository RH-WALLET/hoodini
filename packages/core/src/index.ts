/**
 * @hoodini/core — chain client, venue routing, and (later) keystore + trade engine.
 *
 * P1a ships venue resolution and the Uniswap V3 trade path. Every export here
 * either reads chain state or returns UNSIGNED calldata; there is deliberately
 * no signer and no send path in this package.
 */

export type { TokenRef, VenueState, Quote, TxRequest, VenueAdapter } from './venues/types.js';
export type { VenueKind, VenueRegistryEntry } from './venues/registry.js';
export {
  VENUE_REGISTRY,
  TOKEN_VENUE_OVERRIDES,
  PONS_FACTORIES,
  NOXA_FACTORY,
  WETH,
  UNISWAP_V3_FACTORY,
  SWAP_ROUTER_02,
  QUOTER_V2,
  V3_FEE_TIERS,
  V4_POOL_MANAGER,
  V4_QUOTER,
  V4_UNIVERSAL_ROUTERS,
  UNIVERSAL_ROUTER,
  PERMIT2,
  DOPPLER_HOOK,
  DOPPLER_AIRLOCK,
  FLAP_PORTAL,
} from './venues/registry.js';
export { VenueRouter, type VenueResolution } from './venues/router.js';
export { UniswapV3Adapter, applySlippage, type UniswapV3AdapterOptions } from './venues/uniswapV3.js';
export { DopplerAdapter, type PoolKey } from './venues/doppler.js';
export { FlapAdapter } from './venues/flap.js';
export { createChainClient, robinhoodChain, ROBINHOOD_CHAIN_ID, DEFAULT_RPC_URL } from './chain.js';

export {
  createVault,
  createRandomVault,
  unlockVault,
  exportPrivateKey,
  changePassword,
  generatePrivateKey,
  KeystoreSession,
  KeystoreError,
  DEFAULT_KDF,
  TEST_KDF,
  DEFAULT_AUTO_LOCK_MS,
  type EncryptedVault,
  type KdfParams,
  type UnlockedAccount,
} from './keystore/index.js';
export {
  planBuy,
  planSell,
  minOutOf,
  totalValueWei,
  UnsupportedVenueError,
  type TradePlan,
  type TradeStep,
  type StepKind,
} from './engine/planner.js';
