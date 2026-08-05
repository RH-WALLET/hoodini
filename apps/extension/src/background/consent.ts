/**
 * Standing consent: approving buys without a sheet, until disarmed.
 *
 * D-054 made every trade meet a human. This deliberately weakens that, at
 * Rory's explicit and repeated instruction: no amount cap, no expiry, armed
 * until switched off. What follows is the reasoning for the bounds that *do*
 * remain, so that a later reader can tell which were chosen and which were
 * merely inherited.
 *
 * ## The thing to understand before reading further
 *
 * **The amount comes from the page, not from the presets.** The content script
 * runs in the site's world, so `trade.request` carries whatever number that
 * world sends. The preset buttons draw `0.01`, but a hostile or compromised
 * matched site is not limited to what the buttons say. While every trade meets
 * a human that is harmless — the worst it achieves is a prompt nobody asked for
 * (D-026). With standing consent armed and no cap, the ceiling on a single
 * auto-approved buy is the wallet balance.
 *
 * That was raised, twice, and the instruction was unchanged. It is recorded
 * here rather than argued again.
 *
 * ## What still holds, and why each one is not a cap
 *
 * - **A locked wallet still signs nothing.** Consent is not a key. This is not
 *   a policy choice; there is simply nothing to sign with.
 * - **Buys only.** A sell is the whole balance (D-049), so it is not a bounded
 *   amount and nothing about "no cap" can describe it. A sell keeps its sheet.
 * - **The first live broadcast is always manual.** CLAUDE.md invariant 5 says
 *   the first live test is a canary explicitly approved in-session. An
 *   invariant marked permanent is not something a session preference edits, so
 *   auto-approval refuses until a live send has happened once by hand.
 * - **Memory only, never storage.** Arming does not survive the worker being
 *   killed, the browser restarting, or the wallet locking. MV3 evicts the
 *   worker constantly, so in practice this re-arms often; that is the intended
 *   cost of "until I disarm" meaning "until I disarm *this session*".
 *
 * Nothing here consults an amount, a clock, or an origin.
 */

import type { StorageArea } from './storage.js';
import type { TradeRequest } from './pending.js';

/**
 * Records that a live broadcast has happened at least once.
 *
 * Persisted, unlike the arming itself: invariant 5 is about the first live
 * trade ever, not the first one this session, so forgetting it on restart
 * would demand a fresh canary every morning and train the habit of clicking
 * through the very confirmation it exists to force.
 */
export const FIRST_LIVE_KEY = 'hoodini.firstlive.v1';

/**
 * Whether unlocking should arm standing consent by itself.
 *
 * Defaults to **on**, at Rory's instruction: auto-approval should be automatic
 * rather than something armed by hand each session. The password is therefore
 * the authorisation, and it lasts as long as the session does.
 *
 * Deliberately **not** part of `Settings`. `settings.get` is page-readable
 * (D-053), so a preference living there would tell any matched site whether
 * this wallet approves without asking — which is precisely the fact a hostile
 * page would want before deciding how much to propose. Kept here, it is only
 * reachable through `consent.status`, which is popup-only.
 */
export const AUTO_ARM_KEY = 'hoodini.autoarm.v1';

export interface ConsentState {
  readonly armed: boolean;
  /** When it was armed, for showing "armed 4 minutes ago" rather than a bare flag. */
  readonly armedAt: number | null;
  /** False until a live send has happened by hand, whatever the arming says. */
  readonly liveUnlocked: boolean;
  /** Whether unlocking arms it automatically. Persisted; defaults to on. */
  readonly autoArm: boolean;
}

export class StandingConsent {
  #armedAt: number | null = null;

  readonly #area: StorageArea;
  readonly #now: () => number;
  /** Build-time truth, injected so tests can exercise both sides of it. */
  readonly #liveTrading: boolean;

  constructor(area: StorageArea, options: { now?: () => number; liveTrading?: boolean } = {}) {
    this.#area = area;
    this.#now = options.now ?? (() => Date.now());
    this.#liveTrading = options.liveTrading ?? false;
  }

  arm(): void {
    this.#armedAt = this.#now();
  }

  disarm(): void {
    this.#armedAt = null;
  }

  /**
   * Should unlocking arm this?
   *
   * Absent means yes. A wallet that has never been told otherwise auto-approves,
   * which is the instructed default; only an explicit disarm turns it off, and
   * that choice persists.
   */
  async autoArmEnabled(): Promise<boolean> {
    const got = await this.#area.get(AUTO_ARM_KEY);
    return got[AUTO_ARM_KEY] !== false;
  }

  async setAutoArm(on: boolean): Promise<void> {
    await this.#area.set({ [AUTO_ARM_KEY]: on });
  }

  /**
   * Arm because the wallet was just unlocked, if the preference allows it.
   *
   * Returns whether it armed, so the caller can repaint the badge without
   * asking again.
   */
  async armOnUnlock(): Promise<boolean> {
    if (!(await this.autoArmEnabled())) return false;
    this.arm();
    return true;
  }

  get armed(): boolean {
    return this.#armedAt !== null;
  }

  /** Note that a live broadcast has happened, satisfying invariant 5 from here on. */
  async recordLiveSend(): Promise<void> {
    await this.#area.set({ [FIRST_LIVE_KEY]: true });
  }

  async #liveUnlocked(): Promise<boolean> {
    // In a dry-run build nothing can broadcast, so there is no canary to gate:
    // the whole point of arming in that build is to exercise this path safely.
    if (!this.#liveTrading) return true;
    const got = await this.#area.get(FIRST_LIVE_KEY);
    return got[FIRST_LIVE_KEY] === true;
  }

  async state(): Promise<ConsentState> {
    return {
      armed: this.armed,
      armedAt: this.#armedAt,
      liveUnlocked: await this.#liveUnlocked(),
      autoArm: await this.autoArmEnabled(),
    };
  }

  /**
   * May this proposal skip the confirmation sheet?
   *
   * `unlocked` is passed in rather than read here: whether a wallet is unlocked
   * belongs to the keystore session, and a consent object that could reach into
   * it would be a consent object that could be asked the wrong question.
   *
   * Deliberately consults no amount and no clock. Answering `false` costs the
   * user a sheet; answering `true` spends their money, so every branch that is
   * not a clear yes returns false.
   */
  async permits(request: TradeRequest, unlocked: boolean): Promise<boolean> {
    if (!this.armed) return false;
    if (!unlocked) return false;
    // A sell is the whole balance, which no notion of "bounded" can describe.
    if (request.side !== 'buy') return false;
    // An amount is still required to be present and well formed; that is a
    // validity check, not a limit on how large it may be.
    if (request.amount === undefined) return false;
    return await this.#liveUnlocked();
  }
}
