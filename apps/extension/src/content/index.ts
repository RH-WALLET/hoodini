/**
 * Content script.
 *
 * Runs in the page's world, so it is the least trusted part of the extension
 * and holds correspondingly little: it finds tokens, draws controls, and sends
 * intents. It has no key, builds no calldata, and cannot sign or spend — the
 * service worker refuses `trade.execute` from a page outright (D-026).
 */

import { AdapterRuntime, GenericAddressAdapter, type OverlayIntent } from '@hoodini/adapters';

const CHAIN_ID = 4663;
const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_BUY_WEI = 10n ** 15n; // 0.001 ETH

/**
 * Ask the worker to price a trade.
 *
 * Quoting is the only capability a page has. `trade.execute` is deliberately
 * unreachable from here until a confirm sheet exists, so a click currently
 * surfaces a price rather than spending anything.
 */
async function quote(intent: OverlayIntent): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'trade.quote',
      side: intent.side,
      token: intent.token.address,
      amount: DEFAULT_BUY_WEI.toString(),
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });
    // Nothing is rendered from this yet — the confirm sheet lands with the
    // execute path. Surfacing it in the console keeps the round trip
    // observable without inventing UI that would imply trading works.
    console.debug('[hoodini] quote', intent.side, intent.token.address, res);
  } catch (e) {
    console.debug('[hoodini] quote failed', e);
  }
}

const adapter = new GenericAddressAdapter({
  chainId: CHAIN_ID,
  onIntent: (intent) => void quote(intent),
});

const runtime = new AdapterRuntime(adapter, document, {
  onError: (e) => console.debug('[hoodini] scan error', e),
});

runtime.start();

// The page owns its lifecycle; leave it exactly as found on the way out.
addEventListener('pagehide', () => runtime.stop(), { once: true });
