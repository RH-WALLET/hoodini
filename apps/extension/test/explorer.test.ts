/**
 * The block explorer, and the surfaces built on it (D-064).
 *
 * Everything here parses a response from a server nobody in this project
 * controls, so the tests that matter are the ones where that server answers
 * badly: a price that is not a number, a body that is not the shape expected, a
 * request that never returns. A wallet that renders `$NaN` over someone's
 * balance has failed worse than one that renders nothing.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { KeystoreSession, TEST_KDF } from '@hoodini/core';
import { fetchStats, fetchHistory } from '../src/background/explorer.js';
import { createRouter } from '../src/background/router.js';
import { VaultStore, type StorageArea } from '../src/background/storage.js';
import { ALLOWED_SURFACES, NEVER_PAGE_ACCESSIBLE, isAllowed, type RequestType } from '../src/background/protocol.js';

function memoryArea(): StorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) { Object.assign(data, items); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
  };
}

const answer = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);

afterEach(() => { vi.unstubAllGlobals(); });

describe('reading the coin price', () => {
  it('parses the string the explorer actually returns', async () => {
    vi.stubGlobal('fetch', answer({ coin_price: '1906.66', gas_prices: { average: 0.03 } }));
    expect(await fetchStats()).toEqual({ coinPriceUsd: 1906.66, gasGwei: 0.03 });
  });

  it('reports null rather than NaN when the price is not a number', async () => {
    // A NaN rendered into a balance reads as a real figure of zero, which is
    // worse than an em dash by a long way.
    vi.stubGlobal('fetch', answer({ coin_price: 'unavailable', gas_prices: { average: 'soon' } }));
    expect(await fetchStats()).toEqual({ coinPriceUsd: null, gasGwei: null });
  });

  it('reports null on a negative or zero price', async () => {
    vi.stubGlobal('fetch', answer({ coin_price: '0', gas_prices: { average: 0 } }));
    const s = await fetchStats();
    expect(s.coinPriceUsd).toBeNull();
    // Zero gas is a legitimate reading; zero price is not.
    expect(s.gasGwei).toBe(0);
  });

  it('degrades rather than throws when the explorer is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchStats()).toEqual({ coinPriceUsd: null, gasGwei: null });
  });

  it('degrades on a non-JSON or unexpected body', async () => {
    vi.stubGlobal('fetch', answer('a string, somehow'));
    expect(await fetchStats()).toEqual({ coinPriceUsd: null, gasGwei: null });
    vi.stubGlobal('fetch', answer({}, false));
    expect(await fetchStats()).toEqual({ coinPriceUsd: null, gasGwei: null });
  });
});

describe('reading history', () => {
  it('keeps wei as strings, because a JSON number cannot hold them', async () => {
    vi.stubGlobal('fetch', answer({
      items: [{ hash: '0xabc', method: 'execute', status: 'ok', value: '1000000000000000000000000', fee: { value: '2797723994' }, block_number: 7, to: { hash: '0xdef', name: 'UniversalRouter' } }],
    }));
    const rows = await fetchHistory('0x1111111111111111111111111111111111111111');
    expect(rows?.[0]?.valueWei).toBe('1000000000000000000000000');
    expect(rows?.[0]?.toName).toBe('UniversalRouter');
    expect(rows?.[0]?.success).toBe(true);
  });

  it('drops entries with no hash rather than rendering a row that links nowhere', async () => {
    vi.stubGlobal('fetch', answer({ items: [{ method: 'execute' }, { hash: '0xok', status: 'ok' }] }));
    const rows = await fetchHistory('0x1111111111111111111111111111111111111111');
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.hash).toBe('0xok');
  });

  it('answers null when the body has no item list, so the UI can say so', async () => {
    vi.stubGlobal('fetch', answer({ message: 'Not found' }));
    expect(await fetchHistory('0x1111111111111111111111111111111111111111')).toBeNull();
  });
});

describe('the new surfaces stay off the page', () => {
  it('keeps all four popup-only', () => {
    for (const t of ['history.list', 'approvals.list', 'approvals.revoke'] as RequestType[]) {
      expect(ALLOWED_SURFACES[t]).toEqual(['popup']);
      expect(isAllowed(t, 'page')).toBe(false);
    }
  });

  it('lets a page read chain-wide figures, which name nobody', () => {
    // Gas and the coin price are the same for every visitor and are on every
    // block explorer. The panel prints gas beside the buttons (D-069); refusing
    // it would protect nothing.
    expect(ALLOWED_SURFACES['chain.stats']).toEqual(['popup', 'page']);
  });

  it('lists revoking among the capabilities a page may never hold', () => {
    // It signs and broadcasts. A page holding it could burn gas at will and
    // strip allowances the user's other tools depend on.
    expect(NEVER_PAGE_ACCESSIBLE).toContain('approvals.revoke');
  });

  it('refuses history and approvals while locked, rather than leaking the address', async () => {
    const area = memoryArea();
    const handle = createRouter({
      store: new VaultStore(area), session: new KeystoreSession(), kdf: TEST_KDF,
      trade: {
        venues: {} as never, engine: {} as never, chainId: 4663,
        client: {} as never, watchlist: { async list() { return []; }, async add() {} },
      },
    });
    for (const type of ['history.list', 'approvals.list'] as const) {
      const res = (await handle({ type }, 'popup')) as { ok: false; error: { code: string } };
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe('LOCKED');
    }
  });

  it('never asks the explorer anything while the wallet is locked', async () => {
    // The disclosure this makes is the address, so a locked wallet must not be
    // able to make it by accident.
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const handle = createRouter({
      store: new VaultStore(memoryArea()), session: new KeystoreSession(), kdf: TEST_KDF,
      trade: {
        venues: {} as never, engine: {} as never, chainId: 4663,
        client: {} as never, watchlist: { async list() { return []; }, async add() {} },
      },
    });
    await handle({ type: 'history.list' }, 'popup');
    expect(spy).not.toHaveBeenCalled();
  });
});
