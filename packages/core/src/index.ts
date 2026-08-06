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
  KLIK_FACTORY,
  KLIK_HOOK,
  VIRTUALS_BONDING,
  VIRTUALS_ROUTER,
  VIRTUAL_TOKEN,
  STATE_VIEW,
  V4_HOOK_VENUES,
} from './venues/registry.js';
export { VenueRouter, type VenueResolution } from './venues/router.js';
export { UniswapV3Adapter, applySlippage, type UniswapV3AdapterOptions } from './venues/uniswapV3.js';
export { DopplerAdapter, type PoolKey } from './venues/doppler.js';
export { FlapAdapter } from './venues/flap.js';
export { V4HookAdapter, hookPoolKey, poolIdOfKey, type V4HookVenue } from './venues/v4hook.js';
export { HOOKLESS_V4_VENUE } from './venues/registry.js';
export { VirtualsAdapter, WrongDenominationError } from './venues/virtuals.js';
export { KlikAdapter, klikPoolKey, poolIdOf, KLIK_POOL_FEE, KLIK_TICK_SPACING } from './venues/klik.js';
export { encodeV4Buy, encodeV4Sell, packBytes, encodeV4Actions, encodeExactInSingle } from './venues/v4.js';
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
  type VaultSet,
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
export { loadPositions, summarise, type Position, type PositionsOptions } from './positions.js';
export {
  DEFAULT_SETTINGS,
  PROFILE_COUNT,
  DEFAULT_SELL_PERCENTS,
  normaliseSettings,
  validateSettings,
  isValidPreset,
  isValidSlippageBps,
  MIN_PRESETS,
  MAX_PRESETS,
  MIN_PRESET_ETH,
  MAX_PRESET_ETH,
  MIN_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  type Settings,
  type SettingsError,
} from './settings.js';
export {
  planWithdrawal,
  WithdrawalRefused,
  type WithdrawalRequest,
  type WithdrawalContext,
  type WithdrawalPlan,
} from './withdraw.js';
