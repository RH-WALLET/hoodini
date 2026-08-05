/**
 * GMGN and Terminal.
 *
 * Fixtures mirror `docs/dom/gmgn.ai.home.json` and
 * `docs/dom/trade.padre.gg.json`: GMGN's `href` on a plain `div` wrapped in a
 * virtual-list positioner, Terminal's thumbnail URL inside a classless row
 * holding a `MuiButton-secondary` quick-buy. Addresses are the captured ones.
 *
 * As with Axiom, the property that matters most is refusal — both sites put
 * Solana rows in the same column as Robinhood ones.
 */

import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  ChainTaggedSiteAdapter,
  createGmgnAdapter,
  createTerminalAdapter,
} from '../src/adapters/chainTagged.js';
import { HOST_ATTR } from '../src/overlay.js';
import { matchesSite } from '../src/runtime.js';

/** Captured from GMGN. */
const G1 = getAddress('0x297b94b8615b56bf902a776b979cc5b5104c0a9e');
const G2 = getAddress('0x3271e52ee008c97e6a43430a14b18533df807777');
/** Captured from Terminal. */
const T1 = getAddress('0x5ebe38f4f654a7d38ee540ab6e38c78e6e587777');

const CHAIN = 4663;
const opts = { chainId: CHAIN, onIntent: () => {} };

function run(adapter: ChainTaggedSiteAdapter): { tokens: string[]; anchors: Element[] } {
  const tokens: string[] = [];
  const anchors: Element[] = [];
  for (const t of adapter.detectTokens(document)) {
    tokens.push(t.address);
    for (const a of adapter.findAnchors(t)) {
      adapter.mount(a, t);
      anchors.push(a);
    }
  }
  return { tokens, anchors };
}

// ── GMGN ────────────────────────────────────────────────────────────────────

/** A row as GMGN renders it: virtual-list positioner wrapping a div with href. */
function gmgnRow(address: string, chain = 'robinhood'): string {
  const a = address.toLowerCase();
  return `
    <div style="position:absolute;top:0;transform:translateY(0px);height:124px">
      <div class="relative flex gap-8px p-[14px]"
           href="/${chain}/token/${a}"
           data-sentry-element="SimulateLinkByConfig"
           data-sentry-source-file="TokenItem.tsx">
        <div data-sentry-component="TokenIconView" data-sentry-source-file="TokenIconView.tsx">
          <img src="https://gmgn.ai/external-res/abc123_v2.webp">
          <img src="/static/icons/icon_robinhoodeth_16px_s.6f0d36b9.webp">
        </div>
        <div class="flex flex-col"><span>TOK</span><span>0x29...0a9e</span></div>
      </div>
    </div>`;
}

describe('GMGN', () => {
  it('claims gmgn.ai only', () => {
    const a = createGmgnAdapter(opts);
    expect(matchesSite(a, 'https://gmgn.ai/?chain=robinhood&tab=home')).toBe(true);
    expect(matchesSite(a, 'https://gmgn.ai.evil.example/')).toBe(false);
  });

  it('reads chain and address from the same href', () => {
    document.body.innerHTML = gmgnRow(G1);
    const { tokens, anchors } = run(createGmgnAdapter(opts));
    expect(tokens).toEqual([G1]);
    expect(anchors).toHaveLength(1);
  });

  it('refuses a Solana row in the same column', () => {
    document.body.innerHTML = `
      ${gmgnRow(G1)}
      <div><div href="/sol/token/BdQ7L3Lye5iAhoV5f5XY275LkyPAPpcKFk2VpF29pump"
                data-sentry-source-file="TokenItem.tsx"></div></div>`;
    expect(run(createGmgnAdapter(opts)).tokens).toEqual([G1]);
  });

  it('refuses an EVM row on another chain', () => {
    // The address is valid and EVM-shaped; only the slug says it is not ours.
    document.body.innerHTML = gmgnRow(G2, 'bsc');
    expect(run(createGmgnAdapter(opts)).tokens).toEqual([]);
  });

  it('anchors on the TokenItem row, not the virtual-list positioner', () => {
    document.body.innerHTML = gmgnRow(G1);
    const { anchors } = run(createGmgnAdapter(opts));
    expect(anchors[0]!.getAttribute('data-sentry-source-file')).toBe('TokenItem.tsx');
  });

  it('anchors on the row rather than the positioner when the list has depth', () => {
    // With one row the selector and the shape fallback happen to agree, which
    // hid whether the selector was doing anything. With several, the
    // positioners become same-shaped siblings and the fallback would grab one
    // — so this is what proves `anchorSelectors` earns its place.
    document.body.innerHTML = gmgnRow(G1) + gmgnRow(G2) + gmgnRow(T1);
    const { anchors } = run(createGmgnAdapter(opts));
    expect(anchors).toHaveLength(3);
    for (const a of anchors) {
      expect(a.getAttribute('data-sentry-source-file')).toBe('TokenItem.tsx');
      expect((a as HTMLElement).style.position).not.toBe('absolute');
    }
  });

  it('still anchors when the Sentry attribute is gone', () => {
    // GMGN could drop its instrumentation in any build; the overlay must
    // degrade rather than disappear (D-034).
    document.body.innerHTML = gmgnRow(G1).replace(/ data-sentry-source-file="TokenItem.tsx"/, '');
    const { tokens, anchors } = run(createGmgnAdapter(opts));
    expect(tokens).toEqual([G1]);
    expect(anchors).toHaveLength(1);
  });

  it('rebinds when a virtualised row is recycled for another token', () => {
    // The list reuses nodes as you scroll. A stale control would offer the
    // previous token at the new token's price.
    document.body.innerHTML = gmgnRow(G1);
    const adapter = createGmgnAdapter(opts);
    run(adapter);
    const row = document.querySelector('[data-sentry-source-file="TokenItem.tsx"]')!;
    expect(document.querySelector(`[${HOST_ATTR}]`)!.getAttribute('data-hoodini-token')).toBe(G1.toLowerCase());

    row.setAttribute('href', `/robinhood/token/${G2.toLowerCase()}`);
    run(adapter);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
    expect(document.querySelector(`[${HOST_ATTR}]`)!.getAttribute('data-hoodini-token')).toBe(G2.toLowerCase());
  });

  it('is idempotent across rescans', () => {
    document.body.innerHTML = gmgnRow(G1);
    const adapter = createGmgnAdapter(opts);
    run(adapter);
    run(adapter);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });
});

// ── Terminal ────────────────────────────────────────────────────────────────

/** A row as Terminal renders it: classless div, thumbnail, MUI quick-buy. */
function terminalRow(address: string, chain = 'ROBINHOOD', buy = '0.15'): string {
  const a = address.toLowerCase();
  return `
    <div>
      <div class="MuiStack-root css-2u6gam">
        <img class="MuiAvatar-img css-1hy9t21" src="https://thumbnails.padre.gg/${chain}-${a}">
        <a class="MuiBox-root css-j70pnc" href="https://flap.sh/robinhood/${a}">
          <img src="/assets/pons-gray.png">
        </a>
        <button class="MuiButtonBase-root MuiButton-root MuiButton-secondary">${buy}</button>
        <button class="MuiButtonBase-root css-11uoyb3">0x5…7777</button>
      </div>
    </div>`;
}

describe('Terminal', () => {
  it('claims trade.padre.gg only', () => {
    const a = createTerminalAdapter(opts);
    expect(matchesSite(a, 'https://trade.padre.gg/trenches')).toBe(true);
    expect(matchesSite(a, 'https://padre.gg/trenches')).toBe(false);
  });

  it('reads chain and address from the thumbnail URL', () => {
    document.body.innerHTML = terminalRow(T1);
    const { tokens, anchors } = run(createTerminalAdapter(opts));
    expect(tokens).toEqual([T1]);
    expect(anchors).toHaveLength(1);
  });

  it('refuses a Solana row', () => {
    document.body.innerHTML = `
      ${terminalRow(T1)}
      <div><img src="https://thumbnails.padre.gg/SOLANA-BdQ7L3Lye5iAhoV5f5XY275LkyPAPpcKFk2VpF29pump"></div>`;
    expect(run(createTerminalAdapter(opts)).tokens).toEqual([T1]);
  });

  it('refuses an EVM row on another chain', () => {
    document.body.innerHTML = terminalRow(T1, 'BSC');
    expect(run(createTerminalAdapter(opts)).tokens).toEqual([]);
  });

  it('anchors on the row holding the quick-buy, not the thumbnail', () => {
    document.body.innerHTML = terminalRow(T1);
    const { anchors } = run(createTerminalAdapter(opts));
    expect(anchors[0]!.querySelector('.MuiButton-secondary')?.textContent).toBe('0.15');
    expect(anchors[0]!.tagName).toBe('DIV');
  });

  it('does not mistake the copy-contract button for a quick-buy', () => {
    // Its label is a truncated address, which begins with a digit.
    document.body.innerHTML = `
      <div><div class="row">
        <img src="https://thumbnails.padre.gg/ROBINHOOD-${T1.toLowerCase()}">
        <button class="MuiButtonBase-root css-11uoyb3">0x5…7777</button>
      </div></div>`;
    const { anchors } = run(createTerminalAdapter(opts));
    // Still anchors — via the shape fallback — but not because of that button.
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.querySelector('.MuiButton-secondary')).toBeNull();
  });

  it('climbs past the copy-contract button to the row with the real quick-buy', () => {
    // The copy button's label is a truncated address, which begins with a
    // digit. If that counted as a price control, the overlay would anchor on
    // the inner block instead of the card — so this pins the end anchor in
    // BUY_TEXT, not just the fact that something got anchored.
    document.body.innerHTML = `
      <div class="card">
        <div class="inner">
          <img src="https://thumbnails.padre.gg/ROBINHOOD-${T1.toLowerCase()}">
          <button class="MuiButtonBase-root css-11uoyb3">0x5…7777</button>
        </div>
        <button class="MuiButtonBase-root MuiButton-root MuiButton-secondary">0.15</button>
      </div>`;
    const { anchors } = run(createTerminalAdapter(opts));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.className).toBe('card');
  });

  it('is case-insensitive about the chain slug', () => {
    // Terminal writes ROBINHOOD; nothing guarantees it always will.
    document.body.innerHTML = terminalRow(T1, 'Robinhood');
    expect(run(createTerminalAdapter(opts)).tokens).toEqual([T1]);
  });

  it('never anchors on the thumbnail itself', () => {
    // The address lives on an <img>, which accepts appendChild and renders
    // nothing — so a control mounted there is invisible while every mounting
    // assertion still passes.
    document.body.innerHTML = `<div class="wrap">
      <img src="https://thumbnails.padre.gg/ROBINHOOD-${T1.toLowerCase()}">
    </div>`;
    const { anchors } = run(createTerminalAdapter(opts));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.tagName).not.toBe('IMG');
    expect(document.querySelector(`.wrap > [${HOST_ATTR}]`)).not.toBeNull();
  });

  it('does not read a long run of digits as a price', () => {
    // A market cap inside a button matches the digit pattern; only the length
    // bound rejects it, which would otherwise anchor on the wrong block.
    document.body.innerHTML = `
      <div class="card">
        <div class="inner">
          <img src="https://thumbnails.padre.gg/ROBINHOOD-${T1.toLowerCase()}">
          <button class="stat">1,234,567,890,123,456,789,012</button>
        </div>
        <button class="MuiButton-secondary">0.15</button>
      </div>`;
    const { anchors } = run(createTerminalAdapter(opts));
    expect(anchors[0]!.className).toBe('card');
  });
});

// ── shared machine ──────────────────────────────────────────────────────────

describe('the machine both share', () => {
  it('gives the two sites distinct ids', () => {
    expect([createGmgnAdapter(opts).id, createTerminalAdapter(opts).id]).toEqual(['gmgn', 'terminal']);
  });

  it('returns nothing before a scan has happened', () => {
    document.body.innerHTML = gmgnRow(G1);
    expect(createGmgnAdapter(opts).findAnchors({ address: G1, chainId: CHAIN })).toEqual([]);
  });

  it('drops an address whose checksum does not verify', () => {
    // Mixed case asserts a checksum; a wrong one is a typo or a spoof.
    const bad = '0x297b94B8615b56bf902a776b979cc5b5104c0a9e';
    document.body.innerHTML = `<div><div href="/robinhood/token/${bad}"
      data-sentry-source-file="TokenItem.tsx"></div></div>`;
    expect(run(createGmgnAdapter(opts)).tokens).toEqual([]);
  });

  it('deduplicates a token whose address matches the locator more than once', () => {
    // Two attributes, both matching, same address — one token and one control.
    document.body.innerHTML = `
      <div><div class="row" data-sentry-source-file="TokenItem.tsx"
                href="/robinhood/token/${G1.toLowerCase()}">
        <a href="/robinhood/token/${G1.toLowerCase()}">chart</a>
      </div></div>`;
    const { tokens, anchors } = run(createGmgnAdapter(opts));
    expect(tokens).toEqual([G1]);
    expect(anchors).toHaveLength(1);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });

  it('fails closed on a locator that captures no chain', () => {
    // The machine is exported, so a future config could supply a pattern with
    // only an address group — which would silently remove the chain gate that
    // is the entire point of this file. It must detect nothing instead.
    const misconfigured = new ChainTaggedSiteAdapter({
      id: 'broken',
      siteMatch: new URLPattern({ hostname: 'example.test' }),
      locators: [{ pattern: /token\/(?<address>0x[a-fA-F0-9]{40})/, source: 'no chain group' }],
      chainSlugs: ['robinhood'],
      chainId: CHAIN,
      onIntent: () => {},
    });
    document.body.innerHTML = `<div><div href="/robinhood/token/${G1.toLowerCase()}"></div></div>`;
    expect(misconfigured.detectTokens(document)).toEqual([]);
  });

  it('emits an intent carrying the row-s own token', () => {
    const seen: string[] = [];
    document.body.innerHTML = terminalRow(T1);
    run(createTerminalAdapter({ chainId: CHAIN, onIntent: (i) => seen.push(`${i.side}:${i.token.address}`) }));
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    host.shadowRoot!.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(seen).toEqual([`buy:${T1}`]);
  });
});

describe('placement', () => {
  it.each([
    ['gmgn', createGmgnAdapter, () => (document.body.innerHTML = gmgnRow(G1))],
    ['terminal', createTerminalAdapter, () => (document.body.innerHTML = terminalRow(T1))],
  ])('positions %s against the row rather than flowing after it', (_id, make, render) => {
    // Flow placement was measured slicing the control in half on Axiom, whose
    // cards are the same fixed-height clipping shape. Unverified on these two —
    // nobody has watched either render — but shipping the known-broken
    // arrangement would be the worse bet (D-052).
    render();
    run(make(opts));
    const host = document.querySelector(`[${HOST_ATTR}]`) as HTMLElement;
    expect(host.style.position).toBe('absolute');
    expect(host.style.bottom).toBe('10px');
    expect(Number(host.style.zIndex)).toBeGreaterThan(50);
  });
});
