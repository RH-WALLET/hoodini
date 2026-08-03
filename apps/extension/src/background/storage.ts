/**
 * Vault persistence.
 *
 * The ONLY place the extension writes a vault. `chrome.storage.local` and never
 * `sync`: syncing would push the encrypted vault to Google's servers, which
 * breaks "keys never leave the device" even though the blob is encrypted
 * (CLAUDE.md invariant 1).
 *
 * The storage area is injected so this is testable without a browser, and so
 * the single call site that touches real storage is obvious.
 */

import type { EncryptedVault } from '@hoodini/core';

export const VAULT_KEY = 'hoodini.vault.v1';

/** The slice of chrome.storage.local this module needs. */
export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class VaultStore {
  readonly #area: StorageArea;

  constructor(area: StorageArea) {
    this.#area = area;
  }

  async read(): Promise<EncryptedVault | null> {
    const got = await this.#area.get(VAULT_KEY);
    const raw = got[VAULT_KEY];
    if (!raw || typeof raw !== 'object') return null;
    const vault = raw as EncryptedVault;
    // Shape-check before handing it to the crypto layer: a truncated or
    // half-written record should read as "no vault" rather than surfacing as a
    // decryption failure the user would read as a wrong password.
    if (vault.version !== 1 || !vault.ciphertext || !vault.kdf?.salt || !vault.cipher?.iv || !vault.address) {
      return null;
    }
    return vault;
  }

  async write(vault: EncryptedVault): Promise<void> {
    await this.#area.set({ [VAULT_KEY]: vault });
  }

  async clear(): Promise<void> {
    await this.#area.remove(VAULT_KEY);
  }

  async exists(): Promise<boolean> {
    return (await this.read()) !== null;
  }
}

/** The real storage area. Referenced in exactly one place, on purpose. */
export function chromeLocalArea(): StorageArea {
  return chrome.storage.local as unknown as StorageArea;
}
