/**
 * Planning a withdrawal.
 *
 * The arithmetic only, kept away from anything that can sign. This is the code
 * that decides how much of someone's balance leaves the wallet, and getting it
 * wrong has exactly two failure modes, both bad: send too much and the
 * transaction cannot pay its own gas, send too little and a "sweep" quietly
 * strands funds the user believed they had moved.
 *
 * Pure, so both can be tested against exact numbers rather than a testnet.
 *
 * ## Why a withdrawal is not a trade
 *
 * It is not subject to the canary ceiling. That limit exists because a trade
 * amount is computed — by a planner, from a quote, across steps — and a bug in
 * that computation could produce an absurd number nobody typed. A withdrawal
 * amount is typed by a human and shown back to them before they confirm; the
 * risk it carries is a wrong *address*, which no ceiling helps with.
 *
 * Capping it would also defeat the point. The feature exists so funds can be
 * recovered, and a recovery path that cannot move more than 0.005 ETH is not
 * one.
 */

import { getAddress, isAddress, type Address } from 'viem';

export interface WithdrawalRequest {
  readonly to: string;
  /** Wei as a decimal string, or `'max'` to sweep. */
  readonly amount: string | 'max';
}

export interface WithdrawalContext {
  /** The sender's current balance, in wei. */
  readonly balanceWei: bigint;
  /** Gas units this transfer will use. 21,000 for a plain send. */
  readonly gasLimit: bigint;
  /** The fee cap that will be signed, in wei per gas. */
  readonly maxFeePerGas: bigint;
  /** Guards against sending to oneself by accident. */
  readonly from: Address;
}

export interface WithdrawalPlan {
  readonly to: Address;
  readonly valueWei: bigint;
  /** What the transfer can cost at the fee cap — reserved, never sent. */
  readonly maxFeeWei: bigint;
  /** True when the amount was computed rather than typed. */
  readonly isSweep: boolean;
}

export class WithdrawalRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'WithdrawalRefused';
  }
}

/**
 * Turn a request into a plan, or refuse with a reason a person can act on.
 *
 * Every refusal names what is wrong rather than returning a generic failure:
 * this is the last screen before funds move, and "invalid" tells someone
 * nothing about which field to fix.
 */
export function planWithdrawal(request: WithdrawalRequest, context: WithdrawalContext): WithdrawalPlan {
  const { balanceWei, gasLimit, maxFeePerGas, from } = context;

  if (typeof request.to !== 'string' || !isAddress(request.to.trim(), { strict: false })) {
    throw new WithdrawalRefused('BAD_ADDRESS', 'that is not a valid address');
  }
  const to = getAddress(request.to.trim());

  // Not a security control — it protects nothing from an attacker. It catches
  // a paste into the wrong field, which is a mistake people actually make.
  if (to.toLowerCase() === from.toLowerCase()) {
    throw new WithdrawalRefused('SELF_SEND', 'that is this wallet’s own address');
  }

  if (gasLimit <= 0n || maxFeePerGas <= 0n) {
    throw new WithdrawalRefused('NO_FEE_DATA', 'could not read current network fees');
  }
  const maxFeeWei = gasLimit * maxFeePerGas;

  if (request.amount === 'max') {
    // Reserve the fee at its *cap*, not an estimate. Signing commits to
    // `maxFeePerGas`, so a sweep computed from anything lower can be rejected
    // for insufficient funds the moment the base fee ticks up.
    const value = balanceWei - maxFeeWei;
    if (value <= 0n) {
      throw new WithdrawalRefused('DUST', 'the balance does not cover the network fee');
    }
    return { to, valueWei: value, maxFeeWei, isSweep: true };
  }

  if (!/^\d+$/.test(request.amount)) {
    throw new WithdrawalRefused('BAD_AMOUNT', 'amount must be a whole number of wei');
  }
  const value = BigInt(request.amount);
  if (value <= 0n) {
    throw new WithdrawalRefused('BAD_AMOUNT', 'amount must be greater than zero');
  }
  // Checked against balance *plus fee*, not balance alone. Sending exactly the
  // balance is the most natural way to try to empty a wallet and the one that
  // always fails, so it is refused here with an explanation rather than by the
  // node with a revert.
  if (value + maxFeeWei > balanceWei) {
    throw new WithdrawalRefused(
      'INSUFFICIENT',
      'not enough to cover that amount plus the network fee — use Max to sweep',
    );
  }

  return { to, valueWei: value, maxFeeWei, isSweep: false };
}
