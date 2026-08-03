/**
 * Trade engine — the send boundary.
 *
 * The property that matters most is negative: with `LIVE_TRADING` false,
 * nothing reaches `sendRawTransaction`. The fake client below throws if it is
 * ever called, so a regression surfaces as a failure rather than as a
 * transaction on someone's account.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { KeystoreSession, TEST_KDF, createVault, type TradePlan } from '@hoodini/core';
import type { Address, Hex } from 'viem';
import { CANARY_MAX_WEI, TradeEngine, TradeRefused } from '../src/background/engine.js';
import { TradeJournal, JOURNAL_KEY } from '../src/background/journal.js';
import type { StorageArea } from '../src/background/storage.js';

const PW = 'correct horse battery staple';
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe512961708279a1e0f4dc4c8b0b0f1f' as Hex;
const TOKEN = '0xB84e494158976B4e14da155d1cdaE16EB6D1C477' as Address;
const ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2' as Address;

function memoryArea(): StorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
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

function plan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    side: 'buy',
    token: { address: TOKEN, chainId: 4663 },
    venueId: 'uniswap-v3',
    via: 'registry',
    state: 'graduated',
    quote: {
      venueId: 'uniswap-v3',
      state: 'graduated',
      amountIn: 10n ** 15n,
      amountOut: 1000n,
      priceImpactBps: null,
      feeBps: 100,
      source: 'simulation',
    },
    minOut: 990n,
    steps: [{ kind: 'swap', tx: { to: ROUTER, data: '0xdeadbeef', value: 10n ** 15n, description: 'buy' } }],
    mayNeedMoreApprovals: false,
    ...overrides,
  } as TradePlan;
}

function fakeClient(over: Record<string, unknown> = {}) {
  const sent: Hex[] = [];
  return {
    sent,
    client: {
      async call() {
        return { data: '0x' };
      },
      async estimateGas() {
        return 100_000n;
      },
      async estimateFeesPerGas() {
        return { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 100_000n };
      },
      async getTransactionCount() {
        return 7;
      },
      async sendRawTransaction({ serializedTransaction }: { serializedTransaction: Hex }) {
        sent.push(serializedTransaction);
        return '0xhash' as Hex;
      },
      async waitForTransactionReceipt() {
        return { status: 'success', transactionHash: '0xhash' };
      },
      ...over,
    } as never,
  };
}

async function unlockedSession() {
  const vault = await createVault(KEY, PW, TEST_KDF);
  const session = new KeystoreSession();
  await session.unlock(vault, PW);
  return session;
}

describe('LIVE_TRADING gate', () => {
  let session: KeystoreSession;
  beforeEach(async () => {
    session = await unlockedSession();
  });

  it('never reaches sendRawTransaction when LIVE_TRADING is false', async () => {
    const sendRawTransaction = vi.fn(() => {
      throw new Error('broadcast attempted while LIVE_TRADING was false');
    });
    const { client } = fakeClient({ sendRawTransaction });
    const engine = new TradeEngine({
      client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: false,
      chainId: 4663,
    });

    const out = await engine.execute(plan());
    expect(out.status).toBe('simulated');
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a dry run still exercises the chain, so it proves something', async () => {
    const call = vi.fn(async () => ({ data: '0x' }));
    const { client } = fakeClient({ call });
    const engine = new TradeEngine({
      client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: false,
      chainId: 4663,
    });
    const out = await engine.execute(plan());
    expect(call).toHaveBeenCalled();
    expect(out).toMatchObject({ status: 'simulated', steps: [{ wouldSucceed: true }] });
  });

  it('reports a reverting step instead of claiming success', async () => {
    const { client } = fakeClient({
      call: async () => {
        throw new Error('execution reverted: STF');
      },
    });
    const engine = new TradeEngine({
      client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: false,
      chainId: 4663,
    });
    const out = await engine.execute(plan());
    expect(out).toMatchObject({ status: 'simulated', steps: [{ wouldSucceed: false }] });
  });

  it('broadcasts only when LIVE_TRADING is true', async () => {
    const f = fakeClient();
    const engine = new TradeEngine({
      client: f.client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: true,
      chainId: 4663,
    });
    const out = await engine.execute(plan());
    expect(out.status).toBe('sent');
    expect(f.sent).toHaveLength(1);
  });
});

describe('canary limit', () => {
  it('defaults to 0.005 ETH', async () => {
    const session = await unlockedSession();
    const engine = new TradeEngine({
      client: fakeClient().client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: true,
      chainId: 4663,
    });
    expect(engine.maxSendWei).toBe(CANARY_MAX_WEI);
    expect(CANARY_MAX_WEI).toBe(5_000_000_000_000_000n);
  });

  it('refuses an over-limit plan even in simulation', async () => {
    const session = await unlockedSession();
    const f = fakeClient();
    const engine = new TradeEngine({
      client: f.client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: false,
      chainId: 4663,
    });
    // Refusing in dry run too, so the limit is never first discovered on the
    // live attempt.
    const big = plan({ steps: [{ kind: 'swap', tx: { to: ROUTER, data: '0x', value: CANARY_MAX_WEI + 1n, description: 'big' } }] });
    await expect(engine.execute(big)).rejects.toMatchObject({ code: 'OVER_LIMIT' });
    expect(f.sent).toHaveLength(0);
  });

  it('counts value across every step, not just the swap', async () => {
    const session = await unlockedSession();
    const engine = new TradeEngine({
      client: fakeClient().client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: true,
      chainId: 4663,
    });
    const half = CANARY_MAX_WEI / 2n + 1n;
    const split = plan({
      steps: [
        { kind: 'approve', tx: { to: TOKEN, data: '0x', value: half, description: 'a' } },
        { kind: 'swap', tx: { to: ROUTER, data: '0x', value: half, description: 'b' } },
      ],
    });
    await expect(engine.execute(split)).rejects.toMatchObject({ code: 'OVER_LIMIT' });
  });
});

describe('locked wallet', () => {
  it('refuses to trade at all', async () => {
    const engine = new TradeEngine({
      client: fakeClient().client,
      session: new KeystoreSession(),
      journal: new TradeJournal(memoryArea()),
      liveTrading: true,
      chainId: 4663,
    });
    await expect(engine.execute(plan())).rejects.toMatchObject({ code: 'LOCKED' });
  });
});

describe('in-flight journal', () => {
  it('records before broadcasting and clears after the receipt', async () => {
    const session = await unlockedSession();
    const area = memoryArea();
    const order: string[] = [];
    const f = fakeClient({
      async sendRawTransaction() {
        // The record must already exist at broadcast time — that is the whole
        // point of writing it first.
        order.push(area.data[JOURNAL_KEY] ? 'recorded' : 'MISSING');
        return '0xhash' as Hex;
      },
    });
    const engine = new TradeEngine({
      client: f.client,
      session,
      journal: new TradeJournal(area),
      liveTrading: true,
      chainId: 4663,
    });
    await engine.execute(plan());
    expect(order).toEqual(['recorded']);
    expect(area.data[JOURNAL_KEY]).toBeUndefined();
  });

  it('refuses to trade while a previous send is unresolved, and never resends it', async () => {
    const session = await unlockedSession();
    const area = memoryArea();
    area.data[JOURNAL_KEY] = { id: 'abc', kind: 'swap', to: ROUTER, value: '1', nonce: 3, at: 1 };
    const f = fakeClient();
    const engine = new TradeEngine({
      client: f.client,
      session,
      journal: new TradeJournal(area),
      liveTrading: true,
      chainId: 4663,
    });
    await expect(engine.execute(plan())).rejects.toMatchObject({ code: 'IN_FLIGHT' });
    expect(f.sent).toHaveLength(0);
  });
});

describe('approvals', () => {
  it('re-asks the venue between approvals, since Permit2 needs two', async () => {
    const session = await unlockedSession();
    const f = fakeClient();
    let asked = 0;
    const engine = new TradeEngine({
      client: f.client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: true,
      chainId: 4663,
      nextApproval: async () =>
        ++asked === 1 ? { kind: 'approve', tx: { to: TOKEN, data: '0x02', value: 0n, description: 'permit2' } } : null,
    });
    const p = plan({
      side: 'sell',
      steps: [
        { kind: 'approve', tx: { to: TOKEN, data: '0x01', value: 0n, description: 'erc20' } },
        { kind: 'swap', tx: { to: ROUTER, data: '0x03', value: 0n, description: 'sell' } },
      ],
    });
    const out = await engine.execute(p);
    expect(out.status).toBe('sent');
    // erc20 approve, permit2 approve, swap
    expect(f.sent).toHaveLength(3);
  });

  it('gives up rather than looping forever if approvals never converge', async () => {
    const session = await unlockedSession();
    const f = fakeClient();
    const engine = new TradeEngine({
      client: f.client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: true,
      chainId: 4663,
      // A venue that always wants another approval would otherwise drain gas
      // one approval at a time.
      nextApproval: async () => ({ kind: 'approve', tx: { to: TOKEN, data: '0x', value: 0n, description: 'again' } }),
    });
    const p = plan({
      side: 'sell',
      steps: [
        { kind: 'approve', tx: { to: TOKEN, data: '0x01', value: 0n, description: 'erc20' } },
        { kind: 'swap', tx: { to: ROUTER, data: '0x03', value: 0n, description: 'sell' } },
      ],
    });
    await expect(engine.execute(p)).rejects.toMatchObject({ code: 'STUCK_APPROVALS' });
  });
});

describe('nonce handling', () => {
  it('reads the pending nonce immediately before each signature', async () => {
    const session = await unlockedSession();
    const getTransactionCount = vi.fn(async (_args: { address: Address; blockTag?: string }) => 7);
    const f = fakeClient({ getTransactionCount });
    const engine = new TradeEngine({
      client: f.client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: true,
      chainId: 4663,
      nextApproval: async () => null,
    });
    await engine.execute(
      plan({
        side: 'sell',
        steps: [
          { kind: 'approve', tx: { to: TOKEN, data: '0x01', value: 0n, description: 'a' } },
          { kind: 'swap', tx: { to: ROUTER, data: '0x02', value: 0n, description: 'b' } },
        ],
      }),
    );
    // Once per step: a nonce cached across steps would be stale the moment the
    // first one landed.
    expect(getTransactionCount).toHaveBeenCalledTimes(2);
    expect(getTransactionCount.mock.calls.every((c) => c[0]?.blockTag === 'pending')).toBe(true);
  });

  it('serialises concurrent trades so two cannot claim the same nonce', async () => {
    const session = await unlockedSession();
    const active: number[] = [];
    let peak = 0;
    const f = fakeClient({
      async sendRawTransaction(a: { serializedTransaction: Hex }) {
        active.push(1);
        peak = Math.max(peak, active.length);
        await new Promise((r) => setTimeout(r, 5));
        active.pop();
        void a;
        return '0xhash' as Hex;
      },
    });
    const engine = new TradeEngine({
      client: f.client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: true,
      chainId: 4663,
    });
    await Promise.all([engine.execute(plan()), engine.execute(plan()), engine.execute(plan())]);
    expect(peak).toBe(1);
  });

  it('a failed trade does not wedge the queue for the next one', async () => {
    const session = await unlockedSession();
    let n = 0;
    const f = fakeClient({
      async sendRawTransaction() {
        if (++n === 1) throw new Error('rpc rejected');
        return '0xhash' as Hex;
      },
    });
    const engine = new TradeEngine({
      client: f.client,
      session,
      journal: new TradeJournal(memoryArea()),
      liveTrading: true,
      chainId: 4663,
    });
    await expect(engine.execute(plan())).rejects.toBeInstanceOf(Error);
    // The journal still holds the failed record, which correctly blocks the
    // next trade — but the queue itself must not be poisoned.
    await expect(engine.execute(plan())).rejects.toMatchObject({ code: 'IN_FLIGHT' });
  });
});

describe('TradeRefused', () => {
  it('is distinguishable from an ordinary error', () => {
    const e = new TradeRefused('nope', 'NOT_LIVE');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('NOT_LIVE');
  });
});
