/**
 * Keystore types.
 *
 * CLAUDE.md invariant 1: private keys are generated client-side, encrypted at
 * rest with AES-GCM under a scrypt-derived key, stored only in
 * chrome.storage.local, decrypted only into service-worker memory, and
 * auto-locked on a timer. Keys never leave the device. Ever.
 */

import type { Address, Hex } from 'viem';

/** scrypt parameters. Stored WITH the vault so they can be raised later
 *  without stranding vaults created under the old cost. */
export interface KdfParams {
  readonly name: 'scrypt';
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly dkLen: number;
  /** Per-vault random salt. */
  readonly salt: Hex;
}

/**
 * What lands in chrome.storage.local. Contains no secret: without the password
 * it is an opaque blob, and it is useless if copied to another machine.
 *
 * `address` is deliberately plaintext so the UI can name the account while
 * locked. That is a local-only disclosure — it is never transmitted (invariant
 * 2), and anyone who can read this storage can already read the ciphertext.
 */
export interface EncryptedVault {
  readonly version: 1;
  readonly kdf: KdfParams;
  readonly cipher: { readonly name: 'AES-GCM'; readonly iv: Hex };
  readonly ciphertext: Hex;
  readonly address: Address;
  readonly createdAt: string;
}

/**
 * Every wallet this installation holds, and which one is in use.
 *
 * One password protects the set. Each vault is separately encrypted, but with a
 * key derived from the same password, so unlocking decrypts all of them at once
 * and switching accounts costs nothing — asking for a password to change
 * account would make multi-wallet unusable for the thing it is for, which is
 * moving between wallets quickly (D-070).
 */
export interface VaultSet {
  readonly version: 2;
  readonly vaults: readonly EncryptedVault[];
  /** Always a valid index into `vaults`. Normalised on read. */
  readonly activeIndex: number;
  /** Optional user labels, by index. Absent entries fall back to the address. */
  readonly labels?: Readonly<Record<number, string>>;
}

/** An unlocked account. The private key exists only inside this object. */
export interface UnlockedAccount {
  readonly address: Address;
  readonly privateKey: Hex;
}

export class KeystoreError extends Error {
  constructor(
    message: string,
    readonly code: 'BAD_PASSWORD' | 'CORRUPT_VAULT' | 'LOCKED' | 'INVALID_KEY' | 'WEAK_PASSWORD' | 'NO_VAULT' | 'NOT_FOUND',
  ) {
    super(message);
    this.name = 'KeystoreError';
  }
}
