/**
 * Service worker entry.
 *
 * The only place in the extension where a key is ever decrypted. Content
 * scripts and the popup talk to it by message; nothing else can reach the
 * keystore.
 *
 * MV3 tears this worker down whenever it likes, which drops the unlocked
 * session. That is the intended behaviour, not a bug to work around — unlocked
 * state must always be reconstructible from a password and never assumed.
 */

import { KeystoreSession } from '@hoodini/core';
import { VaultStore, chromeLocalArea } from './storage.js';
import { SettingsStore } from './settingsStore.js';
import { StandingConsent } from './consent.js';
import { TradeJournal } from './journal.js';
import { TradeEngine } from './engine.js';
import { Watchlist } from './watchlist.js';
import { PendingTrades } from './pending.js';
import { Withdrawer } from './withdrawer.js';
import { createVenueStack } from './venues.js';
import { LIVE_TRADING } from './config.js';
import { createRouter } from './router.js';
import { classifySender, senderOrigin, type Request } from './protocol.js';

const session = new KeystoreSession({
  onLock: () => {
    // Fire-and-forget: the popup may not be open, and that is fine.
    chrome.runtime.sendMessage({ type: 'wallet.locked' }).catch(() => {});
  },
});

const area = chromeLocalArea();

/**
 * The venue stack, wired at last.
 *
 * Until now the worker was constructed without it, so every `trade.quote` and
 * `positions.list` answered UNAVAILABLE — the overlay rendered its buttons and
 * clicking one did nothing. The gap was deliberate while the engine was being
 * built and then simply never closed, which is a reminder that "the handler
 * reports it is unavailable" is not the same as anyone noticing.
 *
 * Quoting is read-only. `LIVE_TRADING` is a build-time constant and is false in
 * any normal build, so wiring this grants the ability to see a price and
 * nothing else (invariant 5).
 */
const { client, venues, chainId } = createVenueStack();

/**
 * Standing consent lives in worker memory (D-059): arming does not survive the
 * worker being evicted, the browser restarting, or the wallet locking. The
 * record of the first live send does persist, because invariant 5 is about the
 * first live trade ever rather than the first one this session.
 */
const consent = new StandingConsent(area, { liveTrading: LIVE_TRADING });

let hasPending = false;
let isArmed = false;

/**
 * One painter for both signals, because they share one badge.
 *
 * A waiting proposal outranks the armed indicator: it is the one that needs
 * answering, and it clears on its own. No optional chaining on the API itself
 * — writing `chrome.action?.` turns "the API is missing" into silence, the
 * same invisible-by-default mistake that made a placement bug take three
 * rounds to find (D-052).
 */
function paintBadge(): void {
  const text = hasPending ? '1' : isArmed ? '\u25CF' : '';
  const color = hasPending ? '#7bf1a8' : '#ffb454';
  try {
    void Promise.resolve(chrome.action.setBadgeText({ text })).catch((e: unknown) =>
      console.warn('[hoodini] setBadgeText failed', e),
    );
    void Promise.resolve(chrome.action.setBadgeBackgroundColor({ color })).catch((e: unknown) =>
      console.warn('[hoodini] setBadgeBackgroundColor failed', e),
    );
    void Promise.resolve(
      chrome.action.setTitle({ title: isArmed ? 'Hoodini — auto-approve is ARMED' : 'Hoodini' }),
    ).catch(() => {});
    console.debug('[hoodini] badge', { pending: hasPending, armed: isArmed });
  } catch (e) {
    console.warn('[hoodini] badge unavailable', e);
  }
}

const handle = createRouter({
  store: new VaultStore(area),
  session,
  consent,
  settings: new SettingsStore(area),
  // In worker memory, not storage: a proposal that outlived a worker restart
  // would be a confirmation for something the user has long since scrolled
  // past, and MV3 restarts constantly.
  pending: new PendingTrades(),
  /**
   * Badge the toolbar icon while something waits.
   *
   * A proposal nobody can see is a proposal that expires unanswered — and the
   * popup cannot be opened programmatically from a content script, so the badge
   * is the only honest signal available. The popup is also told, for the case
   * where it is already open.
   */
  onPendingChange: (request) => {
    hasPending = request !== null;
    paintBadge();
    // No listener is a normal state — the popup is usually shut.
    chrome.runtime.sendMessage({ type: 'trade.pendingChanged' }).catch(() => {});
  },
  /**
   * Armed standing consent is shown on the badge too, and in a different
   * colour (D-059).
   *
   * A state in which money moves with nothing appearing on screen must not
   * itself be invisible, or the user has no way to notice they left it on. The
   * pending badge asks for attention; this one reports a standing condition,
   * so amber rather than mint, and a dot rather than a count.
   */
  onConsentChange: (armed) => {
    isArmed = armed;
    paintBadge();
    chrome.runtime.sendMessage({ type: 'consent.changed' }).catch(() => {});
  },
  withdrawer: new Withdrawer({
    client,
    session,
    journal: new TradeJournal(area),
    chainId,
    liveTrading: LIVE_TRADING,
  }),
  trade: {
    venues,
    client,
    chainId,
    watchlist: new Watchlist(area),
    engine: new TradeEngine({
      client,
      session,
      journal: new TradeJournal(area),
      liveTrading: LIVE_TRADING,
      chainId,
    }),
  },
});

const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
  const surface = classifySender(sender, chrome.runtime.id, EXTENSION_ORIGIN);
  handle(message, surface, senderOrigin(sender)).then(sendResponse, () => sendResponse({ ok: false, error: { code: 'INTERNAL', message: 'the operation failed' } }));
  return true; // keep the channel open for the async reply
});
