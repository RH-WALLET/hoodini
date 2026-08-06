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
import { KeystoreError, type EncryptedVault, type UnlockedAccount } from './types.js';
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
  /**
   * Every account this session unlocked, in vault order.
   *
   * All of them, not just the one in use: one password protects the set, so
   * decrypting the rest costs nothing extra and switching account then needs no
   * password. The alternative — decrypt on demand — would ask for the password
   * every time somebody changed wallet, which defeats the feature (D-070).
   */
  #accounts: UnlockedAccount[] = [];
  #active = 0;
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
    return this.#accounts.length > 0;
  }

  /**
   * Address of the account in use, or null. Never reveals the key.
   *
   * Deliberately still singular. Twenty-one call sites ask this question to
   * decide who is about to sign, and every one of them means "the active
   * account" — so multi-wallet changes what the answer is, not what the
   * question is.
   */
  get address(): Address | null {
    return this.#accounts[this.#active]?.address ?? null;
  }

  /** Every unlocked address, in vault order. Addresses only; never keys. */
  get addresses(): readonly Address[] {
    return this.#accounts.map((a) => a.address);
  }

  get activeIndex(): number {
    return this.#active;
  }

  get unlockedAt(): number | null {
    return this.isUnlocked ? this.#unlockedAt : null;
  }

  /**
   * Choose which account signs.
   *
   * No password: the set was already unlocked with one, and every key here is
   * already resident. Refuses an index that does not exist rather than falling
   * back to zero — silently signing from a different wallet than the one asked
   * for is the worst outcome available here.
   */
  select(index: number): Address {
    if (!this.isUnlocked) throw new KeystoreError('keystore is locked', 'LOCKED');
    const account = this.#accounts[index];
    if (!account) throw new KeystoreError('no such account', 'NOT_FOUND');
    this.#active = index;
    this.#arm();
    return account.address;
  }

  /**
   * Unlock every vault in the set with one password.
   *
   * A vault that will not decrypt fails the whole unlock rather than being
   * skipped: a set where one wallet silently vanished would have the user
   * trading from a different account than the one they think they picked.
   */
  async unlock(vaults: EncryptedVault | readonly EncryptedVault[], password: string, active = 0): Promise<Address> {
    const list = Array.isArray(vaults) ? vaults : [vaults as EncryptedVault];
    const accounts: UnlockedAccount[] = [];
    for (const vault of list) accounts.push(await unlockVault(vault, password));
    if (accounts.length === 0) throw new KeystoreError('no wallet to unlock', 'NO_VAULT');

    // Replacing an existing session must not leave the previous keys resident.
    this.#clear();
    this.#accounts = accounts;
    this.#active = active >= 0 && active < accounts.length ? active : 0;
    this.#unlockedAt = this.#now();
    this.#arm();
    return this.#accounts[this.#active]!.address;
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
    const account = this.#accounts[this.#active];
    if (!account) throw new KeystoreError('keystore is locked', 'LOCKED');
    this.#arm();
    return await fn(account.privateKey, account.address);
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
    // Strings are immutable in JS, so the old values cannot be overwritten in
    // place; dropping the references is the most that can be done. This is why
    // the auto-lock window matters — it bounds how long the engine may keep
    // them, and with a set it bounds that for every wallet at once.
    this.#accounts = [];
    this.#active = 0;
    this.#unlockedAt = 0;
  }
}
