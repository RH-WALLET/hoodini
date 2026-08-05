/**
 * Pending trade requests — the confirmation D-026 required.
 *
 * The tests worth having here are not "a request can be made". They are the
 * ones about what a hostile page can do with the mechanism: swap what you are
 * looking at, get you to approve twice, keep a stale proposal alive, or name
 * an origin that is not its own.
 */

import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { KeystoreSession, TEST_KDF } from '@hoodini/core';
import { PendingTrades, REQUEST_TTL_MS, type TradeRequest } from '../src/background/pending.js';
import { createRouter } from '../src/background/router.js';
import { VaultStore, type StorageArea } from '../src/background/storage.js';

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
import { senderOrigin, isAllowed, NEVER_PAGE_ACCESSIBLE } from '../src/background/protocol.js';

const TOKEN = getAddress('0x5dbaca8327b0baa57eb6c872a333bf8d6f642ba3');
const OTHER = getAddress('0x297b94b8615b56bf902a776b979cc5b5104c0a9e');

function proposal(token = TOKEN) {
  return { side: 'buy' as const, token, amount: '1000000000000000', slippageBps: 100, origin: 'https://axiom.trade' };
}

function fixedClock(start = 1_000) {
  let now = start;
  let n = 0;
  return {
    trades: new PendingTrades({ now: () => now, id: () => `req-${++n}` }),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('surface policy', () => {
  it('lets a page propose but never approve, reject, or read what is pending', () => {
    // Proposing moves nothing. Everything on the user's side of the
    // conversation stays out of a page's reach, or the prompt is theatre.
    expect(isAllowed('trade.request', 'page')).toBe(true);
    expect(isAllowed('trade.approve', 'page')).toBe(false);
    expect(isAllowed('trade.reject', 'page')).toBe(false);
    expect(isAllowed('trade.pending', 'page')).toBe(false);
    for (const t of ['trade.approve', 'trade.reject', 'trade.pending'] as const) {
      expect(NEVER_PAGE_ACCESSIBLE).toContain(t);
    }
  });

  it('still refuses a page trade.execute, which is the point of all this', () => {
    expect(isAllowed('trade.execute', 'page')).toBe(false);
  });
});

describe('senderOrigin', () => {
  it('reduces a page URL to its origin', () => {
    expect(senderOrigin({ url: 'https://axiom.trade/pulse?chain=sol' })).toBe('https://axiom.trade');
  });

  it('returns null rather than guessing when there is no usable URL', () => {
    expect(senderOrigin({})).toBeNull();
    expect(senderOrigin({ url: 'not a url' })).toBeNull();
  });
});

describe('PendingTrades', () => {
  it('records a proposal and hands back an id', () => {
    const { trades } = fixedClock();
    const r = trades.propose(proposal());
    expect(r?.id).toBe('req-1');
    expect(trades.peek()?.token).toBe(TOKEN);
  });

  it('refuses a second proposal rather than substituting it', () => {
    // The classic attack on a confirmation dialog: the user reads request A,
    // reaches for approve, and the page swaps in B a moment before the click.
    // Refusing means what is on screen stays what was asked for.
    const { trades } = fixedClock();
    trades.propose(proposal(TOKEN));
    expect(trades.propose(proposal(OTHER))).toBeNull();
    expect(trades.peek()?.token).toBe(TOKEN);
  });

  it('lets a new proposal in once the first is answered', () => {
    const { trades } = fixedClock();
    const first = trades.propose(proposal(TOKEN))!;
    trades.take(first.id);
    expect(trades.propose(proposal(OTHER))?.token).toBe(OTHER);
  });

  it('expires an unanswered proposal', () => {
    // Left overnight it is a click waiting to happen against a price that no
    // longer exists.
    const { trades, advance } = fixedClock();
    trades.propose(proposal());
    advance(REQUEST_TTL_MS - 1);
    expect(trades.peek()).not.toBeNull();
    advance(1);
    expect(trades.peek()).toBeNull();
  });

  it('refuses to hand over an expired proposal for approval', () => {
    const { trades, advance } = fixedClock();
    const r = trades.propose(proposal())!;
    advance(REQUEST_TTL_MS);
    expect(trades.take(r.id)).toBeNull();
  });

  it('an expired proposal frees the slot for a new one', () => {
    const { trades, advance } = fixedClock();
    trades.propose(proposal(TOKEN));
    advance(REQUEST_TTL_MS);
    expect(trades.propose(proposal(OTHER))?.token).toBe(OTHER);
  });

  it('is single use, so a double click cannot spend twice', () => {
    // Consumed before the trade runs, not after. If the trade then fails the
    // user proposes again — a far better failure than a second send.
    const { trades } = fixedClock();
    const r = trades.propose(proposal())!;
    expect(trades.take(r.id)).not.toBeNull();
    expect(trades.take(r.id)).toBeNull();
  });

  it('refuses an id that was never issued', () => {
    const { trades } = fixedClock();
    trades.propose(proposal());
    expect(trades.take('req-999')).toBeNull();
    // And the real one is still waiting — a wrong guess must not consume it.
    expect(trades.peek()).not.toBeNull();
  });

  it('clears on rejection', () => {
    const { trades } = fixedClock();
    trades.propose(proposal());
    trades.clear();
    expect(trades.peek()).toBeNull();
  });

  it('keeps the origin it was given, since the caller takes it from the sender', () => {
    const { trades } = fixedClock();
    expect(trades.propose(proposal())?.origin).toBe('https://axiom.trade');
  });
});

// ── through the router ──────────────────────────────────────────────────────

describe('request → approve, through the router', () => {
  function router() {
    const area = memoryArea();
    const session = new KeystoreSession();
    const pending = new PendingTrades({ id: () => 'req-1' });
    const changes: (TradeRequest | null)[] = [];
    const handle = createRouter({
      store: new VaultStore(area),
      session,
      kdf: TEST_KDF,
      pending,
      onPendingChange: (r) => changes.push(r),
      // Enough of a trade stack to get past the "is trading wired up" guard.
      // Approval is refused before any of it is touched in these tests, which
      // is the point — a locked wallet must not cost the user their request.
      trade: {} as never,
    });
    return { handle, pending, changes };
  }

  it('records a proposal from a page and reports the id', async () => {
    const { handle } = router();
    const res = await handle(
      { type: 'trade.request', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 },
      'page',
      'https://axiom.trade',
    );
    expect(res).toEqual({ ok: true, data: { id: 'req-1' } });
  });

  it('takes the origin from the sender, not the message', async () => {
    // A page naming its own origin could name someone else's, and the only
    // value in showing it is that it cannot be forged.
    const { handle } = router();
    await handle(
      { type: 'trade.request', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 },
      'page',
      'https://axiom.trade',
    );
    const res = (await handle({ type: 'trade.pending' }, 'popup')) as { ok: true; data: { request: TradeRequest } };
    expect(res.data.request.origin).toBe('https://axiom.trade');
  });

  it('refuses a second proposal while one waits', async () => {
    const { handle } = router();
    const req = { type: 'trade.request', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 } as const;
    await handle(req, 'page', 'https://axiom.trade');
    const second = (await handle(req, 'page', 'https://evil.example')) as { ok: false; error: { code: string } };
    expect(second.ok).toBe(false);
    expect(second.error.code).toBe('PENDING_EXISTS');
  });

  it('rejects a buy with no amount, and a non-numeric one', async () => {
    const { handle } = router();
    for (const bad of [undefined, '0.5', '-1', '1e18', 'lots']) {
      const res = (await handle(
        { type: 'trade.request', side: 'buy', token: TOKEN, ...(bad !== undefined ? { amount: bad } : {}), slippageBps: 100 },
        'page',
        'https://axiom.trade',
      )) as { ok: false; error: { code: string } };
      expect(res.ok, `amount ${String(bad)} should be refused`).toBe(false);
      expect(res.error.code).toBe('BAD_REQUEST');
    }
  });

  it('rejects a token that is not an address', async () => {
    const { handle } = router();
    const res = (await handle(
      { type: 'trade.request', side: 'buy', token: 'not-an-address' as never, amount: '1000', slippageBps: 100 },
      'page',
      'https://axiom.trade',
    )) as { ok: false; error: { code: string } };
    expect(res.error.code).toBe('BAD_REQUEST');
  });

  it('announces the request appearing and clearing, for the badge', async () => {
    const { handle, changes } = router();
    await handle(
      { type: 'trade.request', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 },
      'page',
      'https://axiom.trade',
    );
    await handle({ type: 'trade.reject' }, 'popup');
    expect(changes.map((c) => (c ? 'set' : 'cleared'))).toEqual(['set', 'cleared']);
  });

  it('refuses to approve an id that is not the pending one', async () => {
    const { handle } = router();
    await handle(
      { type: 'trade.request', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 },
      'page',
      'https://axiom.trade',
    );
    const res = (await handle({ type: 'trade.approve', id: 'someone-elses' }, 'popup')) as {
      ok: false;
      error: { code: string };
    };
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('keeps the request when approval fails for a reason the user can fix', async () => {
    // An earlier version consumed before checking the lock, so clicking
    // Approve while locked destroyed the thing being approved — you unlocked
    // to find nothing there.
    const { handle } = router();
    await handle(
      { type: 'trade.request', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 },
      'page',
      'https://axiom.trade',
    );
    const first = (await handle({ type: 'trade.approve', id: 'req-1' }, 'popup')) as { ok: false; error: { code: string } };
    expect(first.error.code).toBe('LOCKED');

    const still = (await handle({ type: 'trade.pending' }, 'popup')) as { ok: true; data: { request: unknown } };
    expect(still.data.request, 'the request must survive a locked approval').not.toBeNull();
  });

  it('a page cannot read, approve or reject what is pending', async () => {
    const { handle } = router();
    await handle(
      { type: 'trade.request', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 },
      'page',
      'https://axiom.trade',
    );
    for (const msg of [{ type: 'trade.pending' }, { type: 'trade.approve', id: 'req-1' }, { type: 'trade.reject' }] as const) {
      const res = (await handle(msg, 'page')) as { ok: false; error: { code: string } };
      expect(res.ok, `${msg.type} must not be page-reachable`).toBe(false);
      expect(res.error.code).toBe('FORBIDDEN');
    }
    // And the request is untouched by the attempts.
    const still = (await handle({ type: 'trade.pending' }, 'popup')) as { ok: true; data: { request: unknown } };
    expect(still.data.request).not.toBeNull();
  });
});

describe('the two things a page must not be able to do', () => {
  async function unlockedRouter() {
    const area = memoryArea();
    const session = new KeystoreSession();
    const pending = new PendingTrades({ id: () => 'req-1' });
    const handle = createRouter({
      store: new VaultStore(area),
      session,
      kdf: TEST_KDF,
      pending,
      trade: {} as never,
    });
    await handle({ type: 'wallet.create', password: 'correct horse battery staple' }, 'popup');
    await handle({ type: 'wallet.unlock', password: 'correct horse battery staple' }, 'popup');
    return { handle };
  }

  it('ignores an origin the message tries to supply', async () => {
    // The confirmation's only value is that the site name cannot be forged. A
    // page claiming to be axiom.trade must not be shown as axiom.trade.
    const { handle } = await unlockedRouter();
    await handle(
      {
        type: 'trade.request',
        side: 'buy',
        token: TOKEN,
        amount: '1000',
        slippageBps: 100,
        // A hostile page's best attempt.
        origin: 'https://axiom.trade',
      } as never,
      'page',
      'https://evil.example',
    );
    const res = (await handle({ type: 'trade.pending' }, 'popup')) as { ok: true; data: { request: TradeRequest } };
    expect(res.data.request.origin).toBe('https://evil.example');
  });

  it('consumes the request on approval, so a second click cannot re-run it', async () => {
    // The stubbed trade stack makes execution fail, which is fine — what
    // matters is that the request is gone by then. Consuming after a
    // successful send would leave a window where a duplicated message spends
    // twice.
    const { handle } = await unlockedRouter();
    await handle(
      { type: 'trade.request', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 },
      'page',
      'https://axiom.trade',
    );
    await handle({ type: 'trade.approve', id: 'req-1' }, 'popup');

    const after = (await handle({ type: 'trade.pending' }, 'popup')) as { ok: true; data: { request: unknown } };
    expect(after.data.request, 'approval must consume the request').toBeNull();

    const again = (await handle({ type: 'trade.approve', id: 'req-1' }, 'popup')) as {
      ok: false;
      error: { code: string };
    };
    expect(again.error.code).toBe('NOT_FOUND');
  });
});
