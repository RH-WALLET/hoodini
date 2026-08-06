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

export interface WalletAccount {
  readonly address: Address;
  readonly label: string | null;
}

export interface WalletStatus {
  readonly hasVault: boolean;
  /** The active account. Present whenever a vault exists, locked or not. */
  readonly address: Address | null;
  readonly isUnlocked: boolean;
  readonly autoLockMs: number;
  /** Every wallet this installation holds, in order (D-070). */
  readonly accounts: readonly WalletAccount[];
  readonly activeIndex: number;
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
  /**
   * Multi-wallet (D-070). All popup-only: which account signs is a spending
   * decision, and a page that could switch it could move funds from a wallet
   * the user was not looking at.
   */
  | { readonly type: 'wallet.select'; readonly index: number }
  /** Add another wallet. Needs the password again — see the handler. */
  | { readonly type: 'wallet.addAccount'; readonly password: string; readonly privateKey?: Hex }
  | { readonly type: 'wallet.rename'; readonly index: number; readonly label: string }
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
      /**
       * Fraction of the balance to sell, 1–100. Sells only.
       *
       * Sent instead of an amount because the page cannot know the balance and
       * must not be told it: `positions.list` is popup-only so a site never
       * learns what someone holds (D-053). A percentage is meaningful without
       * that disclosure, and the worker resolves it against the real balance at
       * the moment it prices the trade (D-065).
       */
      readonly percent?: number;
      readonly slippageBps: number;
    }
  /**
   * Warm the venue cache for a token, and answer nothing about it.
   *
   * Resolving which venue trades a token is the expensive half of a trade:
   * cold it costs a round trip per adapter, warm it costs nothing, and both the
   * router and each adapter memoise the result. Paying it while the pointer is
   * still travelling towards the button is the whole trick — the click then
   * skips straight to quoting.
   *
   * Strictly weaker than `trade.quote`, deliberately. It carries no side, no
   * amount and no slippage, and its reply is the same `{ ok: true }` whether
   * resolution succeeded, failed or found nothing — so it cannot be used as an
   * oracle for anything the page could not already ask outright.
   */
  | { readonly type: 'trade.warm'; readonly token: Address }
  /**
   * Standing consent: approve buys without a sheet until disarmed.
   *
   * Popup-only, all three. A page that could arm this could approve its own
   * proposals, which is the entire thing D-026 exists to prevent — it would be
   * `trade.execute` reached by a longer route.
   */
  | { readonly type: 'consent.arm' }
  | { readonly type: 'consent.disarm' }
  | { readonly type: 'consent.status' }
  /**
   * The wallet's native ETH balance.
   *
   * Popup-only for the same reason as `positions.list`: what someone holds is
   * their business, not a site's. A page that could read it would learn the
   * wallet's contents just by being visited.
   */
  | { readonly type: 'wallet.balance' }
  /**
   * Chain-wide figures: the coin price and current gas. Read from the public
   * explorer, which carries no address, so this discloses nothing about who
   * asked (D-064).
   */
  | { readonly type: 'chain.stats' }
  /**
   * This wallet's sent transactions.
   *
   * Popup-only, and it names the address to a third party by construction —
   * which is why the popup asks for it on demand rather than on open.
   */
  | { readonly type: 'history.list' }
  /** Outstanding ERC-20 allowances this wallet has granted. */
  | { readonly type: 'approvals.list' }
  /** Set one allowance back to zero. A send: it signs and broadcasts. */
  | { readonly type: 'approvals.revoke'; readonly token: Address; readonly spender: Address }
  | { readonly type: 'positions.list' }
  | { readonly type: 'settings.get' }
  | { readonly type: 'settings.set'; readonly settings: unknown }
  /**
   * Edit the buy amounts of the active profile, and nothing else.
   *
   * Page-allowed, unlike `settings.set`, and the asymmetry is the point. A buy
   * preset is *drawn on the button it sets*: a page that changed one to 5 ETH
   * would produce a button reading `5`, so it cannot cause a spend the user did
   * not see. Slippage has no such property — it is a number nobody would notice
   * changing, and a page that could raise it could have every later trade
   * sandwiched — so slippage stays popup-only and this message cannot touch it
   * (D-071).
   *
   * Validated exactly as a popup edit is, so the same ceiling applies.
   */
  | { readonly type: 'settings.setPresets'; readonly buyPresets: readonly string[] }
  /**
   * A page *proposing* a trade. Moves nothing: it records a request that only
   * extension UI can approve. This is the capability D-026 said had to exist
   * before a site could start a trade at all.
   */
  | {
      readonly type: 'trade.request';
      readonly side: 'buy' | 'sell';
      readonly token: Address;
      readonly amount?: string;
      /** Fraction of the balance to sell, 1–100. Sells only. */
      readonly percent?: number;
      readonly slippageBps: number;
    }
  | { readonly type: 'trade.pending' }
  | { readonly type: 'trade.approve'; readonly id: string }
  | { readonly type: 'trade.reject' }
  /**
   * Move plain ETH out of the wallet. `amount` is wei, or `'max'` to sweep.
   *
   * The second thing in this extension that can spend, and like the first it
   * is popup-only — a page that could move ETH would not need a trade path at
   * all, it would just empty the wallet.
   */
  | { readonly type: 'wallet.withdraw'; readonly to: string; readonly amount: string }
  | {
      readonly type: 'trade.execute';
      readonly side: 'buy' | 'sell';
      readonly token: Address;
      /**
       * Omit on a sell to sell the whole balance, exactly as `trade.quote`
       * does.
       *
       * This was declared required while the handler had always branched on
       * its absence, so the type insisted a real code path could not happen.
       * The approve path satisfied the compiler with `?? '0'`, and since an
       * explicit zero is refused as out of range, every approved sell became
       * BAD_REQUEST. The type was wrong, and the wrong type is what produced
       * the bug (D-061).
       */
      readonly amount?: string;
      /** Fraction of the balance to sell, 1–100. Sells only. See `trade.quote`. */
      readonly percent?: number;
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
  'wallet.select': ['popup'],
  'wallet.addAccount': ['popup'],
  'wallet.rename': ['popup'],
  'trade.quote': ['popup', 'page'],
  // Warming is a quote with everything interesting removed: no price comes
  // back, no calldata, no signal at all. A page that may quote may obviously
  // warm — this grants nothing `trade.quote` did not already.
  'trade.warm': ['popup', 'page'],
  'trade.execute': ['popup'],
  // Holdings are the user's business, not a site's. A page that could read
  // them would learn the wallet's contents just by being visited.
  'positions.list': ['popup'],
  'wallet.balance': ['popup'],
  // All four are the user's own business, and the last one spends gas.
  // Global chain figures — the coin price and current gas. No address is in the
  // request or the reply, so this tells a site nothing about who is asking, and
  // the same numbers are on every block explorer. The panel prints gas beside
  // the buttons, which is the point of showing it at all (D-069).
  'chain.stats': ['popup', 'page'],
  'history.list': ['popup'],
  'approvals.list': ['popup'],
  'approvals.revoke': ['popup'],
  // The overlay needs the presets to draw its buttons, and they are not
  // sensitive — a site learning that someone's quick-buy is 0.01 ETH tells it
  // nothing it could not infer from watching a trade.
  'settings.get': ['popup', 'page'],
  // Writing is a different matter. A preset is a spend amount and slippage is
  // how much of a trade the user is willing to lose; a page that could set
  // either could quietly widen both and wait to be clicked.
  'settings.set': ['popup'],
  // Amounts only, and only the active profile's. See the type for why this is
  // safe to hand a page while `settings.set` is not.
  'settings.setPresets': ['popup', 'page'],
  // A page may propose. Proposing moves nothing and cannot be made to move
  // anything: the worst it achieves is a prompt nobody asked for, and only one
  // at a time. This is deliberately *not* `trade.execute` under another name —
  // approval happens in extension UI, where a site cannot reach.
  'trade.request': ['popup', 'page'],
  // Reading, approving and rejecting are the user's side of that conversation
  // and stay entirely out of a page's reach. A page that could read the pending
  // request would learn what the user is about to do; one that could approve
  // would not need the user at all.
  // Arming is the most consequential switch in the extension: it is the one
  // that lets money move without a human reading anything. A page that could
  // reach it would hold `trade.execute` under another name.
  'consent.arm': ['popup'],
  'consent.disarm': ['popup'],
  'consent.status': ['popup'],
  'trade.pending': ['popup'],
  'trade.approve': ['popup'],
  'trade.reject': ['popup'],
  'wallet.withdraw': ['popup'],
};

/** Capabilities a page may never hold, whatever else changes. */
export const NEVER_PAGE_ACCESSIBLE: readonly RequestType[] = [
  // Choosing which wallet signs is a spending decision. A page that could do it
  // could move funds from an account the user was not even looking at.
  'wallet.select',
  'wallet.addAccount',
  // Revoking signs and broadcasts. A page holding it could burn gas at will and
  // strip the allowances a user's other tools depend on.
  'approvals.revoke',
  // Arming approves future spends with no sheet, so a page holding it could
  // spend without the user ever seeing a prompt. Same class as unlock.
  'consent.arm',
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
  // Approving a trade is the whole point of having a confirmation. A page that
  // could approve, or could read what is awaiting approval, would make the
  // prompt theatre.
  'trade.approve',
  'trade.reject',
  'trade.pending',
  // The most direct way to steal from this wallet, if it were ever reachable.
  'wallet.withdraw',
];

/**
 * The site a message came from, for showing in a confirmation.
 *
 * Derived from the sender, never from the message — a page that could name its
 * own origin could name someone else's, and the whole value of showing it is
 * that it cannot be forged. Returns null when there is no meaningful origin.
 */
export function senderOrigin(sender: { url?: string | undefined }): string | null {
  if (typeof sender.url !== 'string') return null;
  try {
    return new URL(sender.url).origin;
  } catch {
    return null;
  }
}

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
