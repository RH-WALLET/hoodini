/**
 * Site adapters for X, Telegram Web and DexScreener.
 *
 * None of these has been verified against the live site, so the property that
 * matters most is the fallback: when a selector stops matching, the overlay
 * must degrade to shape-based anchoring rather than disappear.
 */

import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { createXAdapter, createTelegramAdapter, createDexScreenerAdapter, createSiteAdapters, ConfigurableSiteAdapter } from '../src/adapters/sites.js';
import { HOST_ATTR } from '../src/overlay.js';
import { matchesSite } from '../src/runtime.js';

const A = getAddress('0xb84e494158976b4e14da155d1cdae16eb6d1c477');
const CHAIN = 4663;
const common = { chainId: CHAIN, onIntent: () => {} };

function run(adapter: ConfigurableSiteAdapter, doc: Document): Element[] {
  const anchors: Element[] = [];
  for (const t of adapter.detectTokens(doc)) {
    for (const a of adapter.findAnchors(t)) {
      adapter.mount(a, t);
      anchors.push(a);
    }
  }
  return anchors;
}

describe('URL matching', () => {
  it.each([
    ['x', createXAdapter(common), 'https://x.com/someone/status/123', 'https://notx.com/'],
    ['telegram', createTelegramAdapter(common), 'https://web.telegram.org/k/#-100', 'https://telegram.org/'],
    ['dexscreener', createDexScreenerAdapter(common), 'https://dexscreener.com/robinhood/0xabc', 'https://dexscreener.io/'],
  ])('%s matches its own site only', (_n, adapter, good, bad) => {
    expect(matchesSite(adapter, good)).toBe(true);
    expect(matchesSite(adapter, bad)).toBe(false);
  });

  it('matches x.com with and without www', () => {
    const x = createXAdapter(common);
    expect(matchesSite(x, 'https://www.x.com/i/trending')).toBe(true);
  });
});

describe('X', () => {
  it('resolves the tweet article, not the span holding the address', () => {
    document.body.innerHTML = `
      <div id="feed">
        <article data-testid="tweet"><div class="body">gm buy ${A} now</div></article>
        <article data-testid="tweet"><div class="body">unrelated post</div></article>
      </div>`;
    const anchors = run(createXAdapter(common), document);
    // Only the tweet mentioning it resolves.
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.tagName).toBe('ARTICLE');
    expect(anchors[0]!.getAttribute('data-testid')).toBe('tweet');
  });

  it('falls back to shape when the testid is gone', () => {
    // X changes markup without notice; losing the hook must cost precision,
    // not detection. The anchor is what the panel's token fallback is built on,
    // so it still has to resolve to the post rather than to the whole feed.
    document.body.innerHTML = `
      <div id="feed">
        ${[1, 2, 3]
          .map((i) => `<div class="post"><div class="body">post ${i} ${i === 1 ? A : 'nothing here at all okay'} padding text</div></div>`)
          .join('')}
      </div>`;
    const anchors = run(createXAdapter(common), document);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.classList.contains('post')).toBe(true);
  });
});

describe('Telegram Web', () => {
  it.each(['message', 'Message', 'bubble'])('anchors on a .%s bubble', (cls) => {
    document.body.innerHTML = `
      <div class="chat">
        <div class="${cls}">check ${A}</div>
        <div class="${cls}">no address</div>
      </div>`;
    const anchors = run(createTelegramAdapter(common), document);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.classList.contains(cls)).toBe(true);
  });

  it('anchors on data-mid, used by the K client', () => {
    document.body.innerHTML = `<div class="chat"><div data-mid="42"><span>${A}</span></div></div>`;
    const anchors = run(createTelegramAdapter(common), document);
    expect(anchors[0]!.getAttribute('data-mid')).toBe('42');
  });
});

describe('DexScreener', () => {
  it('anchors on a pair row', () => {
    document.body.innerHTML = `
      <div class="ds-dex-table">
        <a class="ds-dex-table-row" href="/robinhood/${A}"><span>TOK</span></a>
        <a class="ds-dex-table-row" href="/robinhood/other"><span>OTH</span></a>
      </div>`;
    const anchors = run(createDexScreenerAdapter(common), document);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.classList.contains('ds-dex-table-row')).toBe(true);
  });

  it('anchors on a plain table row too', () => {
    document.body.innerHTML = `<table><tbody>
      <tr><td>${A}</td></tr><tr><td>x</td></tr><tr><td>y</td></tr></tbody></table>`;
    const anchors = run(createDexScreenerAdapter(common), document);
    expect(anchors[0]!.tagName).toBe('TR');
  });
});

describe('panel-only sites (D-074)', () => {
  it.each([
    ['x', createXAdapter, `<article data-testid="tweet">gm buy ${A} now</article>`],
    ['telegram-web', createTelegramAdapter, `<div class="message">check ${A}</div>`],
  ])('%s detects and resolves an anchor, but decorates nothing', (_n, make, markup) => {
    document.body.innerHTML = markup;
    const anchors = run(make(common), document);
    // Detection still runs: it is what tells the panel which token the post is
    // about. Only the strip is withheld.
    expect(anchors).toHaveLength(1);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(0);
  });

  it('dexscreener is unaffected and still decorates', () => {
    document.body.innerHTML = `<a class="ds-dex-table-row" href="/robinhood/${A}"><span>TOK</span></a>`;
    const anchors = run(createDexScreenerAdapter(common), document);
    expect(anchors).toHaveLength(1);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });
});

describe('shared behaviour', () => {
  it('a malformed selector does not take the adapter down', () => {
    const adapter = new ConfigurableSiteAdapter({
      id: 'broken',
      siteMatch: new URLPattern({ protocol: 'https' }),
      anchorSelectors: ['<<<not a selector>>>', 'article'],
      ...common,
    });
    document.body.innerHTML = `<article>hold ${A}</article>`;
    const anchors = run(adapter, document);
    // The bad selector is skipped and the next one still works.
    expect(anchors[0]!.tagName).toBe('ARTICLE');
  });

  // On DexScreener, which still decorates — X and Telegram no longer mount at
  // all, so they cannot demonstrate anything about repeated mounting.
  it('never nests a control inside another control', () => {
    document.body.innerHTML = `<a class="ds-dex-table-row" href="/robinhood/${A}">buy</a>`;
    const ds = createDexScreenerAdapter(common);
    for (let i = 0; i < 3; i++) run(ds, document);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
    for (const host of document.querySelectorAll(`[${HOST_ATTR}]`)) {
      expect(host.querySelector(`[${HOST_ATTR}]`)).toBeNull();
    }
  });

  it('createSiteAdapters returns all three, each with a distinct id', () => {
    const ids = createSiteAdapters(common).map((a) => a.id);
    expect(ids).toEqual(['x', 'telegram-web', 'dexscreener']);
  });
});
