/**
 * KeystoreSession — the only place an unlocked key lives.
 *
 * Holds a decrypted key in memory, hands it out solely through a callback that
 * cannot outlive the call, and locks on an idle timer. The key is never
 * returned to a caller directly: `withKey` bounds the window in which it is
 * reachable, so no caller can stash a reference and keep it alive past a lock.
 *
 * In MV3 the service worker is torn down at the browser's discretion, which
 * silently drops this state. That is the desired behaviour — unlocked state
 * must always be reconstructible from a password and never assumed.
 */

import type { Address, Hex } from 'viem';
import { KeystoreError, type EncryptedVault } from './types.js';
import { unlockVault } from './vault.js';

/**
 * Default idle timeout.
 *
 * 25 minutes, set by Rory. Long enough to work a session of a terminal without
 * the password becoming background noise you type without reading, short enough
 * that a walked-away-from laptop does not stay able to sign indefinitely.
 *
 * The timer is idle-based, so it is 25 minutes of *nothing happening* rather
 * than 25 minutes from unlocking.
 */
export const DEFAULT_AUTO_LOCK_MS = 25 * 60 * 1000;

export interface SessionOptions {
  readonly autoLockMs?: number;
  readonly now?: () => number;
  /** Injected so tests need no real timers. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Called whenever the session locks, for any reason. */
  readonly onLock?: (reason: 'manual' | 'timeout') => void;
}

export class KeystoreSession {
  #privateKey: Hex | null = null;
  #address: Address | null = null;
  #handle: unknown = null;
  #unlockedAt = 0;

  readonly #autoLockMs: number;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #onLock: ((reason: 'manual' | 'timeout') => void) | undefined;

  constructor(options: SessionOptions = {}) {
    this.#autoLockMs = options.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#onLock = options.onLock;
  }

  get isUnlocked(): boolean {
    return this.#privateKey !== null;
  }

  /** Address of the unlocked account, or null. Never reveals the key. */
  get address(): Address | null {
    return this.#address;
  }

  get unlockedAt(): number | null {
    return this.#privateKey ? this.#unlockedAt : null;
  }

  async unlock(vault: EncryptedVault, password: string): Promise<Address> {
    const account = await unlockVault(vault, password);
    // Replacing an existing session must not leave the previous key resident.
    this.#clear();
    this.#privateKey = account.privateKey;
    this.#address = account.address;
    this.#unlockedAt = this.#now();
    this.#arm();
    return account.address;
  }

  lock(): void {
    const wasUnlocked = this.isUnlocked;
    this.#clear();
    if (wasUnlocked) this.#onLock?.('manual');
  }

  /**
   * Run `fn` with the private key. The key is passed as an argument and never
   * returned, so it cannot escape except by a caller deliberately copying it —
   * which makes any such copy visible in review.
   *
   * Using the key counts as activity and pushes the auto-lock timer out.
   */
  async withKey<T>(fn: (privateKey: Hex, address: Address) => Promise<T> | T): Promise<T> {
    if (!this.#privateKey || !this.#address) {
      throw new KeystoreError('keystore is locked', 'LOCKED');
    }
    this.#arm();
    return await fn(this.#privateKey, this.#address);
  }

  /** Extend the idle window — call on user interaction, not on background polling. */
  touch(): void {
    if (this.isUnlocked) this.#arm();
  }

  #arm(): void {
    if (this.#handle !== null) this.#clearTimer(this.#handle);
    this.#handle = this.#setTimer(() => {
      const wasUnlocked = this.isUnlocked;
      this.#clear();
      if (wasUnlocked) this.#onLock?.('timeout');
    }, this.#autoLockMs);
  }

  #clear(): void {
    if (this.#handle !== null) {
      this.#clearTimer(this.#handle);
      this.#handle = null;
    }
    // Strings are immutable in JS, so the old value cannot be overwritten in
    // place; dropping the reference is the most that can be done. This is why
    // the auto-lock window matters — it bounds how long the engine may keep it.
    this.#privateKey = null;
    this.#address = null;
    this.#unlockedAt = 0;
  }
}
