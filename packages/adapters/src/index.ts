/**
 * @hoodini/adapters — per-site DOM adapters and the runtime that drives them.
 *
 * Nothing here holds a key, builds calldata, or signs. Adapters find tokens on
 * a page and emit intents; the service worker does everything else.
 */

export type { SiteAdapter } from './site.js';
export { addressesInText, detectTokensIn, elementsFor, nearestRow, type DetectOptions } from './detect.js';
export { mountOverlay, unmountAll, HOST_ATTR, TOKEN_ATTR, type OverlayIntent, type OverlayOptions, type SellUnavailable } from './overlay.js';
export { AdapterRuntime, matchesSite, type RuntimeOptions } from './runtime.js';
export { GenericAddressAdapter, type GenericAdapterOptions } from './adapters/generic.js';
export { AxiomAdapter, createAxiomAdapter, type AxiomAdapterOptions } from './adapters/axiom.js';
export {
  ConfigurableSiteAdapter,
  createXAdapter,
  createTelegramAdapter,
  createDexScreenerAdapter,
  createSiteAdapters,
  type SiteAdapterConfig,
} from './adapters/sites.js';
