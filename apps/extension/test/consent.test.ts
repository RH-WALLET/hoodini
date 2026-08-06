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
import { StandingConsent, FIRST_LIVE_KEY, AUTO_ARM_KEY } from '../src/background/consent.js';
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
            async quoteSell(_t: unknown, amountIn: bigint) {
              return { venueId: 'test-venue', state: 'open', amountIn, amountOut: amountIn / 3n, quoteAsset: null, feeBps: 25 };
            },
            // A real sell needs an allowance first; returning one exercises the
            // two-step shape the live plan actually has.
            async approvalNeeded() {
              return { to: TOKEN, data: '0x', value: 0n };
            },
            async buildSell() {
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

describe('a sell must survive the whole route (D-061)', () => {
  // Every piece of this was covered and every piece passed. What was never
  // tested was a sell travelling propose -> approve -> execute in one go, and
  // that is the only path a real sell takes.
  const sell = () => ({ type: 'trade.request', side: 'sell', token: TOKEN, slippageBps: 100 }) as const;

  it('an approved sell reaches the engine instead of failing as BAD_REQUEST', async () => {
    // It used to re-dispatch with `amount: '0'`, and an explicit zero is
    // refused as out of range, so approving a sell always failed.
    const { handle, executed } = build();
    const proposed = (await handle(sell(), 'page')) as { ok: true; data: { id: string } };
    const res = (await handle({ type: 'trade.approve', id: proposed.data.id }, 'popup')) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(res.error?.code).not.toBe('BAD_REQUEST');
    expect(res.ok).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('sells the whole balance, because absence of an amount is what means that', async () => {
    // The fake client answers 10^21 for balanceOf, so that is what a sell of
    // "everything" must price.
    const { handle, executed } = build();
    const proposed = (await handle(sell(), 'page')) as { ok: true; data: { id: string } };
    await handle({ type: 'trade.approve', id: proposed.data.id }, 'popup');
    expect(executed[0]?.amount).toBe((10n ** 21n).toString());
  });

  it('still refuses a buy with no amount — only a sell may omit it', async () => {
    const { handle } = build();
    const res = (await handle(
      { type: 'trade.request', side: 'buy', token: TOKEN, slippageBps: 100 },
      'page',
    )) as { ok: false; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('BAD_REQUEST');
  });

  it('refuses an explicit zero rather than reading it as "everything"', async () => {
    // The coercion that caused D-061 would be silently correct if zero meant
    // the whole balance. It must not: an explicit zero is a mistake, and
    // treating it as "sell everything" would be the worse failure by far.
    const { handle, executed } = build();
    const res = (await handle(
      { type: 'trade.execute', side: 'sell', token: TOKEN, amount: '0', slippageBps: 100 },
      'popup',
    )) as { ok: false; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('BAD_REQUEST');
    expect(executed).toHaveLength(0);
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

  it('does not persist the armed flag itself: a worker restart starts disarmed', async () => {
    // What persists is the *preference* (D-063). The armed state is still
    // memory-only, so a worker that comes back from eviction cannot sign until
    // something unlocks it again.
    const { handle, area } = build();
    await handle({ type: 'consent.arm' }, 'popup');
    const restarted = new StandingConsent(area);
    expect(restarted.armed).toBe(false);
  });

  it('turning it off sticks, so the next unlock does not quietly turn it back on', async () => {
    const { handle, area } = build();
    await handle({ type: 'consent.disarm' }, 'popup');
    const restarted = new StandingConsent(area);
    expect(await restarted.autoArmEnabled()).toBe(false);
    expect(await restarted.armOnUnlock()).toBe(false);
    expect(restarted.armed).toBe(false);
  });
});

describe('selling a fraction (D-065)', () => {
  // The fake client answers 10^21 for balanceOf, so that is the holding every
  // percentage below is taken from.
  const HELD = 10n ** 21n;
  const sell = (percent?: number) =>
    ({ type: 'trade.request', side: 'sell', token: TOKEN, slippageBps: 100,
       ...(percent !== undefined ? { percent } : {}) }) as never;

  it('takes the fraction of the real balance, computed in integers', async () => {
    const { handle, executed } = build();
    const p = (await handle(sell(25), 'page')) as { ok: true; data: { id: string } };
    await handle({ type: 'trade.approve', id: p.data.id }, 'popup');
    expect(executed[0]?.amount).toBe((HELD / 4n).toString());
  });

  it('100% means every last wei, not very nearly all of it', async () => {
    // Routing this through the same multiply-and-divide would be correct here
    // and wrong on a balance that is not a round number, so 100 short-circuits.
    const { handle, executed } = build();
    const p = (await handle(sell(100), 'page')) as { ok: true; data: { id: string } };
    await handle({ type: 'trade.approve', id: p.data.id }, 'popup');
    expect(executed[0]?.amount).toBe(HELD.toString());
  });

  it('omitting the fraction still means the whole balance', async () => {
    const { handle, executed } = build();
    const p = (await handle(sell(), 'page')) as { ok: true; data: { id: string } };
    await handle({ type: 'trade.approve', id: p.data.id }, 'popup');
    expect(executed[0]?.amount).toBe(HELD.toString());
  });

  it('carries the fraction through approval, so 25% cannot become 100%', async () => {
    // Exactly the shape of D-061: a field dropped between propose and execute
    // silently changes the trade the user agreed to.
    const { handle, executed } = build();
    const p = (await handle(sell(25), 'page')) as { ok: true; data: { id: string } };
    const pending = (await handle({ type: 'trade.pending' }, 'popup')) as { ok: true; data: { request: { percent?: number } } };
    expect(pending.data.request.percent).toBe(25);
    await handle({ type: 'trade.approve', id: p.data.id }, 'popup');
    expect(executed[0]?.amount).toBe((HELD / 4n).toString());
  });

  it('refuses a percentage outside 1–100, and a fractional one', async () => {
    const { handle, executed } = build();
    for (const bad of [0, 101, -5, 12.5, Number.NaN]) {
      const res = (await handle(sell(bad), 'page')) as { ok: false; error: { code: string } };
      expect(res.ok, `percent ${bad}`).toBe(false);
      expect(res.error.code).toBe('BAD_REQUEST');
    }
    expect(executed).toHaveLength(0);
  });

  it('refuses a percentage on a buy', async () => {
    const { handle } = build();
    const res = (await handle(
      { type: 'trade.request', side: 'buy', token: TOKEN, amount: ONE_ETH, percent: 50, slippageBps: 100 } as never,
      'page',
    )) as { ok: false; error: { code: string } };
    expect(res.ok).toBe(false);
  });

  it('refuses an amount and a percentage together rather than picking one', async () => {
    // Two different instructions for one trade. Guessing which was meant is not
    // a thing to do with someone's money.
    const { handle } = build();
    const res = (await handle(
      { type: 'trade.execute', side: 'sell', token: TOKEN, amount: ONE_ETH, percent: 50, slippageBps: 100 } as never,
      'popup',
    )) as { ok: false; error: { code: string; message: string } };
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/either an amount or a percent/);
  });
});

describe('unlocking is the authorisation (D-063)', () => {
  it('arms itself on unlock, with nothing ever having been set', async () => {
    // The instructed default: a wallet that has never been told otherwise
    // auto-approves as soon as it is unlocked.
    const area = memoryArea();
    const consent = new StandingConsent(area);
    expect(await consent.autoArmEnabled()).toBe(true);
    expect(await consent.armOnUnlock()).toBe(true);
    expect(consent.armed).toBe(true);
  });

  it('does not arm on unlock once it has been turned off', async () => {
    const area = memoryArea();
    const consent = new StandingConsent(area);
    await consent.setAutoArm(false);
    expect(await consent.armOnUnlock()).toBe(false);
    expect(consent.armed).toBe(false);
  });

  it('the preference is not reachable through the page-facing settings', async () => {
    // settings.get is page-readable, so a preference living there would tell a
    // hostile site whether this wallet approves without asking — exactly what it
    // would want before choosing how much to propose.
    const { handle, area } = build();
    await handle({ type: 'consent.arm' }, 'popup');
    expect(Object.keys(area.data)).toContain(AUTO_ARM_KEY);
    const res = (await handle({ type: 'settings.get' }, 'page')) as { ok: true; data: object };
    expect(JSON.stringify(res.data)).not.toMatch(/autoArm|armed/i);
  });

  it('locking still drops it, however automatic arming is', async () => {
    const { handle, executed } = build();
    await handle({ type: 'consent.arm' }, 'popup');
    await handle({ type: 'wallet.lock' }, 'popup');
    const res = (await handle(buy(), 'page')) as { ok: true; data: { autoApproved?: boolean } };
    expect(res.data.autoApproved).toBeUndefined();
    expect(executed).toHaveLength(0);
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

describe('multi-wallet (D-070)', () => {
  const PW = 'correct horse battery staple';
  const KEY_A = '0x4c0883a69102937d6231471b5dbb6204fe512961708279a1e0f4dc4c8b0b0f1f' as const;
  const KEY_B = '0x8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f' as const;

  const router = () => {
    const area = memoryArea();
    const session = new KeystoreSession();
    return {
      area,
      session,
      handle: createRouter({ store: new VaultStore(area), session, kdf: TEST_KDF }),
    };
  };

  it('starts as a set of one and grows', async () => {
    const r = router();
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY_A }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    const added = (await r.handle({ type: 'wallet.addAccount', password: PW, privateKey: KEY_B }, 'popup')) as {
      ok: true; data: { accounts: unknown[]; activeIndex: number };
    };
    expect(added.data.accounts).toHaveLength(2);
    // The new wallet becomes active: adding one and then having to go and
    // select it would be a step nobody wants.
    expect(added.data.activeIndex).toBe(1);
  });

  it('switches which account signs, with no password', async () => {
    const r = router();
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY_A }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    await r.handle({ type: 'wallet.addAccount', password: PW, privateKey: KEY_B }, 'popup');
    const second = r.session.address;

    await r.handle({ type: 'wallet.select', index: 0 }, 'popup');
    expect(r.session.address).not.toBe(second);
    expect(r.session.isUnlocked).toBe(true);
  });

  it('unlocking opens every wallet at once, so switching needs nothing', async () => {
    const r = router();
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY_A }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    await r.handle({ type: 'wallet.addAccount', password: PW, privateKey: KEY_B }, 'popup');
    r.session.lock();
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    expect(r.session.addresses).toHaveLength(2);
  });

  it('refuses to add the same wallet twice', async () => {
    const r = router();
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY_A }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    const again = (await r.handle({ type: 'wallet.addAccount', password: PW, privateKey: KEY_A }, 'popup')) as {
      ok: false; error: { code: string };
    };
    expect(again.ok).toBe(false);
    expect(again.error.code).toBe('VAULT_EXISTS');
  });

  it('refuses to add one on a wrong password', async () => {
    const r = router();
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY_A }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    const res = (await r.handle({ type: 'wallet.addAccount', password: 'wrong', privateKey: KEY_B }, 'popup')) as {
      ok: false; error: { code: string };
    };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('BAD_PASSWORD');
  });

  it('refuses an index that does not exist rather than falling back to zero', async () => {
    // Silently signing from a different wallet than the one asked for is the
    // worst outcome available here.
    const r = router();
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY_A }, 'popup');
    const res = (await r.handle({ type: 'wallet.select', index: 7 }, 'popup')) as { ok: false; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('reads a pre-multi-wallet vault as a set of one', async () => {
    // Upgrading must not hide a wallet somebody already has funds in.
    const r = router();
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY_A }, 'popup');
    const stored = r.area.data['hoodini.vaults.v2'] as { vaults: unknown[] };
    // Move it back to the old single-vault shape, as an existing install has it.
    delete r.area.data['hoodini.vaults.v2'];
    r.area.data['hoodini.vault.v1'] = stored.vaults[0];

    const st = (await r.handle({ type: 'wallet.status' }, 'popup')) as { ok: true; data: { hasVault: boolean; accounts: unknown[] } };
    expect(st.data.hasVault).toBe(true);
    expect(st.data.accounts).toHaveLength(1);
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    expect(r.session.isUnlocked).toBe(true);
  });

  it('keeps every multi-wallet message off the page', async () => {
    const r = router();
    for (const type of ['wallet.select', 'wallet.addAccount', 'wallet.rename'] as const) {
      expect(ALLOWED_SURFACES[type]).toEqual(['popup']);
    }
    expect(NEVER_PAGE_ACCESSIBLE).toContain('wallet.select');
    const res = (await r.handle({ type: 'wallet.select', index: 0 }, 'page')) as { ok: false; error: { code: string } };
    expect(res.error.code).toBe('FORBIDDEN');
  });
});
