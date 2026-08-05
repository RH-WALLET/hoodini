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
import { PendingTrades, REQUEST_TTL_MS } from '../src/background/pending.js';
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
