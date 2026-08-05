/**
 * Settings persistence.
 *
 * `chrome.storage.local`, never `sync` — for the same reason the vault is local
 * (invariant 1). These are not secrets, but syncing them would push a record of
 * how the user trades to Google's servers, and this extension has no business
 * putting anything of the user's anywhere.
 *
 * Reads are total: anything unreadable, half-written, or hand-edited normalises
 * to usable defaults rather than throwing. A settings read failing would break
 * the overlay for a reason the user could never diagnose.
 */

import { DEFAULT_SETTINGS, normaliseSettings, type Settings } from '@hoodini/core';
import type { StorageArea } from './storage.js';

export const SETTINGS_KEY = 'hoodini.settings.v1';

export class SettingsStore {
  readonly #area: StorageArea;

  constructor(area: StorageArea) {
    this.#area = area;
  }

  async read(): Promise<Settings> {
    try {
      const got = await this.#area.get(SETTINGS_KEY);
      return normaliseSettings(got[SETTINGS_KEY]);
    } catch {
      // Storage being unavailable is not a reason to have no buttons.
      return DEFAULT_SETTINGS;
    }
  }

  /**
   * Writes normalised values, never the caller's object.
   *
   * The router validates first and rejects a bad edit with a reason; this is
   * the second line — whatever reaches storage is something the reader would
   * have accepted anyway, so a future write path cannot poison it.
   */
  async write(settings: unknown): Promise<Settings> {
    const clean = normaliseSettings(settings);
    await this.#area.set({ [SETTINGS_KEY]: clean });
    return clean;
  }
}
