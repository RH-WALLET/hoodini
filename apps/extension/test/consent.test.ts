/**
 * Standing consent (D-059).
 *
 * This is the one feature in the extension that lets funds move with nothing on
 * screen, and it is uncapped and unexpiring by explicit instruction. So the
 * tests that matter are not the happy path — they are every branch that must
 * still refuse, because each of those is the only thing left standing between a
 * hostile page and a balance.
 */

import { describe, expect, it } from 'vitest';
import { KeystoreSession, TEST_KDF } from '@hoodini/core';
import { createRouter } from '../src/background/router.js';
import { PendingTrades } from '../src/background/pending.js';
import { StandingConsent, FIRST_LIVE_KEY } from '../src/background/consent.js';
import { VaultStore, type StorageArea } from '../src/background/storage.js';
import { ALLOWED_SURFACES, NEVER_PAGE_ACCESSIBLE, isAllowed, type RequestType } from '../src/background/protocol.js';

const TOKEN = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const;
const ONE_ETH = 1_000_000_000_000_000_000n.toString();

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

/** A session that reports unlocked without needing a real vault or password. */
function unlockedSession(address: string | null): KeystoreSession {
  return { address, isUnlocked: address !== null, lock() {} } as unknown as KeystoreSession;
}

function build(opts: { unlocked?: boolean; liveTrading?: boolean; firstLiveDone?: boolean } = {}) {
  const area = memoryArea();
  if (opts.firstLiveDone) area.data[FIRST_LIVE_KEY] = true;
  const executed: { token: string; amount: string }[] = [];
  const consent = new StandingConsent(area, { liveTrading: opts.liveTrading ?? false, now: () => 1_000 });
  const pending = new PendingTrades({ now: () => 1_000, id: () => 'req-1' });
  const session = unlockedSession(opts.unlocked === false ? null : '0x1111111111111111111111111111111111111111');
  const handle = createRouter({
    store: new VaultStore(area),
    session,
    kdf: TEST_KDF,
    pending,
    consent,
    trade: {
      venues: {
        resolve: async () => ({
          adapter: {
            id: 'test-venue',
            async quoteBuy(_t: unknown, amountIn: bigint) {
              return { venueId: 'test-venue', state: 'open', amountIn, amountOut: amountIn / 2n, quoteAsset: 'ETH', feeBps: 0 };
            },
            async buildBuy() {
              return { to: TOKEN, data: '0x', value: 0n };
            },
          },
          via: 'registry',
        }),
      } as never,
      engine: {
        async execute(plan: { quote?: { amountIn?: bigint } }) {
          executed.push({ token: TOKEN, amount: String(plan?.quote?.amountIn ?? '') });
          return { status: opts.liveTrading ? 'sent' : 'simulated', steps: [], receipts: [] };
        },
      } as never,
      chainId: 4663,
      client: { async readContract() { return 10n ** 21n; } } as never,
      watchlist: { async list() { return []; }, async add() {} },
    },
  });
  return { handle, consent, pending, area, executed };
}

const buy = (amount = ONE_ETH) =>
  ({ type: 'trade.request', side: 'buy', token: TOKEN, amount, slippageBps: 100 }) as const;

describe('arming is not something a page can do', () => {
  it('keeps all three consent messages popup-only', () => {
    for (const t of ['consent.arm', 'consent.disarm', 'consent.status'] as RequestType[]) {
      expect(ALLOWED_SURFACES[t]).toEqual(['popup']);
      expect(isAllowed(t, 'page')).toBe(false);
    }
  });

  it('lists arming among the capabilities a page may never hold', () => {
    // Arming approves every future buy, so a page holding it would be holding
    // trade.execute by a longer route.
    expect(NEVER_PAGE_ACCESSIBLE).toContain('consent.arm');
  });

  it('refuses a page trying to arm it directly', async () => {
    const { handle } = build();
    const res = (await handle({ type: 'consent.arm' }, 'page')) as { ok: false; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('FORBIDDEN');
  });
});

describe('what still refuses once armed', () => {
  it('a sell always asks, because it is the whole balance and no limit can bound it', async () => {
    const { handle, executed } = build();
    await handle({ type: 'consent.arm' }, 'popup');
    const res = (await handle(
      { type: 'trade.request', side: 'sell', token: TOKEN, slippageBps: 100 },
      'page',
    )) as { ok: true; data: { autoApproved?: boolean } };
    expect(res.data.autoApproved).toBeUndefined();
    expect(executed).toHaveLength(0);
    // And it is still sitting there waiting for a human.
    const p = (await handle({ type: 'trade.pending' }, 'popup')) as { ok: true; data: { request: unknown } };
    expect(p.data.request).not.toBeNull();
  });

  it('a locked wallet signs nothing, however armed it is', async () => {
    const { handle, consent, executed } = build({ unlocked: false });
    // Arm directly: the arm message itself refuses while locked, which is the
    // next test. This proves the send path refuses too, not just the switch.
    consent.arm();
    const res = (await handle(buy(), 'page')) as { ok: true; data: { autoApproved?: boolean } };
    expect(res.data.autoApproved).toBeUndefined();
    expect(executed).toHaveLength(0);
  });

  it('refuses to arm while locked rather than becoming a switch that does nothing', async () => {
    const { handle } = build({ unlocked: false });
    const res = (await handle({ type: 'consent.arm' }, 'popup')) as { ok: false; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('LOCKED');
  });

  it('will not auto-approve the first live send — the canary is approved by hand', async () => {
    // CLAUDE.md invariant 5 is marked permanent, so a session preference does
    // not get to edit it.
    const { handle, executed } = build({ liveTrading: true, firstLiveDone: false });
    await handle({ type: 'consent.arm' }, 'popup');
    const res = (await handle(buy(), 'page')) as { ok: true; data: { autoApproved?: boolean } };
    expect(res.data.autoApproved).toBeUndefined();
    expect(executed).toHaveLength(0);
  });

  it('auto-approves live sends once a canary has gone out by hand', async () => {
    const { handle, executed } = build({ liveTrading: true, firstLiveDone: true });
    await handle({ type: 'consent.arm' }, 'popup');
    const res = (await handle(buy(), 'page')) as { ok: true; data: { autoApproved?: boolean } };
    expect(res.data.autoApproved).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('records the canary itself, so the gate closes after a real broadcast only', async () => {
    const { handle, area } = build({ liveTrading: true, firstLiveDone: false });
    expect(area.data[FIRST_LIVE_KEY]).toBeUndefined();
    await handle(
      { type: 'trade.execute', side: 'buy', token: TOKEN, amount: ONE_ETH, slippageBps: 100 },
      'popup',
    );
    expect(area.data[FIRST_LIVE_KEY]).toBe(true);
  });

  it('a dry-run build does not record a canary, because nothing was broadcast', async () => {
    const { handle, area } = build({ liveTrading: false });
    await handle(
      { type: 'trade.execute', side: 'buy', token: TOKEN, amount: ONE_ETH, slippageBps: 100 },
      'popup',
    );
    expect(area.data[FIRST_LIVE_KEY]).toBeUndefined();
  });
});

describe('what it does when it does fire', () => {
  it('approves a buy with no sheet, and says so rather than pretending one is waiting', async () => {
    const { handle, executed } = build();
    await handle({ type: 'consent.arm' }, 'popup');
    const res = (await handle(buy(), 'page')) as { ok: true; data: { autoApproved?: boolean } };
    expect(res.data.autoApproved).toBe(true);
    expect(executed).toHaveLength(1);
    // Nothing is left waiting: the request was consumed, not queued.
    const p = (await handle({ type: 'trade.pending' }, 'popup')) as { ok: true; data: { request: unknown } };
    expect(p.data.request).toBeNull();
  });

  it('never hands the page a receipt, which would leak the wallet address', async () => {
    // A `sent` outcome carries receipts, and a receipt carries `from`.
    // positions.list is popup-only to keep exactly that away from a site, so
    // auto-approval must not become the route around it.
    const { handle } = build({ liveTrading: true, firstLiveDone: true });
    await handle({ type: 'consent.arm' }, 'popup');
    const res = await handle(buy(), 'page');
    expect(JSON.stringify(res)).not.toMatch(/receipt|0x1111111111111111111111111111111111111111|from/i);
    expect(Object.keys((res as { data: object }).data).sort()).toEqual(['autoApproved', 'id']);
  });

  it('honours no upper bound on the amount — this is the instruction, recorded', async () => {
    // Not an oversight. It is the explicit brief, and this test exists so that
    // anyone tightening it later has to delete a test that says why.
    const { handle, executed } = build();
    await handle({ type: 'consent.arm' }, 'popup');
    const huge = (10n ** 24n).toString(); // a million ETH
    const res = (await handle(buy(huge), 'page')) as { ok: true; data: { autoApproved?: boolean } };
    expect(res.data.autoApproved).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('still refuses a malformed amount: uncapped is not unvalidated', async () => {
    const { handle, executed } = build();
    await handle({ type: 'consent.arm' }, 'popup');
    const res = (await handle({ ...buy(), amount: '1e18' }, 'page')) as { ok: false; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('BAD_REQUEST');
    expect(executed).toHaveLength(0);
  });

  it('still allows only one proposal at a time while disarmed', async () => {
    const { handle } = build();
    await handle(buy(), 'page');
    const second = (await handle(buy(), 'page')) as { ok: false; error: { code: string } };
    expect(second.error.code).toBe('PENDING_EXISTS');
  });
});

describe('turning it off', () => {
  it('disarms on lock, so stepping away stops the standing approval', async () => {
    const { handle, executed } = build();
    await handle({ type: 'consent.arm' }, 'popup');
    await handle({ type: 'wallet.lock' }, 'popup');
    const status = (await handle({ type: 'consent.status' }, 'popup')) as { ok: true; data: { armed: boolean } };
    expect(status.data.armed).toBe(false);
    // And the send path agrees with what the popup is showing.
    const res = (await handle(buy(), 'page')) as { ok: true; data: { autoApproved?: boolean } };
    expect(res.data.autoApproved).toBeUndefined();
    expect(executed).toHaveLength(0);
  });

  it('never refuses a disarm, including while locked', async () => {
    // An off switch that can fail is not an off switch.
    const { handle } = build({ unlocked: false });
    const res = (await handle({ type: 'consent.disarm' }, 'popup')) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it('does not persist arming: a worker restart starts disarmed', async () => {
    const { handle, area } = build();
    await handle({ type: 'consent.arm' }, 'popup');
    // Nothing about the armed state reached storage; only the canary record may.
    expect(Object.keys(area.data).filter((k) => k !== FIRST_LIVE_KEY)).toHaveLength(0);
    // A fresh instance over the same storage is a fresh worker.
    const restarted = new StandingConsent(area);
    expect(restarted.armed).toBe(false);
  });

  it('never reports armed while the session has expired underneath it', async () => {
    // Auto-lock expires a session without any message passing through the
    // router, so a bare flag could outlive the unlock it depends on.
    const area = memoryArea();
    const consent = new StandingConsent(area);
    const session = { address: '0x1111111111111111111111111111111111111111', isUnlocked: true, lock() {} };
    const handle = createRouter({
      store: new VaultStore(area), session: session as unknown as KeystoreSession, kdf: TEST_KDF,
      pending: new PendingTrades(), consent,
    });
    await handle({ type: 'consent.arm' }, 'popup');
    session.address = null as unknown as string; // auto-lock, silently
    const status = (await handle({ type: 'consent.status' }, 'popup')) as { ok: true; data: { armed: boolean } };
    expect(status.data.armed).toBe(false);
  });
});
