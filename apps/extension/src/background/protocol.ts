/**
 * The message protocol between extension surfaces and the service worker.
 *
 * ## The trust boundary
 *
 * A content script runs in the page's world. Any site can reach it, and a
 * compromised or hostile page can send anything a content script can send.
 * Content scripts are therefore treated as untrusted callers: they may
 * eventually *request a trade*, but they may never unlock, export, or sign.
 *
 * Every message declares which surfaces may send it, and the router enforces
 * that centrally rather than leaving each handler to remember (ARCHITECTURE.md).
 */

import type { Address, Hex } from 'viem';

/** Where a message came from. Derived from the sender, never from the message. */
export type Surface = 'popup' | 'page';

export interface WalletStatus {
  readonly hasVault: boolean;
  /** Present whenever a vault exists — the UI names the account while locked. */
  readonly address: Address | null;
  readonly isUnlocked: boolean;
  readonly autoLockMs: number;
}

export type Request =
  | { readonly type: 'wallet.status' }
  | { readonly type: 'wallet.create'; readonly password: string }
  | { readonly type: 'wallet.import'; readonly password: string; readonly privateKey: Hex }
  | { readonly type: 'wallet.unlock'; readonly password: string }
  | { readonly type: 'wallet.lock' }
  | { readonly type: 'wallet.export'; readonly password: string }
  | { readonly type: 'wallet.changePassword'; readonly currentPassword: string; readonly newPassword: string }
  | { readonly type: 'wallet.reset'; readonly password: string }
  | {
      readonly type: 'trade.quote';
      readonly side: 'buy' | 'sell';
      readonly token: Address;
      /**
       * Omit on a sell to quote the whole balance.
       *
       * Sell availability is size-dependent — a curve can pay out a small
       * amount and revert on a large one — so a probe must quote the amount
       * that would actually be sold, not a nominal one (D-049).
       */
      readonly amount?: string;
      readonly slippageBps: number;
    }
  | { readonly type: 'positions.list' }
  | { readonly type: 'settings.get' }
  | { readonly type: 'settings.set'; readonly settings: unknown }
  | {
      readonly type: 'trade.execute';
      readonly side: 'buy' | 'sell';
      readonly token: Address;
      readonly amount: string;
      readonly slippageBps: number;
    };

export type RequestType = Request['type'];

export type Response<T = unknown> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/**
 * Which surfaces may send each message.
 *
 * `trade.quote` is the first and only page-facing capability: it is read-only
 * public chain data, touches no key, and a site button cannot show a price
 * without it.
 *
 * `trade.execute` stays popup-only. The architecture calls for a page to
 * *request* a trade and the user to approve it in extension UI — that confirm
 * sheet does not exist yet, so until it does, a page cannot start a trade at
 * all. Granting execute first and building the confirmation afterwards would
 * leave a window where any matched site could spend funds (D-026).
 *
 * `wallet.export` and `wallet.unlock` must never appear in a `page` list. A page
 * that could unlock could drain a wallet without the user ever seeing a prompt.
 */
export const ALLOWED_SURFACES: Readonly<Record<RequestType, readonly Surface[]>> = {
  'wallet.status': ['popup'],
  'wallet.create': ['popup'],
  'wallet.import': ['popup'],
  'wallet.unlock': ['popup'],
  'wallet.lock': ['popup'],
  'wallet.export': ['popup'],
  'wallet.changePassword': ['popup'],
  'wallet.reset': ['popup'],
  'trade.quote': ['popup', 'page'],
  'trade.execute': ['popup'],
  // Holdings are the user's business, not a site's. A page that could read
  // them would learn the wallet's contents just by being visited.
  'positions.list': ['popup'],
  // The overlay needs the presets to draw its buttons, and they are not
  // sensitive — a site learning that someone's quick-buy is 0.01 ETH tells it
  // nothing it could not infer from watching a trade.
  'settings.get': ['popup', 'page'],
  // Writing is a different matter. A preset is a spend amount and slippage is
  // how much of a trade the user is willing to lose; a page that could set
  // either could quietly widen both and wait to be clicked.
  'settings.set': ['popup'],
};

/** Capabilities a page may never hold, whatever else changes. */
export const NEVER_PAGE_ACCESSIBLE: readonly RequestType[] = [
  'wallet.unlock',
  'wallet.export',
  'wallet.create',
  'wallet.import',
  'wallet.changePassword',
  'wallet.reset',
  // Spending must never be reachable from a page without a confirm sheet.
  'trade.execute',
  'positions.list',
  // Changing what a button spends is a spending decision.
  'settings.set',
];

/**
 * Classify a sender. A content script always carries `tab`; popup and options
 * pages do not and their URL is the extension's own origin.
 *
 * Deliberately fails closed: anything unrecognised is treated as a page.
 */
export function classifySender(
  sender: { id?: string | undefined; tab?: unknown; url?: string | undefined },
  extensionId: string,
  extensionOrigin: string,
): Surface | null {
  // A message from another extension is not ours to serve.
  if (sender.id !== extensionId) return null;
  if (sender.tab !== undefined) return 'page';
  if (typeof sender.url === 'string' && sender.url.startsWith(extensionOrigin)) return 'popup';
  return 'page';
}

/**
 * `table` is injectable so the backstop can be tested independently of the
 * current policy. The two checks are deliberately redundant: today the table
 * grants pages nothing, but the backstop is what holds if a future edit adds
 * `page` to a sensitive entry by mistake. Redundant defences are only worth
 * having if each one is proven to work on its own.
 */
export function isAllowed(
  type: RequestType,
  surface: Surface,
  table: Readonly<Record<RequestType, readonly Surface[]>> = ALLOWED_SURFACES,
): boolean {
  if (surface === 'page' && NEVER_PAGE_ACCESSIBLE.includes(type)) return false;
  return table[type]?.includes(surface) ?? false;
}
