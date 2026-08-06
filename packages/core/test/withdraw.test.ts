/**
 * Withdrawal planning.
 *
 * Two failure modes matter and both are quiet: send too much and the
 * transaction cannot pay its own gas, send too little and a "sweep" strands
 * funds the user believes they moved. Everything here is exact arithmetic, so
 * the tests are exact too.
 */

import { describe, expect, it } from 'vitest';
import { getAddress, parseEther } from 'viem';
import { planWithdrawal, WithdrawalRefused } from '../src/withdraw.js';

const FROM = getAddress('0x5dbaca8327b0baa57eb6c872a333bf8d6f642ba3');
const TO = getAddress('0x297b94b8615b56bf902a776b979cc5b5104c0a9e');

const GAS = 21_000n;
const FEE = 20_538_000n; // the chain's observed gas price, in wei per gas
const MAX_FEE = GAS * FEE;

const ctx = (balanceEth: string) => ({
  balanceWei: parseEther(balanceEth),
  gasLimit: GAS,
  maxFeePerGas: FEE,
  from: FROM,
});

function refusal(fn: () => unknown): WithdrawalRefused {
  try {
    fn();
  } catch (e) {
    if (e instanceof WithdrawalRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal, got a plan');
}

describe('a typed amount', () => {
  it('plans exactly what was asked for', () => {
    const plan = planWithdrawal({ to: TO, amount: parseEther('0.001').toString() }, ctx('0.01'));
    expect(plan.valueWei).toBe(parseEther('0.001'));
    expect(plan.to).toBe(TO);
    expect(plan.isSweep).toBe(false);
    expect(plan.maxFeeWei).toBe(MAX_FEE);
  });

  it('refuses the whole balance, because the fee still has to come from somewhere', () => {
    // The most natural way to try to empty a wallet, and the one that always
    // fails. Better a sentence here than a revert from the node.
    const e = refusal(() => planWithdrawal({ to: TO, amount: parseEther('0.01').toString() }, ctx('0.01')));
    expect(e.code).toBe('INSUFFICIENT');
    expect(e.message).toMatch(/Max/);
  });

  it('allows exactly balance minus fee', () => {
    const balance = parseEther('0.01');
    const plan = planWithdrawal({ to: TO, amount: (balance - MAX_FEE).toString() }, ctx('0.01'));
    expect(plan.valueWei).toBe(balance - MAX_FEE);
  });

  it('refuses one wei more than that', () => {
    const balance = parseEther('0.01');
    expect(refusal(() => planWithdrawal({ to: TO, amount: (balance - MAX_FEE + 1n).toString() }, ctx('0.01'))).code).toBe(
      'INSUFFICIENT',
    );
  });

  it.each(['0', '-1', '0.5', '1e18', '', 'lots', '0x10'])('refuses the amount %o', (amount) => {
    expect(refusal(() => planWithdrawal({ to: TO, amount }, ctx('1'))).code).toMatch(/BAD_AMOUNT/);
  });
});

describe('sweeping', () => {
  it('leaves exactly the fee behind', () => {
    const plan = planWithdrawal({ to: TO, amount: 'max' }, ctx('0.01'));
    expect(plan.valueWei).toBe(parseEther('0.01') - MAX_FEE);
    expect(plan.isSweep).toBe(true);
  });

  it('reserves the fee cap rather than an estimate', () => {
    // Signing commits to maxFeePerGas. A sweep computed from anything lower is
    // rejected for insufficient funds the moment the base fee ticks up.
    const plan = planWithdrawal({ to: TO, amount: 'max' }, ctx('0.01'));
    expect(plan.valueWei + plan.maxFeeWei).toBe(parseEther('0.01'));
  });

  it('refuses when the balance cannot cover the fee', () => {
    const e = refusal(() => planWithdrawal({ to: TO, amount: 'max' }, { ...ctx('0'), balanceWei: MAX_FEE - 1n }));
    expect(e.code).toBe('DUST');
  });

  it('refuses a balance exactly equal to the fee, which would send zero', () => {
    expect(refusal(() => planWithdrawal({ to: TO, amount: 'max' }, { ...ctx('0'), balanceWei: MAX_FEE })).code).toBe('DUST');
  });
});

describe('the destination', () => {
  it.each(['', 'not an address', '0x123', '0x' + 'z'.repeat(40)])('refuses %o', (to) => {
    expect(refusal(() => planWithdrawal({ to, amount: '1000' }, ctx('1'))).code).toBe('BAD_ADDRESS');
  });

  it('accepts a lowercase address and returns it checksummed', () => {
    const plan = planWithdrawal({ to: TO.toLowerCase(), amount: '1000' }, ctx('1'));
    expect(plan.to).toBe(TO);
  });

  it('tolerates surrounding whitespace, which pasting produces', () => {
    expect(planWithdrawal({ to: `  ${TO}  `, amount: '1000' }, ctx('1')).to).toBe(TO);
  });

  it('refuses this wallet’s own address', () => {
    // Not a security control. It catches a paste into the wrong field, which
    // is a mistake people actually make.
    expect(refusal(() => planWithdrawal({ to: FROM, amount: '1000' }, ctx('1'))).code).toBe('SELF_SEND');
    expect(refusal(() => planWithdrawal({ to: FROM.toLowerCase(), amount: '1000' }, ctx('1'))).code).toBe('SELF_SEND');
  });
});

describe('fee data', () => {
  it.each([
    [0n, FEE],
    [GAS, 0n],
  ])('refuses to plan without usable fees (gas %s, fee %s)', (gasLimit, maxFeePerGas) => {
    // Planning with a zero fee would sweep the entire balance and leave
    // nothing to pay for the transfer.
    const e = refusal(() => planWithdrawal({ to: TO, amount: 'max' }, { ...ctx('1'), gasLimit, maxFeePerGas }));
    expect(e.code).toBe('NO_FEE_DATA');
  });
});

/**
 * A profile's fee cap and the sweep reserve (P14, against D-056).
 *
 * `planWithdrawal` already takes the fee as a parameter, so this needs no
 * source change — which is exactly why it needs a test. The invariant is a
 * property of the *caller*: the number reserved here and the number signed must
 * be the same number. A profile that raises the cap changes what a sweep leaves
 * behind, and reserving at less than is signed is how Max starts failing.
 */
describe('sweeping under a profile fee cap', () => {
  /** 0.5 gwei — an ordinary cap, twenty-odd times the chain's observed price. */
  const RAISED = 500_000_000n;

  it('still succeeds, and still leaves exactly the fee behind', () => {
    const plan = planWithdrawal(
      { to: TO, amount: 'max' },
      { ...ctx('0.01'), maxFeePerGas: RAISED },
    );
    expect(plan.isSweep).toBe(true);
    expect(plan.valueWei + plan.maxFeeWei).toBe(parseEther('0.01'));
    expect(plan.maxFeeWei).toBe(GAS * RAISED);
  });

  it('a raised cap sweeps less, by exactly the difference', () => {
    const at = (fee: bigint) =>
      planWithdrawal({ to: TO, amount: 'max' }, { ...ctx('0.01'), maxFeePerGas: fee }).valueWei;
    expect(at(FEE) - at(RAISED)).toBe(GAS * (RAISED - FEE));
  });

  it('reserving at less than will be signed is what strands a sweep', () => {
    // The D-056 failure, written down: plan at the node's estimate, sign at the
    // profile's higher cap, and the transaction cannot pay for itself. Nothing
    // in core can prevent this — only passing one number to both can — so this
    // states the size of the hole the caller has to not open.
    const planned = planWithdrawal({ to: TO, amount: 'max' }, ctx('0.01'));
    const signedCost = GAS * RAISED;
    expect(planned.valueWei + signedCost).toBeGreaterThan(parseEther('0.01'));
  });

  it('refuses when the cap alone exceeds the balance, rather than sending dust', () => {
    const e = refusal(() =>
      planWithdrawal({ to: TO, amount: 'max' }, { ...ctx('0'), balanceWei: 1n, maxFeePerGas: RAISED }),
    );
    expect(e.code).toBe('DUST');
  });

  it('a plain amount is checked against the raised cap too', () => {
    // 0.01 minus a hair: fine at the chain's price, refused once the cap is the
    // one that will be signed.
    const amount = (parseEther('0.01') - GAS * FEE).toString();
    expect(planWithdrawal({ to: TO, amount }, ctx('0.01')).valueWei).toBe(BigInt(amount));
    const e = refusal(() =>
      planWithdrawal({ to: TO, amount }, { ...ctx('0.01'), maxFeePerGas: RAISED }),
    );
    expect(e.code).toBe('INSUFFICIENT');
  });
});
