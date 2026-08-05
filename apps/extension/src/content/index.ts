/**
 * Content script.
 *
 * Runs in the page's world, so it is the least trusted part of the extension
 * and holds correspondingly little: it finds tokens, draws controls, and sends
 * intents. It has no key, builds no calldata, and cannot sign or spend — the
 * service worker refuses `trade.execute` from a page outright (D-026).
 */

import {
  AdapterRuntime,
  AxiomAdapter,
  GenericAddressAdapter,
  createGmgnAdapter,
  createSiteAdapters,
  createTerminalAdapter,
  matchesSite,
  unmountAll,
  type IntentResult,
  type OverlayIntent,
} from '@hoodini/adapters';
import { parseEther } from 'viem';
import { DEFAULT_SETTINGS, normaliseSettings, type Settings, type TokenRef } from '@hoodini/core';

const CHAIN_ID = 4663;
const DEFAULT_BUY_WEI = 10n ** 15n; // 0.001 ETH

/**
 * Live settings.
 *
 * Held in a mutable local rather than read per click: a quote must price what
 * the button says, and the button was drawn from whatever the settings were at
 * mount time. Re-reading at click time could quote a slippage the user changed
 * after the overlay was drawn.
 *
 * Starts at the defaults so the overlay works before the worker answers — a
 * cold service worker takes a moment to spin up, and a card that renders with
 * no buttons for that moment would look broken.
 */
let settings: Settings = DEFAULT_SETTINGS;

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
      // The preset the user pressed. Until the control was seen working every
      // button emitted the same intent, so `0.01` quoted 0.001 — the presets
      // were decoration. Falls back only when an adapter emits no amount.
      amount: (intent.amount ? parseEther(intent.amount) : DEFAULT_BUY_WEI).toString(),
      slippageBps: settings.slippageBps,
    });
    // Nothing is rendered from this yet — the confirm sheet lands with the
    // execute path. Surfacing it in the console keeps the round trip
    // observable without inventing UI that would imply trading works.
    console.debug('[hoodini] quote', intent.side, intent.token.address, res);
  } catch (e) {
    // A quote failing is the user pressing a button and getting nothing, so it
    // is visible by default; the successful case above stays quiet.
    console.warn('[hoodini] quote failed', e);
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
async function probeSell(token: TokenRef, percent?: number): Promise<{ reason: string } | null> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'trade.quote',
      side: 'sell',
      token: token.address,
      // Prices the exact fraction this button would sell. A venue that pays out
      // a quarter can still revert on the whole balance (D-049), so probing a
      // nominal size would gate the button on a question nobody asked.
      ...(percent !== undefined ? { percent } : {}),
      slippageBps: settings.slippageBps,
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

/**
 * A click proposes a trade; it does not start one.
 *
 * The page can only ever cause a prompt — approval happens in extension UI,
 * which this script cannot reach (D-054). So the honest thing to show on the
 * button is that the ball is now in the popup's court, not a price.
 *
 * Sells propose too. An earlier version returned here after merely quoting,
 * reasoning that the Sell control's own probe had already priced the balance
 * and that proposing again would ask the worker the same question twice. It
 * would not: the probe decides whether to *offer* the control, and the request
 * is what the user actually approves. The effect was that pressing Sell logged
 * a price at console.debug and reported success, so the sell path could not
 * reach the popup at all — found by trying to sell, never by a test (D-052,
 * D-061).
 */
async function propose(intent: OverlayIntent): Promise<IntentResult> {
  const isBuy = intent.side === 'buy' && intent.amount !== undefined;
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'trade.request',
      side: intent.side,
      token: intent.token.address,
      // Omitted entirely on a sell. The worker reads the balance itself and
      // takes the requested fraction of it; sending `0` would be an explicit
      // amount, and an explicit zero is refused rather than meaning everything.
      ...(isBuy ? { amount: parseEther(intent.amount!).toString() } : {}),
      ...(!isBuy && intent.percent !== undefined ? { percent: intent.percent } : {}),
      slippageBps: settings.slippageBps,
    })) as
      | { ok: boolean; data?: { autoApproved?: boolean }; error?: { code: string; message: string } }
      | undefined;

    if (!res) return { ok: false, message: 'no reply' };
    // Standing consent is armed, so this already ran (D-059). Saying "confirm"
    // would send the user to a popup with nothing in it, and worse, would hide
    // the fact that money just moved.
    if (res.ok && res.data?.autoApproved) return { ok: true, message: 'sent ✓' };
    if (res.ok) return { ok: true, message: 'confirm ↗' };
    // The one refusal worth naming: it means a proposal is already waiting and
    // the user has to answer that one first (D-054).
    if (res.error?.code === 'PENDING_EXISTS') return { ok: false, message: 'one pending' };
    console.warn('[hoodini] request refused', res.error);
    return { ok: false, message: 'refused' };
  } catch (e) {
    console.warn('[hoodini] request failed', e);
    return { ok: false, message: 'failed' };
  }
}

/**
 * Spend the pointer's travel time resolving the venue.
 *
 * Cold, `resolve()` costs a round trip per adapter and dominates the click —
 * measured at 1,233ms against 456ms for everything else put together. Warm it
 * costs nothing. A hover lands a few hundred milliseconds before the click, so
 * by the time the button is pressed the expensive half is already done.
 *
 * Fire-and-forget on purpose: the overlay must not wait on this, and a hover
 * that fails to warm simply means the click pays what it always paid. Deliberately
 * *not* on mount — D-049 settled that a column of fifty rows must not fire
 * fifty requests nobody asked for, and hover is the signal that one of them is
 * about to matter.
 */
function warm(token: TokenRef): void {
  void chrome.runtime.sendMessage({ type: 'trade.warm', token: token.address }).catch(() => {
    // Nothing is broken if warming fails; the click still works, just slower.
  });
}

const onIntent = (intent: OverlayIntent) => propose(intent);

// Prefer the adapter that knows this site; fall back to shape-based detection
// so an unlisted page still gets controls rather than nothing.
//
// The three terminals come first, and the order matters: each gates on chain,
// and the generic fallback does not. On a multi-chain terminal the generic
// adapter would decorate BNB, Ethereum and Solana rows as though they were
// Robinhood Chain (D-050), so it must never be what handles them.
const adapterOptions = {
  chainId: CHAIN_ID,
  onIntent,
  probeSell,
  onWarm: warm,
  // A getter, not a snapshot: the adapter is built once at load, before the
  // worker has answered, so a copied array would pin the overlay to the
  // defaults for the life of the page.
  get amounts(): readonly string[] {
    return settings.buyPresets;
  },
  // Also a getter: the slippage shown under the buttons has to be the slippage
  // that will actually be submitted, including after the user edits it.
  get config(): { slippageBps: number } {
    return { slippageBps: settings.slippageBps };
  },
};
const adapter =
  [
    new AxiomAdapter(adapterOptions),
    createGmgnAdapter(adapterOptions),
    createTerminalAdapter(adapterOptions),
    ...createSiteAdapters(adapterOptions),
  ].find((a) => matchesSite(a, location.href)) ?? new GenericAddressAdapter(adapterOptions);

const runtime = new AdapterRuntime(adapter, document, {
  // `warn`, not `debug`. A scan error means the overlay is not working, and
  // Chrome hides `debug` unless Verbose is switched on — so the one channel
  // that says what went wrong was invisible by default. That cost three rounds
  // of guessing before the first real bug was found (D-052).
  onError: (e) => console.warn('[hoodini] scan error', e),
});

runtime.start();

/**
 * Adopt the user's settings once the worker answers, and again whenever they
 * change.
 *
 * `unmountAll` then a rescan, rather than trying to patch each control in
 * place: the presets decide how many buttons exist and what each one spends, so
 * a partial update risks a button whose label and amount disagree — which is
 * the exact class of bug this feature was added to fix.
 */
async function adoptSettings(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'settings.get' })) as
      | { ok: boolean; data?: unknown }
      | undefined;
    if (!res?.ok) return;
    const next = normaliseSettings(res.data);
    if (next.buyPresets.join() === settings.buyPresets.join() && next.slippageBps === settings.slippageBps) {
      return;
    }
    settings = next;
    unmountAll(document);
    runtime.scan();
  } catch {
    // The worker being asleep or gone is not a reason to tear down the overlay.
  }
}

void adoptSettings();

// The popup broadcasts after a save; storage is the fallback for a save made
// while this tab was in another window.
chrome.runtime.onMessage.addListener((m: { type?: string }) => {
  if (m?.type === 'settings.changed') void adoptSettings();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['hoodini.settings.v1']) void adoptSettings();
});

// The page owns its lifecycle; leave it exactly as found on the way out.
addEventListener('pagehide', () => runtime.stop(), { once: true });
