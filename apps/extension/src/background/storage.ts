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

import type { EncryptedVault, VaultSet } from '@hoodini/core';

export const VAULT_KEY = 'hoodini.vault.v1';

/**
 * Every wallet, since D-070. The single-vault key above is still read, so an
 * installation that predates multi-wallet opens normally as a set of one.
 */
export const VAULT_SET_KEY = 'hoodini.vaults.v2';

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

  /** One vault, shape-checked. Anything malformed reads as absent. */
  #valid(raw: unknown): EncryptedVault | null {
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

  /**
   * Every wallet, and which is active.
   *
   * Reads the single-vault record this extension shipped with as a set of one,
   * rather than migrating storage on read. Nothing is rewritten until the user
   * does something that writes anyway, so a downgrade or a half-finished
   * upgrade cannot leave somebody unable to open a wallet that still exists
   * (D-070).
   */
  async readSet(): Promise<VaultSet | null> {
    const got = await this.#area.get([VAULT_SET_KEY, VAULT_KEY]);

    const raw = got[VAULT_SET_KEY] as Partial<VaultSet> | undefined;
    if (raw && Array.isArray(raw.vaults)) {
      const vaults = raw.vaults.map((v) => this.#valid(v)).filter((v): v is EncryptedVault => v !== null);
      if (vaults.length === 0) return null;
      const wanted = raw.activeIndex;
      const activeIndex =
        typeof wanted === 'number' && Number.isInteger(wanted) && wanted >= 0 && wanted < vaults.length ? wanted : 0;
      return { version: 2, vaults, activeIndex, ...(raw.labels ? { labels: raw.labels } : {}) };
    }

    const single = this.#valid(got[VAULT_KEY]);
    return single ? { version: 2, vaults: [single], activeIndex: 0 } : null;
  }

  async writeSet(set: VaultSet): Promise<void> {
    await this.#area.set({ [VAULT_SET_KEY]: set });
    // The old single-vault key is left where it is. It costs a few hundred
    // bytes and it is the only way back if a release has to be rolled back.
  }

  /** The active vault, for the paths that only ever meant one (export, reset). */
  async read(): Promise<EncryptedVault | null> {
    const set = await this.readSet();
    return set?.vaults[set.activeIndex] ?? null;
  }

  async write(vault: EncryptedVault): Promise<void> {
    await this.writeSet({ version: 2, vaults: [vault], activeIndex: 0 });
  }

  async clear(): Promise<void> {
    await this.#area.remove([VAULT_SET_KEY, VAULT_KEY]);
  }

  async exists(): Promise<boolean> {
    return (await this.readSet()) !== null;
  }
}

/** The real storage area. Referenced in exactly one place, on purpose. */
export function chromeLocalArea(): StorageArea {
  return chrome.storage.local as unknown as StorageArea;
}
