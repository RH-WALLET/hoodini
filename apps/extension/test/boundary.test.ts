/**
 * The extension's trust boundary.
 *
 * A content script runs in the page's world, so anything a hostile site can
 * make it send, it will send. These tests assert what a page can and cannot
 * reach — the single most security-relevant behaviour in the extension.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeystoreSession, TEST_KDF } from '@hoodini/core';
import { createRouter } from '../src/background/router.js';
import { VaultStore, VAULT_KEY, type StorageArea } from '../src/background/storage.js';
import {
  ALLOWED_SURFACES,
  NEVER_PAGE_ACCESSIBLE,
  classifySender,
  isAllowed,
  type Request,
  type RequestType,
} from '../src/background/protocol.js';
import manifestExport from '../src/manifest.js';

// defineManifest's return type allows a Promise (for async manifests) and a
// union of MV3 shapes. Ours is a plain literal, so pin the fields these
// assertions read rather than repeating a cast at every line.
const manifest = manifestExport as unknown as {
  permissions?: readonly string[];
  host_permissions?: readonly string[];
  content_security_policy?: { extension_pages?: string };
};

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXT_ID}`;
const PW = 'correct horse battery staple';
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe512961708279a1e0f4dc4c8b0b0f1f' as const;

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

function makeRouter() {
  const area = memoryArea();
  const session = new KeystoreSession();
  const handle = createRouter({ store: new VaultStore(area), session, kdf: TEST_KDF });
  return { handle, area, session };
}

describe('classifySender', () => {
  it('treats a sender with a tab as a page, however it is dressed up', () => {
    // A content script can spoof its url but cannot remove `tab`.
    expect(classifySender({ id: EXT_ID, tab: { id: 3 }, url: ORIGIN + '/popup.html' }, EXT_ID, ORIGIN)).toBe('page');
  });

  it('treats an extension-origin sender with no tab as the popup', () => {
    expect(classifySender({ id: EXT_ID, url: `${ORIGIN}/src/popup/index.html` }, EXT_ID, ORIGIN)).toBe('popup');
  });

  it('rejects a message from a different extension outright', () => {
    expect(classifySender({ id: 'someotherextensionidxxxxxxxxxxxx', url: ORIGIN }, EXT_ID, ORIGIN)).toBeNull();
  });

  it('fails closed on an unrecognised shape', () => {
    expect(classifySender({ id: EXT_ID }, EXT_ID, ORIGIN)).toBe('page');
    expect(classifySender({ id: EXT_ID, url: 'https://evil.example/' }, EXT_ID, ORIGIN)).toBe('page');
  });
});

describe('surface policy', () => {
  it('grants a page exactly one capability: quoting', () => {
    // Pinned as an exact list rather than a count. A page may read a price —
    // that is public chain data and a site button cannot render without it —
    // and may do nothing else. Widening this must be a deliberate edit here,
    // with the reasoning in D-026.
    const pageAllowed = (Object.keys(ALLOWED_SURFACES) as RequestType[]).filter((t) => isAllowed(t, 'page')).sort();
    expect(pageAllowed).toEqual(['trade.quote']);
  });

  it('does not let a page read holdings', () => {
    // A page that could list positions would learn the wallet's contents just
    // by being visited.
    expect(isAllowed('positions.list', 'page')).toBe(false);
    expect(NEVER_PAGE_ACCESSIBLE).toContain('positions.list');
  });

  it('does not let a page spend, even though it may quote', () => {
    // The dangerous adjacency: quote and execute differ by one word. Execute
    // stays popup-only until a confirm sheet exists (D-026).
    expect(isAllowed('trade.quote', 'page')).toBe(true);
    expect(isAllowed('trade.execute', 'page')).toBe(false);
  });

  it.each(NEVER_PAGE_ACCESSIBLE)('never exposes %s to a page', (type) => {
    expect(isAllowed(type, 'page')).toBe(false);
    // Also assert the table itself, so a careless edit to ALLOWED_SURFACES
    // cannot quietly grant one of these.
    expect(ALLOWED_SURFACES[type]).not.toContain('page');
  });

  it('backstop refuses page access even if the policy table wrongly grants it', () => {
    // The scenario this exists for: someone adds 'page' to a sensitive entry
    // while wiring up P2c. The table alone would allow it; the backstop must
    // not. Without this the backstop could be deleted with no test failing.
    const sabotaged = {
      ...ALLOWED_SURFACES,
      'wallet.unlock': ['popup', 'page'] as const,
      'wallet.export': ['popup', 'page'] as const,
    } as Readonly<Record<RequestType, readonly ('popup' | 'page')[]>>;
    expect(isAllowed('wallet.unlock', 'page', sabotaged)).toBe(false);
    expect(isAllowed('wallet.export', 'page', sabotaged)).toBe(false);
    // A non-sensitive entry is still governed by the table, so the backstop is
    // narrow rather than a blanket denial that would mask policy mistakes.
    expect(isAllowed('wallet.status', 'page', { ...sabotaged, 'wallet.status': ['popup', 'page'] })).toBe(true);
  });

  it('keeps every declared message reachable from the popup', () => {
    for (const type of Object.keys(ALLOWED_SURFACES) as RequestType[]) {
      expect(isAllowed(type, 'popup')).toBe(true);
    }
  });
});

describe('router enforcement', () => {
  let r: ReturnType<typeof makeRouter>;
  beforeEach(() => {
    r = makeRouter();
  });

  it('refuses everything from an unrecognised sender', async () => {
    const res = await r.handle({ type: 'wallet.status' }, null);
    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('refuses a page trying to unlock, even with the right password', async () => {
    await r.handle({ type: 'wallet.create', password: PW }, 'popup');
    const res = await r.handle({ type: 'wallet.unlock', password: PW }, 'page');
    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(r.session.isUnlocked).toBe(false);
  });

  it('refuses a page trying to export, even while unlocked', async () => {
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    expect(r.session.isUnlocked).toBe(true);
    const res = await r.handle({ type: 'wallet.export', password: PW }, 'page');
    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(res)).not.toContain(KEY.slice(2));
  });

  it('rejects a malformed message rather than throwing', async () => {
    const res = await r.handle({} as Request, 'popup');
    expect(res).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });
});

describe('wallet lifecycle', () => {
  let r: ReturnType<typeof makeRouter>;
  beforeEach(() => {
    r = makeRouter();
  });

  it('creates, persists, unlocks and locks', async () => {
    const created = await r.handle({ type: 'wallet.create', password: PW }, 'popup');
    expect(created.ok).toBe(true);
    expect(r.area.data[VAULT_KEY]).toBeDefined();

    const before = await r.handle({ type: 'wallet.status' }, 'popup');
    expect(before).toMatchObject({ ok: true, data: { hasVault: true, isUnlocked: false } });

    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    expect(r.session.isUnlocked).toBe(true);

    await r.handle({ type: 'wallet.lock' }, 'popup');
    expect(r.session.isUnlocked).toBe(false);
  });

  it('never writes a plaintext key to storage', async () => {
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY }, 'popup');
    const dumped = JSON.stringify(r.area.data).toLowerCase();
    expect(dumped).not.toContain(KEY.slice(2).toLowerCase());
    expect(dumped).not.toContain(PW.toLowerCase());
  });

  it('refuses to overwrite an existing wallet', async () => {
    await r.handle({ type: 'wallet.create', password: PW }, 'popup');
    const second = await r.handle({ type: 'wallet.create', password: 'another password' }, 'popup');
    // Overwriting would strand any funds on the previous key.
    expect(second).toMatchObject({ ok: false, error: { code: 'VAULT_EXISTS' } });
  });

  it('reports a wrong unlock password without unlocking', async () => {
    await r.handle({ type: 'wallet.create', password: PW }, 'popup');
    const res = await r.handle({ type: 'wallet.unlock', password: 'wrong password' }, 'popup');
    expect(res).toMatchObject({ ok: false, error: { code: 'BAD_PASSWORD' } });
    expect(r.session.isUnlocked).toBe(false);
  });

  it('requires the password to export even when already unlocked', async () => {
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    const bad = await r.handle({ type: 'wallet.export', password: 'nope nope nope' }, 'popup');
    expect(bad).toMatchObject({ ok: false, error: { code: 'BAD_PASSWORD' } });
    const good = await r.handle({ type: 'wallet.export', password: PW }, 'popup');
    expect(good).toMatchObject({ ok: true, data: { privateKey: KEY } });
  });

  it('requires the password to reset, and locks before clearing', async () => {
    await r.handle({ type: 'wallet.create', password: PW }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');

    const denied = await r.handle({ type: 'wallet.reset', password: 'guessing' }, 'popup');
    expect(denied).toMatchObject({ ok: false, error: { code: 'BAD_PASSWORD' } });
    expect(r.area.data[VAULT_KEY]).toBeDefined();

    const ok = await r.handle({ type: 'wallet.reset', password: PW }, 'popup');
    expect(ok.ok).toBe(true);
    expect(r.area.data[VAULT_KEY]).toBeUndefined();
    expect(r.session.isUnlocked).toBe(false);
  });

  it('changing the password re-locks so the stale session cannot be reused', async () => {
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    await r.handle({ type: 'wallet.changePassword', currentPassword: PW, newPassword: 'a whole new password' }, 'popup');
    expect(r.session.isUnlocked).toBe(false);
    const res = await r.handle({ type: 'wallet.unlock', password: 'a whole new password' }, 'popup');
    expect(res.ok).toBe(true);
  });

  it('treats a half-written vault record as no wallet', async () => {
    r.area.data[VAULT_KEY] = { version: 1, address: '0x1' }; // truncated
    const res = await r.handle({ type: 'wallet.status' }, 'popup');
    // Better to report "no wallet" than to surface a decrypt failure the user
    // would read as a wrong password.
    expect(res).toMatchObject({ ok: true, data: { hasVault: false } });
  });
});

describe('manifest — invariant 3 is checkable from the shipped file', () => {
  it('requests only the storage permission', () => {
    expect(manifest.permissions).toEqual(['storage']);
  });

  it('requests no broad host access', () => {
    for (const host of manifest.host_permissions ?? []) {
      expect(host).not.toMatch(/<all_urls>|\*:\/\/\*\//);
    }
    expect(manifest.host_permissions).toEqual(['https://rpc.mainnet.chain.robinhood.com/*']);
  });

  it('forbids remote and eval-able code in its CSP', () => {
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('wasm-unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*https?:/);
  });

  it('lists each content-script host explicitly, with no wildcards', () => {
    const m = manifestExport as unknown as { content_scripts?: { matches?: string[] }[] };
    const matches = m.content_scripts?.[0]?.matches ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const pattern of matches) {
      // The match list is the clearest statement of where this extension can
      // read. No <all_urls>, no scheme wildcard, no wildcard TLD.
      expect(pattern).not.toContain('<all_urls>');
      expect(pattern).not.toMatch(/^\*:/);
      expect(pattern).not.toMatch(/\*\.\*/);
      expect(pattern).toMatch(/^https:\/\/[a-z0-9.-]+\/\*$/);
    }
  });

  it('reads only the sites it claims to support', () => {
    const m = manifestExport as unknown as { content_scripts?: { matches?: string[] }[] };
    const hosts = (m.content_scripts?.[0]?.matches ?? []).map((p) => new URL(p.replace('/*', '/')).hostname);
    expect(hosts.sort()).toEqual(['axiom.trade', 'dexscreener.com', 'web.telegram.org', 'www.x.com', 'x.com']);
  });

  it('never requests a permission that would let it read browsing activity', () => {
    const forbidden = ['tabs', 'webRequest', 'cookies', 'history', 'downloads', 'debugger', 'management'];
    for (const p of forbidden) expect(manifest.permissions ?? []).not.toContain(p);
  });
});

// ── P5 hardening: properties of the SHIPPED bundle ──────────────────────────

describe('hardening — the built artifact, not just the source', () => {
  const dist = resolve(fileURLToPath(import.meta.url), '../../dist');
  const built = existsSync(dist);

  // Skips rather than fails when dist is absent: `pnpm test` must not require a
  // build, but when a build exists it gets checked.
  const whenBuilt = built ? it : it.skip;

  whenBuilt('ships no eval or dynamic code construction', () => {
    for (const f of readdirSync(resolve(dist, 'assets')).filter((f) => f.endsWith('.js'))) {
      const js = readFileSync(resolve(dist, 'assets', f), 'utf8');
      expect(js, f).not.toMatch(/\beval\s*\(/);
      expect(js, f).not.toMatch(/new Function\s*\(/);
    }
  });

  whenBuilt('ships no analytics or crash reporting', () => {
    // PRIVACY.md promises none; this is what makes that checkable.
    for (const f of readdirSync(resolve(dist, 'assets')).filter((f) => f.endsWith('.js'))) {
      const js = readFileSync(resolve(dist, 'assets', f), 'utf8');
      expect(js, f).not.toMatch(/google-analytics|googletagmanager|sentry\.io|mixpanel|amplitude|posthog/i);
    }
  });

  whenBuilt('the page-facing content script contains no innerHTML sink', () => {
    // The popup bundle contains React, which uses innerHTML internally. The
    // content script runs in a hostile page and must not.
    const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8')) as {
      content_scripts: { js: string[] }[];
    };
    for (const js of manifest.content_scripts.flatMap((c) => c.js)) {
      expect(readFileSync(resolve(dist, js), 'utf8')).not.toMatch(/innerHTML/);
    }
  });

  whenBuilt('the built manifest matches the source manifest', () => {
    const shipped = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8')) as {
      permissions: string[];
      host_permissions: string[];
      content_security_policy: { extension_pages: string };
    };
    // The build step could in principle rewrite these; assert on what actually
    // ships, since that is what a user installs.
    expect(shipped.permissions).toEqual(['storage']);
    expect(shipped.host_permissions).toEqual(['https://rpc.mainnet.chain.robinhood.com/*']);
    expect(shipped.content_security_policy.extension_pages).not.toContain('unsafe-eval');
  });
});

// ── trade.quote (D-049) ─────────────────────────────────────────────────────

describe('trade.quote — the sell-availability probe', () => {
  const TOKEN = '0xB84e494158976B4e14da155d1cdaE16EB6D1C477';

  /** A router wired with a stub venue whose sell behaviour is configurable. */
  function withTrade(opts: { sellThrows?: string; balance?: bigint } = {}) {
    const area = memoryArea();
    const session = new KeystoreSession();
    const quote = (amountIn: bigint) => ({
      venueId: 'uniswap-v3', state: 'graduated', amountIn, amountOut: 42n,
      priceImpactBps: null, quoteAsset: null, feeBps: 100, source: 'simulation',
    });
    const adapter = {
      id: 'uniswap-v3',
      async quoteBuy(_t: unknown, a: bigint) { return quote(a); },
      async quoteSell(_t: unknown, a: bigint) {
        if (opts.sellThrows) throw new Error(opts.sellThrows);
        return quote(a);
      },
    };
    const handle = createRouter({
      store: new VaultStore(area), session, kdf: TEST_KDF,
      trade: {
        venues: { resolve: async () => ({ adapter, via: 'registry' }) } as never,
        engine: {} as never,
        chainId: 4663,
        client: { async readContract() { return opts.balance ?? 0n; } } as never,
        watchlist: { async list() { return []; }, async add() {} },
      },
    });
    return { handle, session, area };
  }

  it('quotes a buy without unlocking — a page must be able to show a price', async () => {
    const r = withTrade();
    const res = await r.handle({ type: 'trade.quote', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 }, 'page');
    expect(res).toMatchObject({ ok: true, data: { venueId: 'uniswap-v3', amountOut: '42' } });
  });

  it('returns no calldata to a page', async () => {
    const r = withTrade();
    const res = await r.handle({ type: 'trade.quote', side: 'buy', token: TOKEN, amount: '1000', slippageBps: 100 }, 'page');
    expect(JSON.stringify(res)).not.toMatch(/"data":"0x|calldata/);
  });

  it('reports a reverting sell as an error, which is what gates the button', async () => {
    // If this silently succeeded, the overlay would render a Sell control that
    // always fails (D-049).
    const r = withTrade({ sellThrows: 'execution reverted: arithmetic underflow', balance: 5n });
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    const res = await r.handle({ type: 'trade.quote', side: 'sell', token: TOKEN, slippageBps: 100 }, 'page');
    expect(res.ok).toBe(false);
  });

  it('quotes the WHOLE balance when amount is omitted', async () => {
    // Sell availability is size-dependent, so the probe must price what would
    // actually be sold rather than a nominal amount.
    const r = withTrade({ balance: 7_777n });
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    const res = await r.handle({ type: 'trade.quote', side: 'sell', token: TOKEN, slippageBps: 100 }, 'page');
    expect(res).toMatchObject({ ok: true, data: { amountIn: '7777' } });
  });

  it('says LOCKED when a whole-balance sell probe needs the account', async () => {
    const r = withTrade({ balance: 10n });
    const res = await r.handle({ type: 'trade.quote', side: 'sell', token: TOKEN, slippageBps: 100 }, 'page');
    expect(res).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
  });

  it('says NO_BALANCE rather than quoting zero', async () => {
    const r = withTrade({ balance: 0n });
    await r.handle({ type: 'wallet.import', password: PW, privateKey: KEY }, 'popup');
    await r.handle({ type: 'wallet.unlock', password: PW }, 'popup');
    const res = await r.handle({ type: 'trade.quote', side: 'sell', token: TOKEN, slippageBps: 100 }, 'page');
    expect(res).toMatchObject({ ok: false, error: { code: 'NO_BALANCE' } });
  });

  it('still refuses trade.execute from a page', async () => {
    const r = withTrade();
    const res = await r.handle({ type: 'trade.execute', side: 'buy', token: TOKEN, amount: '1', slippageBps: 100 }, 'page');
    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
