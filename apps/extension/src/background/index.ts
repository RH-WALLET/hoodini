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
import { createRouter } from './router.js';
import { classifySender, type Request } from './protocol.js';

const session = new KeystoreSession({
  onLock: () => {
    // Fire-and-forget: the popup may not be open, and that is fine.
    chrome.runtime.sendMessage({ type: 'wallet.locked' }).catch(() => {});
  },
});

const handle = createRouter({ store: new VaultStore(chromeLocalArea()), session });

const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
  const surface = classifySender(sender, chrome.runtime.id, EXTENSION_ORIGIN);
  handle(message, surface).then(sendResponse, () => sendResponse({ ok: false, error: { code: 'INTERNAL', message: 'the operation failed' } }));
  return true; // keep the channel open for the async reply
});
