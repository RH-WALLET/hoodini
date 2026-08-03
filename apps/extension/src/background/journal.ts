/**
 * In-flight trade journal.
 *
 * MV3 can tear the service worker down at any moment, including between
 * signing and receiving a receipt. A record is written BEFORE each broadcast
 * and resolved after the receipt, so the next worker lifetime can tell the
 * difference between "never sent" and "sent, outcome unknown".
 *
 * An unresolved record blocks further trading. It is never auto-resent:
 * resending a transaction whose fate is unknown is exactly how a double-spend
 * happens.
 */

import type { StorageArea } from './storage.js';

export const JOURNAL_KEY = 'hoodini.inflight.v1';

export interface JournalEntry {
  readonly id: string;
  readonly kind: 'approve' | 'swap';
  readonly to: string;
  readonly value: string;
  readonly nonce: number;
  readonly at: number;
  readonly hash?: string;
}

export class TradeJournal {
  readonly #area: StorageArea;
  readonly #now: () => number;
  readonly #id: () => string;

  constructor(area: StorageArea, opts: { now?: () => number; id?: () => string } = {}) {
    this.#area = area;
    this.#now = opts.now ?? (() => Date.now());
    this.#id = opts.id ?? (() => crypto.randomUUID());
  }

  async record(entry: Omit<JournalEntry, 'id' | 'at'>): Promise<string> {
    const id = this.#id();
    await this.#area.set({ [JOURNAL_KEY]: { ...entry, id, at: this.#now() } satisfies JournalEntry });
    return id;
  }

  /** Mark as broadcast-and-confirmed, then clear. */
  async resolve(id: string, hash: string): Promise<void> {
    const current = await this.pending();
    // Only the owner of the record may clear it; a late resolve from a previous
    // lifetime must not wipe a newer in-flight entry.
    if (!current || current.id !== id) return;
    void hash;
    await this.#area.remove(JOURNAL_KEY);
  }

  async pending(): Promise<JournalEntry | null> {
    const got = await this.#area.get(JOURNAL_KEY);
    const raw = got[JOURNAL_KEY];
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as JournalEntry;
    return typeof e.id === 'string' && typeof e.nonce === 'number' ? e : null;
  }

  /** Operator escape hatch, once a human has checked the chain. */
  async clear(): Promise<void> {
    await this.#area.remove(JOURNAL_KEY);
  }
}
