/**
 * Content script.
 *
 * Runs in the page's world, so it is the least trusted part of the extension
 * and holds correspondingly little: it finds tokens, draws controls, and sends
 * intents. It has no key, builds no calldata, and cannot sign or spend — the
 * service worker refuses `trade.execute` from a page outright (D-026).
 */

import { AdapterRuntime, AxiomAdapter, GenericAddressAdapter, createSiteAdapters, matchesSite, type OverlayIntent } from '@hoodini/adapters';
import type { TokenRef } from '@hoodini/core';

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

/**
 * Ask the worker whether this token can actually be sold right now.
 *
 * Omitting `amount` quotes the whole balance, because sell availability is
 * size-dependent — a curve can pay out a small amount and revert on a large
 * one — so probing a nominal amount would report a sell that then fails
 * (D-049).
 *
 * Returns null when the sell can proceed, or a reason when it cannot.
 */
async function probeSell(token: TokenRef): Promise<{ reason: string } | null> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'trade.quote',
      side: 'sell',
      token: token.address,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    })) as { ok: boolean; error?: { code: string; message: string } } | undefined;

    if (!res) return { reason: 'the extension did not respond' };
    if (res.ok) return null;
    if (res.error?.code === 'LOCKED') return { reason: 'unlock Hoodini to sell' };
    if (res.error?.code === 'NO_BALANCE') return { reason: 'you hold none of this token' };
    return { reason: res.error?.message ?? 'this token cannot be sold right now' };
  } catch {
    // Rethrow-as-null would claim the sell is fine; instead let the overlay
    // treat a broken probe as inconclusive and re-enable.
    throw new Error('could not reach the extension');
  }
}

const onIntent = (intent: OverlayIntent) => void quote(intent);

// Prefer the adapter that knows this site; fall back to shape-based detection
// so an unlisted page still gets controls rather than nothing. Axiom is tried
// first because it is the only adapter that gates on chain, and on a
// multi-chain terminal the generic fallback would decorate BNB and Ethereum
// rows as though they were Robinhood Chain (D-050).
const adapterOptions = { chainId: CHAIN_ID, onIntent, probeSell };
const adapter =
  [new AxiomAdapter(adapterOptions), ...createSiteAdapters(adapterOptions)].find((a) =>
    matchesSite(a, location.href),
  ) ?? new GenericAddressAdapter(adapterOptions);

const runtime = new AdapterRuntime(adapter, document, {
  onError: (e) => console.debug('[hoodini] scan error', e),
});

runtime.start();

// The page owns its lifecycle; leave it exactly as found on the way out.
addEventListener('pagehide', () => runtime.stop(), { once: true });
