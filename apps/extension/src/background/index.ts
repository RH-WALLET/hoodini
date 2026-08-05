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
import { TradeJournal } from './journal.js';
import { TradeEngine } from './engine.js';
import { Watchlist } from './watchlist.js';
import { PendingTrades } from './pending.js';
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

const handle = createRouter({
  store: new VaultStore(area),
  session,
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
    void chrome.action?.setBadgeText?.({ text: request ? '1' : '' });
    void chrome.action?.setBadgeBackgroundColor?.({ color: '#7bf1a8' });
    chrome.runtime.sendMessage({ type: 'trade.pendingChanged' }).catch(() => {});
  },
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
