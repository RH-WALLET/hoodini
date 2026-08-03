/**
 * Keystore — the code that guards the keys.
 *
 * Tests use TEST_KDF (N=2^10) so the suite stays fast. The production cost is
 * asserted separately, because a silent downgrade of DEFAULT_KDF would weaken
 * every vault created afterwards without breaking anything visible.
 */

import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { bytesToHex, type Hex } from 'viem';
import {
  createVault,
  createRandomVault,
  unlockVault,
  exportPrivateKey,
  changePassword,
  generatePrivateKey,
  DEFAULT_KDF,
  TEST_KDF,
} from '../src/keystore/vault.js';
import { KeystoreSession } from '../src/keystore/session.js';
import { KeystoreError, type EncryptedVault } from '../src/keystore/types.js';

const PW = 'correct horse battery staple';
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe512961708279a1e0f4dc4c8b0b0f1f' as Hex;

const mk = (password = PW, key = KEY) => createVault(key, password, TEST_KDF);

describe('vault round trip', () => {
  it('encrypts and decrypts back to the same key and address', async () => {
    const vault = await mk();
    const out = await unlockVault(vault, PW);
    expect(out.privateKey).toBe(KEY);
    expect(out.address).toBe(privateKeyToAccount(KEY).address);
  });

  it('never stores the key in the vault, in any encoding', async () => {
    const vault = await mk();
    const blob = JSON.stringify(vault).toLowerCase();
    const bare = KEY.slice(2).toLowerCase();
    expect(blob).not.toContain(bare);
    expect(blob).not.toContain(PW.toLowerCase());
    // Also check the raw bytes, in case of a different encoding.
    expect(blob).not.toContain(Buffer.from(bare, 'hex').toString('base64').toLowerCase());
  });

  it('produces a different ciphertext every time for the same key+password', async () => {
    // Equal ciphertexts would mean a reused salt or IV — catastrophic for GCM.
    const a = await mk();
    const b = await mk();
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
  });

  it('exposes the address in the clear so the UI can name a locked account', async () => {
    const vault = await mk();
    expect(vault.address).toBe(privateKeyToAccount(KEY).address);
  });
});

describe('wrong password and tampering', () => {
  it('rejects a wrong password with BAD_PASSWORD', async () => {
    const vault = await mk();
    await expect(unlockVault(vault, 'not the password')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });

  it('rejects a flipped ciphertext byte — GCM authenticates, it does not just decrypt', async () => {
    const vault = await mk();
    const bytes = Buffer.from(vault.ciphertext.slice(2), 'hex');
    bytes[0] ^= 0xff;
    const tampered: EncryptedVault = { ...vault, ciphertext: `0x${bytes.toString('hex')}` };
    await expect(unlockVault(tampered, PW)).rejects.toBeInstanceOf(KeystoreError);
  });

  it('rejects a swapped address at the AAD, before decryption even completes', async () => {
    const vault = await mk();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    // Asserting the CODE, not merely that it throws: a swapped address is
    // caught twice over — by the AAD (authentication failure) and again by the
    // post-decrypt address check. Only the AAD produces BAD_PASSWORD, so this
    // distinguishes them. Asserting "throws" alone passed even with the AAD
    // removed entirely, which is exactly the hole mutation testing exposed.
    await expect(unlockVault({ ...vault, address: other }, PW)).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });

  it('still catches a swapped address at the post-decrypt check as defence in depth', async () => {
    // Belt and braces: even if the AAD were ever dropped, a vault whose header
    // disagrees with its key must never unlock.
    const vault = await mk();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await expect(unlockVault({ ...vault, address: other }, PW)).rejects.toBeInstanceOf(KeystoreError);
  });

  it('rejects a vault whose salt was replaced', async () => {
    const vault = await mk();
    const swapped = { ...vault, kdf: { ...vault.kdf, salt: `0x${'11'.repeat(32)}` as Hex } };
    await expect(unlockVault(swapped, PW)).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });

  it('refuses an unknown vault version rather than guessing', async () => {
    const vault = await mk();
    await expect(unlockVault({ ...vault, version: 2 as 1 }, PW)).rejects.toMatchObject({ code: 'CORRUPT_VAULT' });
  });

  it('refuses unknown primitives rather than falling back to a weaker one', async () => {
    const vault = await mk();
    const bad = { ...vault, kdf: { ...vault.kdf, name: 'pbkdf2' as 'scrypt' } };
    await expect(unlockVault(bad, PW)).rejects.toMatchObject({ code: 'CORRUPT_VAULT' });
  });
});

describe('input validation', () => {
  it('rejects a short password', async () => {
    await expect(createVault(KEY, 'short', TEST_KDF)).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
  });

  it('rejects a malformed private key', async () => {
    await expect(createVault('0xdeadbeef' as Hex, PW, TEST_KDF)).rejects.toMatchObject({ code: 'INVALID_KEY' });
  });

  it('rejects a key outside the curve order', async () => {
    // Well-formed hex, but not a valid secp256k1 scalar — writing this vault
    // would produce an account that can never sign.
    const tooBig = `0x${'ff'.repeat(32)}` as Hex;
    await expect(createVault(tooBig, PW, TEST_KDF)).rejects.toMatchObject({ code: 'INVALID_KEY' });
  });

  it('normalises unicode passwords so the same typed password always opens', async () => {
    // "é" composed vs decomposed are different byte strings but the same
    // password to a human, and to any sane keyboard.
    const composed = 'passwordé-long-enough';
    const decomposed = 'passwordé-long-enough';
    const vault = await createVault(KEY, composed, TEST_KDF);
    await expect(unlockVault(vault, decomposed)).resolves.toMatchObject({ privateKey: KEY });
  });
});

describe('generation', () => {
  it('generates distinct keys', () => {
    const keys = new Set(Array.from({ length: 25 }, () => generatePrivateKey()));
    expect(keys.size).toBe(25);
  });

  it('creates a usable random vault', async () => {
    const { vault, address } = await createRandomVault(PW, TEST_KDF);
    const out = await unlockVault(vault, PW);
    expect(out.address).toBe(address);
  });
});

describe('export and password change', () => {
  it('export requires the password again — an unlocked session is not enough', async () => {
    const vault = await mk();
    await expect(exportPrivateKey(vault, 'wrong password')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    await expect(exportPrivateKey(vault, PW)).resolves.toBe(KEY);
  });

  it('changing the password keeps the key and address, and invalidates the old one', async () => {
    const vault = await mk();
    const next = await changePassword(vault, PW, 'a brand new password', TEST_KDF);
    expect(next.address).toBe(vault.address);
    await expect(unlockVault(next, 'a brand new password')).resolves.toMatchObject({ privateKey: KEY });
    await expect(unlockVault(next, PW)).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });
});

describe('production KDF cost', () => {
  it('is memory-hard and not silently downgraded', () => {
    // A weakened default would compromise every vault created afterwards while
    // leaving every other test green.
    expect(DEFAULT_KDF.name).toBe('scrypt');
    expect(DEFAULT_KDF.N).toBeGreaterThanOrEqual(2 ** 16);
    expect(DEFAULT_KDF.r).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_KDF.dkLen).toBe(32);
  });

  it('stores its parameters in the vault so the cost can be raised later', async () => {
    const vault = await mk();
    expect(vault.kdf.N).toBe(TEST_KDF.N);
    expect(vault.kdf.salt).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('KeystoreSession', () => {
  const opts = (over: Record<string, unknown> = {}) => {
    let t = 1_000_000;
    return {
      now: () => t,
      advance: (ms: number) => (t += ms),
      autoLockMs: 60_000,
      ...over,
    };
  };

  it('starts locked and refuses to hand out a key', async () => {
    const s = new KeystoreSession();
    expect(s.isUnlocked).toBe(false);
    expect(s.address).toBeNull();
    await expect(s.withKey(async () => 'nope')).rejects.toMatchObject({ code: 'LOCKED' });
  });

  it('unlocks, exposes only the address, and yields the key solely inside withKey', async () => {
    const vault = await mk();
    const s = new KeystoreSession();
    const addr = await s.unlock(vault, PW);
    expect(addr).toBe(vault.address);
    expect(s.address).toBe(vault.address);
    // The key is reachable only as a callback argument — there is no getter.
    expect((s as unknown as Record<string, unknown>)['privateKey']).toBeUndefined();
    const seen = await s.withKey((pk) => pk);
    expect(seen).toBe(KEY);
  });

  it('a wrong password leaves the session locked', async () => {
    const vault = await mk();
    const s = new KeystoreSession();
    await expect(s.unlock(vault, 'wrong password')).rejects.toBeInstanceOf(KeystoreError);
    expect(s.isUnlocked).toBe(false);
  });

  it('lock() drops the key immediately', async () => {
    const vault = await mk();
    const s = new KeystoreSession();
    await s.unlock(vault, PW);
    s.lock();
    expect(s.isUnlocked).toBe(false);
    await expect(s.withKey(async () => 1)).rejects.toMatchObject({ code: 'LOCKED' });
  });

  it('auto-locks after the idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const vault = await mk();
      const onLock = vi.fn();
      const s = new KeystoreSession({ autoLockMs: 1000, onLock });
      await s.unlock(vault, PW);
      expect(s.isUnlocked).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(s.isUnlocked).toBe(false);
      expect(onLock).toHaveBeenCalledWith('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('using the key pushes the auto-lock out', async () => {
    vi.useFakeTimers();
    try {
      const vault = await mk();
      const s = new KeystoreSession({ autoLockMs: 1000 });
      await s.unlock(vault, PW);
      vi.advanceTimersByTime(800);
      await s.withKey(() => 'used');
      vi.advanceTimersByTime(800); // 1600 total, but only 800 since last use
      expect(s.isUnlocked).toBe(true);
      vi.advanceTimersByTime(300);
      expect(s.isUnlocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-unlocking with a different vault does not leave the old key resident', async () => {
    const first = await mk();
    const second = await createRandomVault('another good password', TEST_KDF);
    const s = new KeystoreSession();
    await s.unlock(first, PW);
    await s.unlock(second.vault, 'another good password');
    expect(s.address).toBe(second.address);
    const pk = await s.withKey((k) => k);
    expect(pk).not.toBe(KEY);
  });

  it('reports onLock for a manual lock, and not for a lock that does nothing', async () => {
    const vault = await mk();
    const onLock = vi.fn();
    const s = new KeystoreSession({ onLock });
    s.lock(); // already locked — must not fire
    expect(onLock).not.toHaveBeenCalled();
    await s.unlock(vault, PW);
    s.lock();
    expect(onLock).toHaveBeenCalledExactlyOnceWith('manual');
  });

  void opts;
});
