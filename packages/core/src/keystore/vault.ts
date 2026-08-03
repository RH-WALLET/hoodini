/**
 * Vault — encrypt and decrypt a private key at rest.
 *
 * AES-256-GCM under a scrypt-derived key. scrypt over PBKDF2 because it is
 * memory-hard: an attacker who steals a browser profile is throttled by RAM
 * rather than only by hash rate. AES-GCM because it is authenticated — a
 * tampered vault must fail to decrypt rather than yield garbage that then gets
 * signed with.
 *
 * This module never touches storage and never holds state. It converts
 * (password, key) <-> vault and nothing else, which keeps the part that has to
 * be right small enough to audit in one sitting.
 */

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { privateKeyToAccount } from 'viem/accounts';
import { bytesToHex, hexToBytes, isHex, type Address, type Hex } from 'viem';
import { KeystoreError, type EncryptedVault, type KdfParams, type UnlockedAccount } from './types.js';

/**
 * scrypt cost. N=2^17, r=8, p=1 needs ~134 MB and roughly a second on a modern
 * laptop — deliberately slow, since this runs once per unlock but must be run
 * per guess by an attacker.
 *
 * Raising these later is safe: every vault carries the parameters it was
 * created with, so old vaults keep opening while new ones get the higher cost.
 */
export const DEFAULT_KDF: Omit<KdfParams, 'salt'> = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1, dkLen: 32 };

/** Lower cost, for tests only. Never use this for a real vault. */
export const TEST_KDF: Omit<KdfParams, 'salt'> = { name: 'scrypt', N: 2 ** 10, r: 8, p: 1, dkLen: 32 };

const MIN_PASSWORD_LENGTH = 8;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * Best-effort scrub. JavaScript cannot guarantee erasure — the engine may have
 * copied the buffer — but overwriting shortens the window in which a heap
 * snapshot yields a usable key, and costs nothing.
 */
export function wipe(buf: Uint8Array): void {
  buf.fill(0);
}

/**
 * Copy into a plain ArrayBuffer for WebCrypto.
 *
 * Beyond satisfying `BufferSource`, this hands SubtleCrypto a buffer that no
 * other code holds a view onto, so a later `wipe()` cannot race an in-flight
 * crypto operation.
 */
function buf(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

async function deriveKey(password: string, kdf: KdfParams): Promise<Uint8Array> {
  const pw = new TextEncoder().encode(password.normalize('NFKC'));
  try {
    // scryptAsync yields to the event loop; the sync variant would stall the
    // service worker for the whole derivation.
    return await scryptAsync(pw, hexToBytes(kdf.salt), {
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      dkLen: kdf.dkLen,
    });
  } finally {
    wipe(pw);
  }
}

/**
 * Bind the ciphertext to the vault's public header. Swapping the address or
 * version of an existing vault then fails authentication instead of silently
 * decrypting under a different identity.
 */
function aad(version: number, address: Address): Uint8Array {
  return new TextEncoder().encode(`hoodini-keystore-v${version}:${address.toLowerCase()}`);
}

function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new KeystoreError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`, 'WEAK_PASSWORD');
  }
}

function assertPrivateKey(privateKey: Hex): void {
  if (!isHex(privateKey) || privateKey.length !== 66) {
    throw new KeystoreError('private key must be 0x + 64 hex characters', 'INVALID_KEY');
  }
}

/** Generate a fresh key in-process. Never derived from anything off-device. */
export function generatePrivateKey(): Hex {
  const bytes = randomBytes(32);
  try {
    // secp256k1 requires 0 < k < n. A zero key is invalid and, at 2^-256, so
    // improbable that rejecting is simpler than looping.
    if (bytes.every((b) => b === 0)) throw new KeystoreError('generated a zero key', 'INVALID_KEY');
    return bytesToHex(bytes);
  } finally {
    wipe(bytes);
  }
}

/** Encrypt a private key into a storable vault. */
export async function createVault(
  privateKey: Hex,
  password: string,
  kdfParams: Omit<KdfParams, 'salt'> = DEFAULT_KDF,
  now: () => number = () => Date.now(),
): Promise<EncryptedVault> {
  assertPasswordAcceptable(password);
  assertPrivateKey(privateKey);

  // Throws on a key outside the curve order, so an unusable vault can never be
  // written in the first place.
  let address: Address;
  try {
    address = privateKeyToAccount(privateKey).address;
  } catch {
    throw new KeystoreError('private key is not a valid secp256k1 key', 'INVALID_KEY');
  }

  const kdf: KdfParams = { ...kdfParams, salt: bytesToHex(randomBytes(32)) };
  const iv = randomBytes(12); // 96-bit nonce, the size AES-GCM is specified for
  const dk = await deriveKey(password, kdf);

  try {
    const aesKey = await crypto.subtle.importKey('raw', buf(dk), 'AES-GCM', false, ['encrypt']);
    const plaintext = hexToBytes(privateKey);
    try {
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad(1, address)) },
        aesKey,
        buf(plaintext),
      );
      return {
        version: 1,
        kdf,
        cipher: { name: 'AES-GCM', iv: bytesToHex(iv) },
        ciphertext: bytesToHex(new Uint8Array(ct)),
        address,
        createdAt: new Date(now()).toISOString(),
      };
    } finally {
      wipe(plaintext);
    }
  } finally {
    wipe(dk);
  }
}

/** Generate a key and wrap it in one step — the "create wallet" path. */
export async function createRandomVault(
  password: string,
  kdfParams: Omit<KdfParams, 'salt'> = DEFAULT_KDF,
  now?: () => number,
): Promise<{ vault: EncryptedVault; address: Address }> {
  const privateKey = generatePrivateKey();
  const vault = await createVault(privateKey, password, kdfParams, now);
  return { vault, address: vault.address };
}

/**
 * Decrypt a vault. A wrong password is indistinguishable from a tampered
 * vault at the crypto layer — both surface as a GCM authentication failure —
 * so BAD_PASSWORD is reported for the common case rather than leaking which
 * one it was.
 */
export async function unlockVault(vault: EncryptedVault, password: string): Promise<UnlockedAccount> {
  if (vault.version !== 1) throw new KeystoreError(`unsupported vault version ${vault.version}`, 'CORRUPT_VAULT');
  if (vault.kdf?.name !== 'scrypt' || vault.cipher?.name !== 'AES-GCM') {
    throw new KeystoreError('vault uses unknown primitives', 'CORRUPT_VAULT');
  }
  if (!isHex(vault.ciphertext) || !isHex(vault.cipher.iv) || !isHex(vault.kdf.salt)) {
    throw new KeystoreError('vault fields are malformed', 'CORRUPT_VAULT');
  }

  const dk = await deriveKey(password, vault.kdf);
  try {
    const aesKey = await crypto.subtle.importKey('raw', buf(dk), 'AES-GCM', false, ['decrypt']);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buf(hexToBytes(vault.cipher.iv)),
          additionalData: buf(aad(vault.version, vault.address)),
        },
        aesKey,
        buf(hexToBytes(vault.ciphertext)),
      );
    } catch {
      throw new KeystoreError('incorrect password, or the vault has been altered', 'BAD_PASSWORD');
    }

    const bytes = new Uint8Array(plain);
    try {
      if (bytes.length !== 32) throw new KeystoreError('decrypted payload is not a 32-byte key', 'CORRUPT_VAULT');
      const privateKey = bytesToHex(bytes);
      const derived = privateKeyToAccount(privateKey).address;
      // The AAD already binds the address, so a mismatch means the vault was
      // built inconsistently rather than tampered with. Refuse either way.
      if (derived.toLowerCase() !== vault.address.toLowerCase()) {
        throw new KeystoreError('vault address does not match its key', 'CORRUPT_VAULT');
      }
      return { address: derived, privateKey };
    } finally {
      wipe(bytes);
    }
  } finally {
    wipe(dk);
  }
}

/**
 * Export the raw key. Identical to unlocking, but named separately so that
 * every call site — and every audit — can see when a key is about to be shown
 * to a human. Callers must require password re-entry and an explicit
 * confirmation; this function deliberately takes the password again rather
 * than reusing an unlocked session.
 */
export async function exportPrivateKey(vault: EncryptedVault, password: string): Promise<Hex> {
  const { privateKey } = await unlockVault(vault, password);
  return privateKey;
}

/** Re-encrypt under a new password without changing the key or the address. */
export async function changePassword(
  vault: EncryptedVault,
  currentPassword: string,
  newPassword: string,
  kdfParams: Omit<KdfParams, 'salt'> = DEFAULT_KDF,
): Promise<EncryptedVault> {
  const { privateKey } = await unlockVault(vault, currentPassword);
  return createVault(privateKey, newPassword, kdfParams);
}
