/**
 * Moving plain ETH out of the wallet.
 *
 * The second place in this extension that can spend, and it is deliberately not
 * folded into `TradeEngine`: a transfer has no venue, no quote, no approval
 * step and no slippage, and pretending otherwise would mean threading a fake
 * plan through code that exists to reason about swaps.
 *
 * What it *does* share is every safety property that matters:
 *
 *   - `LIVE_TRADING` is checked immediately before `sendRawTransaction`, not at
 *     construction, so nothing between the decision and the send can invalidate
 *     it (D-027, invariant 5)
 *   - the journal is written before broadcast and never auto-resends, so a
 *     worker that dies mid-send leaves a record rather than a mystery (D-028)
 *   - the account is re-checked inside `withKey`, because the session could
 *     have been swapped between planning and signing
 *
 * It is **not** subject to the canary ceiling — see `planWithdrawal` for why a
 * withdrawal and a trade carry different risks.
 */

import { planWithdrawal, type WithdrawalRequest } from '@hoodini/core';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, PublicClient } from 'viem';
import type { KeystoreSession } from '@hoodini/core';
import type { TradeJournal } from './journal.js';

/** Gas for a transfer to an account. Estimated anyway; this is the floor. */
const TRANSFER_GAS = 21_000n;

export class WithdrawRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'WithdrawRefused';
  }
}

export interface WithdrawerDeps {
  readonly client: PublicClient;
  readonly session: KeystoreSession;
  readonly journal: TradeJournal;
  readonly chainId: number;
  /** Build constant. Injected only so this is testable without a build. */
  readonly liveTrading: boolean;
}

export interface WithdrawOutcome {
  readonly status: 'sent' | 'simulated';
  readonly to: Address;
  readonly valueWei: string;
  readonly hash?: Hex;
}

export class Withdrawer {
  readonly #d: WithdrawerDeps;

  constructor(deps: WithdrawerDeps) {
    this.#d = deps;
  }

  async withdraw(request: WithdrawalRequest): Promise<WithdrawOutcome> {
    const { client, session, journal, chainId, liveTrading } = this.#d;

    const from = session.address;
    if (!from) throw new WithdrawRefused('LOCKED', 'unlock to withdraw');

    const [balanceWei, fees] = await Promise.all([
      client.getBalance({ address: from }),
      client.estimateFeesPerGas(),
    ]);

    // Throws WithdrawalRefused with a reason naming the field to fix.
    const plan = planWithdrawal(request, {
      balanceWei,
      gasLimit: TRANSFER_GAS,
      maxFeePerGas: fees.maxFeePerGas,
      from,
    });

    if (!liveTrading) {
      // A genuine rehearsal: the plan is real, the arithmetic is real, and the
      // only thing skipped is the broadcast.
      return { status: 'simulated', to: plan.to, valueWei: plan.valueWei.toString() };
    }

    const nonce = await client.getTransactionCount({ address: from, blockTag: 'pending' });

    const signed = await session.withKey(async (privateKey, address) => {
      if (address.toLowerCase() !== from.toLowerCase()) {
        throw new WithdrawRefused('WRONG_ACCOUNT', 'the unlocked account changed mid-withdrawal');
      }
      return privateKeyToAccount(privateKey).signTransaction({
        to: plan.to,
        value: plan.valueWei,
        gas: TRANSFER_GAS,
        nonce,
        chainId,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        type: 'eip1559',
      });
    });

    // Before the broadcast, always. If the worker dies between these two lines
    // the next boot finds an unresolved record instead of silently resending.
    const id = await journal.record({
      kind: 'withdraw',
      to: plan.to,
      value: plan.valueWei.toString(),
      nonce,
    });

    const hash = await this.#broadcast(signed);
    await client.waitForTransactionReceipt({ hash });
    await journal.resolve(id, hash);

    return { status: 'sent', to: plan.to, valueWei: plan.valueWei.toString(), hash };
  }

  /**
   * The send boundary. Last statement before the transaction exists on the
   * network, and therefore the only place the gate means anything.
   */
  async #broadcast(serializedTransaction: Hex): Promise<Hex> {
    if (!this.#d.liveTrading) {
      throw new WithdrawRefused('NOT_LIVE', 'LIVE_TRADING is false — refusing to broadcast');
    }
    return this.#d.client.sendRawTransaction({ serializedTransaction });
  }
}
