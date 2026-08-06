/**
 * The withdrawal send boundary.
 *
 * This is the second thing in the extension that can move funds, so it gets the
 * same treatment as the first: the property that matters is negative — with
 * `LIVE_TRADING` false, nothing reaches `sendRawTransaction`, whatever else
 * happens.
 */

import { describe, expect, it, vi } from 'vitest';
import { getAddress, parseEther, parseTransaction } from 'viem';
import { KeystoreSession, createVault, TEST_KDF } from '@hoodini/core';
import { Withdrawer, WithdrawRefused } from '../src/background/withdrawer.js';
import { TradeJournal } from '../src/background/journal.js';
import type { StorageArea } from '../src/background/storage.js';

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe512961708279a1e0f4dc4c8b0b0f1f' as const;
const PW = 'correct horse battery staple';
const TO = getAddress('0x297b94b8615b56bf902a776b979cc5b5104c0a9e');
const GAS = 21_000n;
const FEE = 20_538_000n;

function area(): StorageArea {
  const data: Record<string, unknown> = {};
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

async function setup(opts: { liveTrading: boolean; balance?: bigint; feeCap?: bigint }) {
  const session = new KeystoreSession();
  const vault = await createVault(KEY, PW, TEST_KDF);
  await session.unlock(vault, PW);

  const sendRawTransaction = vi.fn(async (_args: { serializedTransaction: `0x${string}` }) => '0xhash' as const);
  const client = {
    getBalance: vi.fn(async () => opts.balance ?? parseEther('0.01')),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: FEE, maxPriorityFeePerGas: 1n })),
    getTransactionCount: vi.fn(async () => 7),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    sendRawTransaction,
  } as never;

  const journal = new TradeJournal(area());
  const withdrawer = new Withdrawer({
    client,
    session,
    journal,
    chainId: 4663,
    liveTrading: opts.liveTrading,
    ...(opts.feeCap !== undefined ? { feeCap: async () => opts.feeCap } : {}),
  });
  return { withdrawer, sendRawTransaction, journal, session };
}

describe('the LIVE_TRADING gate', () => {
  it('never reaches sendRawTransaction when the flag is false', async () => {
    const { withdrawer, sendRawTransaction } = await setup({ liveTrading: false });
    const out = await withdrawer.withdraw({ to: TO, amount: parseEther('0.001').toString() });
    expect(out.status).toBe('simulated');
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it('broadcasts once when the flag is true', async () => {
    const { withdrawer, sendRawTransaction } = await setup({ liveTrading: true });
    const out = await withdrawer.withdraw({ to: TO, amount: parseEther('0.001').toString() });
    expect(out.status).toBe('sent');
    expect(out.hash).toBe('0xhash');
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('still plans and validates in a dry run, so it is a real rehearsal', async () => {
    // A simulation that skipped the arithmetic would prove nothing about the
    // live path it is standing in for.
    const { withdrawer } = await setup({ liveTrading: false });
    await expect(withdrawer.withdraw({ to: 'nonsense', amount: '1' })).rejects.toMatchObject({ code: 'BAD_ADDRESS' });
    const out = await withdrawer.withdraw({ to: TO, amount: 'max' });
    expect(BigInt(out.valueWei)).toBe(parseEther('0.01') - GAS * FEE);
  });
});

describe('refusals', () => {
  it('refuses while locked, before touching the chain', async () => {
    const { withdrawer, session } = await setup({ liveTrading: true });
    session.lock();
    await expect(withdrawer.withdraw({ to: TO, amount: '1000' })).rejects.toBeInstanceOf(WithdrawRefused);
  });

  it('refuses a sweep that cannot cover its own fee, without broadcasting', async () => {
    const { withdrawer, sendRawTransaction } = await setup({ liveTrading: true, balance: GAS * FEE - 1n });
    await expect(withdrawer.withdraw({ to: TO, amount: 'max' })).rejects.toMatchObject({ code: 'DUST' });
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it('refuses more than the balance can cover with fees, without broadcasting', async () => {
    const { withdrawer, sendRawTransaction } = await setup({ liveTrading: true });
    await expect(
      withdrawer.withdraw({ to: TO, amount: parseEther('0.01').toString() }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT' });
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe('the journal', () => {
  it('leaves nothing unresolved after a successful send', async () => {
    const { withdrawer, journal } = await setup({ liveTrading: true });
    await withdrawer.withdraw({ to: TO, amount: parseEther('0.001').toString() });
    expect(await journal.pending()).toBeNull();
  });

  it('leaves an unresolved record when the broadcast throws', async () => {
    // The record is written *before* the send, so a worker that dies between
    // the two lines leaves evidence rather than a mystery — and the next boot
    // refuses to trade rather than silently resending (D-028).
    const { withdrawer, journal, sendRawTransaction } = await setup({ liveTrading: true });
    (sendRawTransaction as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('network down'),
    );
    await expect(withdrawer.withdraw({ to: TO, amount: '1000' })).rejects.toThrow();

    const stuck = await journal.pending();
    expect(stuck?.kind).toBe('withdraw');
    expect(stuck?.hash).toBeUndefined();
    expect(stuck?.nonce).toBe(7);
  });
});

/**
 * A profile fee cap and the sweep (P14, against D-056).
 *
 * The invariant is that the fee reserved by `planWithdrawal` and the fee signed
 * into the transaction are the same number. Core cannot enforce it — only this
 * file passing one variable to both can — so these read the signed bytes back
 * and compare them against the amount the plan decided to leave behind.
 */
describe('fee cap on a withdrawal', () => {
  /** 0.5 gwei, twenty-odd times the chain's observed price. */
  const RAISED = 500_000_000n;

  it('signs the cap instead of the node’s suggestion', async () => {
    const { withdrawer, sendRawTransaction } = await setup({ liveTrading: true, feeCap: RAISED });
    await withdrawer.withdraw({ to: TO, amount: parseEther('0.001').toString() });
    const tx = parseTransaction(sendRawTransaction.mock.calls[0]![0]!.serializedTransaction);
    expect(tx.maxFeePerGas).toBe(RAISED);
  });

  it('sweeps at the cap it signs — the whole of D-056 in one assertion', async () => {
    const balance = parseEther('0.01');
    const { withdrawer, sendRawTransaction } = await setup({
      liveTrading: true,
      balance,
      feeCap: RAISED,
    });
    const out = await withdrawer.withdraw({ to: TO, amount: 'max' });
    const tx = parseTransaction(sendRawTransaction.mock.calls[0]![0]!.serializedTransaction);

    // What was left behind is exactly what the signed cap can cost, to the wei.
    // Reserving at the node's lower estimate here would strand the sweep.
    expect(BigInt(out.valueWei) + GAS * tx.maxFeePerGas!).toBe(balance);
    expect(tx.value).toBe(BigInt(out.valueWei));
  });

  it('a raised cap sweeps less than an unset one, by the difference', async () => {
    const balance = parseEther('0.01');
    const plain = await setup({ liveTrading: true, balance });
    const capped = await setup({ liveTrading: true, balance, feeCap: RAISED });
    const a = await plain.withdrawer.withdraw({ to: TO, amount: 'max' });
    const b = await capped.withdrawer.withdraw({ to: TO, amount: 'max' });
    expect(BigInt(a.valueWei) - BigInt(b.valueWei)).toBe(GAS * (RAISED - FEE));
  });

  it('clamps the priority to the cap here too', async () => {
    // The node suggests 1 wei of tip in this fixture, so use a cap below it.
    const { withdrawer, sendRawTransaction } = await setup({ liveTrading: true, feeCap: 1n });
    await withdrawer.withdraw({ to: TO, amount: parseEther('0.000000001').toString() });
    const tx = parseTransaction(sendRawTransaction.mock.calls[0]![0]!.serializedTransaction);
    expect(tx.maxPriorityFeePerGas! <= tx.maxFeePerGas!).toBe(true);
  });

  it('refuses rather than sweeping when the cap alone exceeds the balance', async () => {
    const { withdrawer, sendRawTransaction } = await setup({
      liveTrading: true,
      balance: 1_000_000n,
      feeCap: RAISED,
    });
    await expect(withdrawer.withdraw({ to: TO, amount: 'max' })).rejects.toThrow(/network fee/i);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it('with no cap, behaves exactly as it did before P14', async () => {
    const { withdrawer, sendRawTransaction } = await setup({ liveTrading: true });
    await withdrawer.withdraw({ to: TO, amount: parseEther('0.001').toString() });
    const tx = parseTransaction(sendRawTransaction.mock.calls[0]![0]!.serializedTransaction);
    expect(tx.maxFeePerGas).toBe(FEE);
    expect(tx.maxPriorityFeePerGas).toBe(1n);
  });
});
