/**
 * Pending trade requests.
 *
 * The mechanism D-026 said had to exist before a page could start a trade: a
 * site may *propose* one, and only extension UI can approve it. A page never
 * holds `trade.execute`, so the worst a hostile or compromised site can do is
 * cause a prompt the user did not ask for — annoying, not expensive.
 *
 * ## Why one at a time
 *
 * A second request while one is pending is **refused**, not queued and not
 * substituted. Substitution is the classic attack on a confirmation dialog:
 * the user reads request A, reaches for approve, and the page swaps in B a
 * moment before the click. Refusing means what is on screen is what was asked
 * for, and stays that way until it is answered.
 *
 * A queue would have the same problem one layer down — approving the top of a
 * list a page can push to is approving something a page chose the position of.
 *
 * ## Why they expire
 *
 * An unanswered request left overnight is a click waiting to happen against
 * a price that no longer exists. Expiry is checked on read rather than by a
 * timer, because MV3 kills the worker at will and a timer is not something
 * this environment can be trusted to run.
 */

import type { Address } from 'viem';

export interface TradeRequest {
  readonly id: string;
  readonly side: 'buy' | 'sell';
  readonly token: Address;
  /** Wei, as a string. Absent on a sell — that is the whole balance (D-049). */
  readonly amount?: string;
  readonly slippageBps: number;
  /** Where it came from, shown in the confirmation. Never taken from the message. */
  readonly origin: string;
  readonly createdAt: number;
}

/** Long enough to read a confirmation, short enough that a price is still real. */
export const REQUEST_TTL_MS = 120_000;

export class PendingTrades {
  #current: TradeRequest | null = null;

  readonly #now: () => number;
  readonly #id: () => string;

  constructor(options: { now?: () => number; id?: () => string } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#id = options.id ?? (() => crypto.randomUUID());
  }

  /**
   * Record a proposal, or refuse because one is already waiting.
   *
   * Returns the request on success and `null` when something is already
   * pending — the caller turns that into an error the page can see, so a site
   * is not left believing it queued something.
   */
  propose(input: Omit<TradeRequest, 'id' | 'createdAt'>): TradeRequest | null {
    if (this.peek() !== null) return null;
    const request: TradeRequest = { ...input, id: this.#id(), createdAt: this.#now() };
    this.#current = request;
    return request;
  }

  /** The waiting request, or null. Expiry is enforced here, on every read. */
  peek(): TradeRequest | null {
    if (!this.#current) return null;
    if (this.#now() - this.#current.createdAt >= REQUEST_TTL_MS) {
      this.#current = null;
      return null;
    }
    return this.#current;
  }

  /**
   * Take the request for approval. Single use.
   *
   * Consuming before the trade runs — not after — is what stops a double click
   * or a duplicated message from spending twice. If the trade then fails, the
   * user proposes again; that is a far better failure than a second send.
   */
  take(id: string): TradeRequest | null {
    const current = this.peek();
    if (!current || current.id !== id) return null;
    this.#current = null;
    return current;
  }

  /** Drop it — the user said no, or the page navigated away. */
  clear(): void {
    this.#current = null;
  }
}
