/**
 * Tokens the user has actually interacted with.
 *
 * Positions are computed from this list, because there is no indexer to ask
 * (CLAUDE.md invariant 4). A token enters the list when it is quoted or traded,
 * so the panel reflects what the user has done in Hoodini — not a full
 * portfolio, which the UI says explicitly rather than implying otherwise.
 */

import { getAddress, isAddress, type Address } from 'viem';
import type { StorageArea } from './storage.js';

export const WATCHLIST_KEY = 'hoodini.watchlist.v1';

/** Bounded so a page that quotes thousands of tokens cannot grow storage without limit. */
const MAX_ENTRIES = 200;

export class Watchlist {
  readonly #area: StorageArea;

  constructor(area: StorageArea) {
    this.#area = area;
  }

  async list(): Promise<Address[]> {
    const got = await this.#area.get(WATCHLIST_KEY);
    const raw = got[WATCHLIST_KEY];
    if (!Array.isArray(raw)) return [];
    const out: Address[] = [];
    for (const v of raw) {
      if (typeof v === 'string' && isAddress(v)) out.push(getAddress(v));
    }
    return out;
  }

  /** Most recent first, so the panel leads with what the user just looked at. */
  async add(token: Address): Promise<void> {
    const current = await this.list();
    const next = [getAddress(token), ...current.filter((t) => t !== getAddress(token))].slice(0, MAX_ENTRIES);
    await this.#area.set({ [WATCHLIST_KEY]: next });
  }

  async remove(token: Address): Promise<void> {
    const current = await this.list();
    await this.#area.set({ [WATCHLIST_KEY]: current.filter((t) => t !== getAddress(token)) });
  }

  async clear(): Promise<void> {
    await this.#area.remove(WATCHLIST_KEY);
  }
}
