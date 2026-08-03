/**
 * Trade engine — the ONLY place in Hoodini that can broadcast a transaction.
 *
 * Everything upstream of this file produces unsigned calldata. Signing and
 * sending happen here, behind the `LIVE_TRADING` gate, which is checked at the
 * last possible moment before `eth_sendRawTransaction` — not at construction,
 * not at plan time (CLAUDE.md invariant 5, D-004). Anything that happens between
 * an earlier check and the send could invalidate it, so the only check that
 * counts is the one on the same call.
 */

import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, PublicClient, TransactionReceipt } from 'viem';
import { KeystoreError, totalValueWei, type KeystoreSession, type TradePlan, type TradeStep } from '@hoodini/core';
import type { TradeJournal } from './journal.js';

/**
 * The canary ceiling. Invariant 5 requires the first live trade to be a single
 * transaction of at most 0.005 ETH, explicitly approved in-session.
 */
export const CANARY_MAX_WEI = 5_000_000_000_000_000n;

/** Permit2 needs two grants; more than that means something is wrong. */
const MAX_APPROVAL_ROUNDS = 3;

export type ExecutionOutcome =
  | { readonly status: 'simulated'; readonly steps: readonly SimulatedStep[] }
  | { readonly status: 'sent'; readonly receipts: readonly TransactionReceipt[] };

export interface SimulatedStep {
  readonly kind: TradeStep['kind'];
  readonly to: Address;
  readonly value: bigint;
  readonly gas: bigint | null;
  readonly wouldSucceed: boolean;
  readonly revertReason: string | null;
}

export class TradeRefused extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_LIVE' | 'OVER_LIMIT' | 'LOCKED' | 'WRONG_ACCOUNT' | 'STUCK_APPROVALS' | 'IN_FLIGHT',
  ) {
    super(message);
    this.name = 'TradeRefused';
  }
}

export interface EngineDeps {
  readonly client: PublicClient;
  readonly session: KeystoreSession;
  readonly journal: TradeJournal;
  /**
   * Build-time constant in production, so a shipped build cannot be talked into
   * trading by anything at runtime. Injected here purely to be testable.
   */
  readonly liveTrading: boolean;
  /** Hard ceiling on native ETH per plan. Defaults to the canary limit. */
  readonly maxSendWei?: bigint;
  /** Re-ask a venue whether another approval is required. */
  readonly nextApproval?: (plan: TradePlan, owner: Address) => Promise<TradeStep | null>;
  readonly chainId: number;
}

export class TradeEngine {
  readonly #d: EngineDeps;
  /** Serialises every send for this worker so two trades cannot race a nonce. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: EngineDeps) {
    this.#d = deps;
  }

  get maxSendWei(): bigint {
    return this.#d.maxSendWei ?? CANARY_MAX_WEI;
  }

  /**
   * Simulate or execute a plan.
   *
   * When `LIVE_TRADING` is false this still does real work — it eth_calls every
   * step against live state — so a dry run is a genuine rehearsal rather than a
   * no-op that proves nothing.
   */
  async execute(plan: TradePlan): Promise<ExecutionOutcome> {
    const total = totalValueWei(plan);
    // Checked before anything else: an over-limit plan should be refused even
    // in simulation, so the limit is never discovered only on the live attempt.
    if (total > this.maxSendWei) {
      throw new TradeRefused(
        `plan sends ${total} wei, above the ${this.maxSendWei} wei limit`,
        'OVER_LIMIT',
      );
    }

    if (!this.#d.session.isUnlocked) throw new TradeRefused('wallet is locked', 'LOCKED');

    if (!this.#d.liveTrading) return { status: 'simulated', steps: await this.#simulate(plan) };

    // Only live sends are serialised; simulations are read-only and independent.
    return this.#serialise(() => this.#send(plan));
  }

  async #simulate(plan: TradePlan): Promise<SimulatedStep[]> {
    const from = this.#d.session.address;
    const out: SimulatedStep[] = [];
    for (const step of plan.steps) {
      let wouldSucceed = false;
      let revertReason: string | null = null;
      let gas: bigint | null = null;
      try {
        await this.#d.client.call({ account: from ?? undefined, to: step.tx.to, data: step.tx.data, value: step.tx.value });
        wouldSucceed = true;
        gas = await this.#d.client
          .estimateGas({ account: from ?? undefined, to: step.tx.to, data: step.tx.data, value: step.tx.value })
          .catch(() => null);
      } catch (e) {
        revertReason = e instanceof Error ? (e.message.split('\n')[0] ?? 'reverted') : 'reverted';
      }
      out.push({ kind: step.kind, to: step.tx.to, value: step.tx.value, gas, wouldSucceed, revertReason });
      // Later steps depend on earlier ones having landed, so a failed approval
      // makes the swap's simulation meaningless rather than informative.
      if (!wouldSucceed) break;
    }
    return out;
  }

  async #send(plan: TradePlan): Promise<ExecutionOutcome> {
    const owner = this.#d.session.address;
    if (!owner) throw new TradeRefused('wallet is locked', 'LOCKED');

    // A record left from a previous worker lifetime means a broadcast may have
    // landed that we never saw. Never auto-resend — that is how double-spends
    // happen when MV3 tears the worker down mid-send.
    const stale = await this.#d.journal.pending();
    if (stale) {
      throw new TradeRefused(
        `a previous trade (${stale.id}) was broadcast but never confirmed; resolve it before trading again`,
        'IN_FLIGHT',
      );
    }

    const receipts: TransactionReceipt[] = [];
    let remaining = plan.steps.filter((s) => s.kind === 'approve');
    let rounds = 0;

    // Approvals first, re-asking the venue between each: Permit2's second grant
    // cannot be built until the first is on-chain.
    while (remaining.length > 0) {
      if (++rounds > MAX_APPROVAL_ROUNDS) {
        throw new TradeRefused('approvals did not converge; refusing to keep sending', 'STUCK_APPROVALS');
      }
      for (const step of remaining) receipts.push(await this.#sendStep(step, owner));
      const next = await this.#d.nextApproval?.(plan, owner);
      remaining = next ? [next] : [];
    }

    const swap = plan.steps.find((s) => s.kind === 'swap');
    if (swap) receipts.push(await this.#sendStep(swap, owner));

    return { status: 'sent', receipts };
  }

  async #sendStep(step: TradeStep, owner: Address): Promise<TransactionReceipt> {
    const { client, session, journal } = this.#d;

    // Read the nonce immediately before signing. Anything cached from earlier
    // in the plan would be stale the moment a previous step landed.
    const nonce = await client.getTransactionCount({ address: owner, blockTag: 'pending' });
    const gas = await client.estimateGas({ account: owner, to: step.tx.to, data: step.tx.data, value: step.tx.value });
    const fees = await client.estimateFeesPerGas();

    const signed = await session.withKey(async (privateKey, address) => {
      // The session could have been swapped between planning and signing.
      if (address.toLowerCase() !== owner.toLowerCase()) {
        throw new TradeRefused('the unlocked account changed mid-trade', 'WRONG_ACCOUNT');
      }
      const account = privateKeyToAccount(privateKey);
      return account.signTransaction({
        to: step.tx.to,
        data: step.tx.data,
        value: step.tx.value,
        gas: (gas * 12n) / 10n,
        nonce,
        chainId: this.#d.chainId,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        type: 'eip1559',
      });
    });

    // Recorded BEFORE the broadcast. If the worker dies between these two
    // lines, the next boot sees an unresolved record and refuses to trade
    // rather than silently resending.
    const id = await journal.record({ kind: step.kind, to: step.tx.to, value: step.tx.value.toString(), nonce });

    const hash = await this.#broadcast(signed);
    const receipt = await client.waitForTransactionReceipt({ hash });
    await journal.resolve(id, hash);
    return receipt;
  }

  /**
   * The send boundary. This is the last possible moment before the transaction
   * exists on the network, and therefore the only place the gate means anything.
   */
  async #broadcast(serializedTransaction: Hex): Promise<Hex> {
    if (!this.#d.liveTrading) {
      throw new TradeRefused('LIVE_TRADING is false — refusing to broadcast', 'NOT_LIVE');
    }
    return this.#d.client.sendRawTransaction({ serializedTransaction });
  }

  /** FIFO across concurrent callers; a rejection must not poison the queue. */
  #serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export { KeystoreError };
