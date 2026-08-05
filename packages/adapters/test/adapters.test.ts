/**
 * Site adapters, against jsdom.
 *
 * The fixtures deliberately imitate the awkward parts of a real terminal —
 * addresses hidden in attributes, virtualised rows recycled for a different
 * token, repeated re-renders — because those are the cases that break an
 * overlay, not the tidy ones.
 */

import { describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { addressesInText, detectTokensIn, nearestRow, elementsFor } from '../src/detect.js';
import { mountOverlay, unmountAll, HOST_ATTR, TOKEN_ATTR } from '../src/overlay.js';
import { AdapterRuntime, matchesSite } from '../src/runtime.js';
import { GenericAddressAdapter } from '../src/adapters/generic.js';
import type { OverlayIntent } from '../src/overlay.js';
import type { TokenRef } from '@hoodini/core';

const A = getAddress('0xb84e494158976b4e14da155d1cdae16eb6d1c477');
const B = getAddress('0x8b18800b8d7991aeaf8a7d8f10d34f06ea811ba3');
const CHAIN = 4663;

function listPage(tokens: string[] = [A, B]): Document {
  document.body.innerHTML = `
    <header><span>Final Stretch</span></header>
    <div class="list">
      ${tokens
        .map(
          (t, i) => `
        <div class="row">
          <a href="/token/${t}">TOK${i}</a>
          <span class="mc">$${i}2.3K</span>
          <span class="vol">$${i}1.1K vol · 24h change +${i}2%</span>
          <button class="page-btn">Trade</button>
        </div>`,
        )
        .join('')}
    </div>`;
  return document;
}

describe('addressesInText', () => {
  it('finds a plain address', () => {
    expect(addressesInText(`buy ${A} now`)).toEqual([A]);
  });

  it('deduplicates regardless of case', () => {
    expect(addressesInText(`${A} ${A.toLowerCase()} ${A.toUpperCase()}`)).toHaveLength(1);
  });

  it('drops the zero and burn addresses', () => {
    const zero = '0x0000000000000000000000000000000000000000';
    const dead = '0x000000000000000000000000000000000000dEaD';
    expect(addressesInText(`${zero} ${dead}`)).toEqual([]);
  });

  it('rejects a mixed-case address whose checksum is wrong', () => {
    // A page asserting a checksum that does not verify is a typo or a spoof;
    // silently lower-casing it would decorate an attacker's address.
    const body = A.slice(2);
    const i = [...body].findIndex((c) => /[a-fA-F]/.test(c));
    const c = body[i]!;
    const broken = `0x${body.slice(0, i)}${c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()}${body.slice(i + 1)}`;

    // Self-checks, so this cannot quietly become vacuous: the input must be
    // mixed case (i.e. actually asserting a checksum) and must differ from A.
    expect(/[a-f]/.test(broken.slice(2)) && /[A-F]/.test(broken.slice(2))).toBe(true);
    expect(broken).not.toBe(A);

    // Rejected outright — not "returns something other than the input", which
    // would pass even if the bad checksum were accepted and normalised.
    expect(addressesInText(broken)).toEqual([]);
  });

  it('accepts an all-lowercase address, which asserts no checksum', () => {
    expect(addressesInText(A.toLowerCase())).toEqual([A]);
  });

  it('ignores hex that is the wrong length', () => {
    expect(addressesInText('0xdeadbeef and 0x' + 'a'.repeat(41))).toEqual([]);
  });
});

describe('detectTokensIn', () => {
  it('finds addresses that only appear in attributes', () => {
    const doc = listPage();
    const tokens = detectTokensIn(doc, { chainId: CHAIN });
    // The fixture puts them in href only — visible text is just "TOK0".
    expect(tokens.map((t) => t.address).sort()).toEqual([A, B].sort());
    expect(tokens[0]?.chainId).toBe(CHAIN);
  });

  it('respects the limit so a huge page cannot stall a scan', () => {
    const many = Array.from({ length: 40 }, (_, i) => getAddress('0x' + (i + 1).toString(16).padStart(40, '0')));
    document.body.innerHTML = many.map((a) => `<div>${a}</div>`).join('');
    expect(detectTokensIn(document, { chainId: CHAIN, limit: 10 })).toHaveLength(10);
  });
});

describe('nearestRow', () => {
  it('walks up from the address node to the repeating row', () => {
    const doc = listPage([A, B, A]);
    const link = doc.querySelector('a')!;
    const row = nearestRow(link);
    expect(row.className).toBe('row');
  });

  it('does not climb past the row into the container', () => {
    const doc = listPage([A, B, A]);
    const row = nearestRow(doc.querySelector('a')!);
    expect(row.classList.contains('list')).toBe(false);
  });
});

describe('mountOverlay', () => {
  const noop = () => {};

  it('renders into a shadow root so page CSS cannot reach it', () => {
    const doc = listPage();
    const row = doc.querySelector('.row')!;
    const host = mountOverlay(row, { address: A, chainId: CHAIN }, { onIntent: noop });
    expect(host.shadowRoot).not.toBeNull();
    // Nothing of ours is in the light DOM, so a page stylesheet has no handle.
    expect(row.querySelector('button.sell')).toBeNull();
    expect(host.shadowRoot!.querySelector('button.sell')).not.toBeNull();
  });

  it('is idempotent — remounting the same token does not duplicate', () => {
    const doc = listPage();
    const row = doc.querySelector('.row')!;
    const first = mountOverlay(row, { address: A, chainId: CHAIN }, { onIntent: noop });
    const second = mountOverlay(row, { address: A, chainId: CHAIN }, { onIntent: noop });
    expect(second).toBe(first);
    expect(row.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });

  it('rebinds when a virtualised row is recycled for a different token', () => {
    // The failure this prevents: a recycled row keeps the previous token's
    // buttons, so a click buys something the user is no longer looking at.
    const doc = listPage();
    const row = doc.querySelector('.row')!;
    mountOverlay(row, { address: A, chainId: CHAIN }, { onIntent: noop });
    mountOverlay(row, { address: B, chainId: CHAIN }, { onIntent: noop });
    const hosts = row.querySelectorAll(`[${HOST_ATTR}]`);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.getAttribute(TOKEN_ATTR)).toBe(B.toLowerCase());
  });

  it('emits a buy intent carrying the token it is bound to', () => {
    const doc = listPage();
    const row = doc.querySelector('.row')!;
    const seen: OverlayIntent[] = [];
    const host = mountOverlay(row, { address: A, chainId: CHAIN }, { onIntent: (i) => seen.push(i) });
    (host.shadowRoot!.querySelector('button') as HTMLButtonElement).click();
    expect(seen).toEqual([{ side: 'buy', token: { address: A, chainId: CHAIN }, amount: '0.001' }]);
  });

  it.each(['button', 'button.sell'])('stops a %s click reaching the page underneath', (selector) => {
    // Both controls, not just one: the buy and sell handlers are separate code
    // paths, and testing only sell left the buy path unguarded.
    const doc = listPage();
    const row = doc.querySelector('.row')! as HTMLElement;
    const pageHandler = vi.fn();
    row.addEventListener('click', pageHandler);
    const host = mountOverlay(row, { address: A, chainId: CHAIN }, { onIntent: noop });
    (host.shadowRoot!.querySelector(selector) as HTMLButtonElement).click();
    // Otherwise trading would also fire the terminal's own row action.
    expect(pageHandler).not.toHaveBeenCalled();
  });

  it('unmountAll leaves the page exactly as it was', () => {
    const doc = listPage();
    const before = doc.body.innerHTML;
    doc.querySelectorAll('.row').forEach((r) => mountOverlay(r, { address: A, chainId: CHAIN }, { onIntent: noop }));
    expect(doc.body.innerHTML).not.toBe(before);
    unmountAll(doc);
    expect(doc.body.innerHTML).toBe(before);
  });
});

describe('GenericAddressAdapter', () => {
  const make = (onIntent = () => {}) => new GenericAddressAdapter({ chainId: CHAIN, onIntent });

  it('decorates every row that carries an address', () => {
    const doc = listPage([A, B]);
    const a = make();
    let mounted = 0;
    for (const token of a.detectTokens(doc)) {
      for (const anchor of a.findAnchors(token)) {
        a.mount(anchor, token);
        mounted++;
      }
    }
    expect(mounted).toBeGreaterThanOrEqual(2);
    expect(doc.querySelectorAll(`[${HOST_ATTR}]`).length).toBeGreaterThanOrEqual(2);
  });

  it('never anchors inside its own control', () => {
    const doc = listPage([A]);
    const a = make();
    // Two full passes: the second sees the DOM the first one produced.
    for (let i = 0; i < 2; i++) {
      for (const token of a.detectTokens(doc)) for (const anchor of a.findAnchors(token)) a.mount(anchor, token);
    }
    for (const host of doc.querySelectorAll(`[${HOST_ATTR}]`)) {
      expect(host.querySelector(`[${HOST_ATTR}]`)).toBeNull();
    }
  });
});

describe('AdapterRuntime', () => {
  it('coalesces a burst of mutations into a single rescan', () => {
    const doc = listPage([A]);
    let fire: (() => void) | null = null;
    let timer: (() => void) | null = null;
    const runtime = new AdapterRuntime(new GenericAddressAdapter({ chainId: CHAIN, onIntent: () => {} }), doc, {
      observe: (_t, cb) => {
        fire = cb;
        return { disconnect: () => {} };
      },
      setTimer: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimer: () => {
        timer = null;
      },
    });

    runtime.start();
    expect(runtime.scanCount).toBe(1); // the initial scan

    // Ten mutations in one burst must not mean ten scans, or an SPA would peg
    // the main thread.
    for (let i = 0; i < 10; i++) fire!();
    expect(runtime.scanCount).toBe(1);
    timer!();
    expect(runtime.scanCount).toBe(2);
  });

  it('keeps going when one row throws', () => {
    const doc = listPage([A, B]);
    const onError = vi.fn();
    let calls = 0;
    const flaky = {
      id: 'flaky',
      siteMatch: new URLPattern({ protocol: 'https' }),
      detectTokens: () => [
        { address: A, chainId: CHAIN },
        { address: B, chainId: CHAIN },
      ],
      findAnchors: () => {
        if (++calls === 1) throw new Error('bad row');
        return [doc.querySelector('.row')!];
      },
      mount: () => {},
    };
    const runtime = new AdapterRuntime(flaky, doc, { onError });
    const mounted = runtime.scan();
    expect(onError).toHaveBeenCalledTimes(1);
    // The second token still got decorated despite the first throwing.
    expect(mounted).toBe(1);
  });

  it('stop() detaches the observer and cancels pending work', () => {
    const doc = listPage([A]);
    const disconnect = vi.fn();
    const runtime = new AdapterRuntime(new GenericAddressAdapter({ chainId: CHAIN, onIntent: () => {} }), doc, {
      observe: () => ({ disconnect }),
    });
    runtime.start();
    runtime.stop();
    expect(disconnect).toHaveBeenCalled();
  });
});

describe('matchesSite', () => {
  it('matches the adapter pattern', () => {
    const a = new GenericAddressAdapter({
      chainId: CHAIN,
      onIntent: () => {},
      pattern: new URLPattern({ hostname: 'dexscreener.com' }),
    });
    expect(matchesSite(a, 'https://dexscreener.com/robinhood/0xabc')).toBe(true);
    expect(matchesSite(a, 'https://evil.example/')).toBe(false);
  });
});

// AxiomAdapter has its own suite in axiom.test.ts, built from the captured DOM.

// ── sell gating (D-049) ─────────────────────────────────────────────────────

describe('sell gating', () => {
  const noop = () => {};
  const sellButton = (host: HTMLElement) => host.shadowRoot!.querySelector('button.sell') as HTMLButtonElement;
  const mount = (probeSell?: (t: TokenRef) => Promise<{ reason: string } | null>) => {
    const doc = listPage();
    const row = doc.querySelector('.row')!;
    const seen: OverlayIntent[] = [];
    const host = mountOverlay(row, { address: A, chainId: CHAIN }, {
      onIntent: (i) => seen.push(i),
      ...(probeSell ? { probeSell } : {}),
    });
    return { host, seen, btn: sellButton(host) };
  };

  it('emits immediately when no probe is supplied', async () => {
    const { seen, btn } = mount();
    btn.click();
    expect(seen).toHaveLength(1);
  });

  it('emits the intent when the probe says the sell can proceed', async () => {
    const { seen, btn } = mount(async () => null);
    btn.click();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(btn.disabled).toBe(false);
  });

  it('does NOT emit when the venue cannot sell, and says why', async () => {
    // The whole point: three venues have pools whose sell quote reverts, so a
    // button that always fires is a button that sometimes cannot work.
    const { seen, btn } = mount(async () => ({ reason: 'arithmetic underflow' }));
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe("can't sell"));
    expect(seen).toEqual([]);
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('arithmetic underflow');
  });

  it('stays disabled after refusing, so a second click cannot fire it', async () => {
    const { seen, btn } = mount(async () => ({ reason: 'no liquidity' }));
    btn.click();
    await vi.waitFor(() => expect(btn.disabled).toBe(true));
    btn.click();
    btn.click();
    expect(seen).toEqual([]);
  });

  it('re-enables when the probe itself fails, rather than blaming the venue', async () => {
    // A probe that errors is not evidence the sell would fail — an RPC hiccup
    // must not permanently disable a working button.
    const { seen, btn } = mount(async () => {
      throw new Error('rpc timeout');
    });
    btn.click();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(seen).toEqual([]);
    expect(btn.textContent).toBe('Sell');
  });

  it('ignores clicks while a probe is in flight', async () => {
    let calls = 0;
    const { btn } = mount(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return null;
    });
    // dispatchEvent, not .click(): a disabled button swallows .click() outright,
    // so that would test the disabled flag rather than the in-flight guard —
    // and the guard would survive being deleted.
    const fire = () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    fire();
    fire();
    fire();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    // Otherwise an impatient user fires three quotes and three trades.
    expect(calls).toBe(1);
  });

  it('buying is never gated by the sell probe', async () => {
    const { seen, host } = mount(async () => ({ reason: 'nope' }));
    (host.shadowRoot!.querySelector('button') as HTMLButtonElement).click();
    expect(seen).toEqual([{ side: 'buy', token: { address: A, chainId: CHAIN }, amount: '0.001' }]);
  });
});
