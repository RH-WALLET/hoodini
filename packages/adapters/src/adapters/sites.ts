/**
 * Site adapters for X, Telegram Web and DexScreener.
 *
 * All three differ from a terminal in the same way: an address appears inside a
 * *content* block — a tweet, a message bubble, a table row — and the control
 * belongs on that block, not on the bare `<span>` holding the text.
 *
 * So each adapter is the same machinery with a different idea of what a block
 * is. `anchorSelectors` lists the containers a site is known to use, tried in
 * order; if none matches, `nearestRow`'s shape heuristic takes over. That
 * fallback is the reason a selector going stale degrades the overlay rather
 * than removing it (D-030, D-034).
 *
 * **Unverified against the live sites.** The selectors below are the documented
 * or widely-observed hooks for each product, but no DOM snapshot has been
 * captured for any of them, so they are marked accordingly in DATA_SOURCES.md.
 * The shape fallback is what makes that acceptable rather than reckless.
 */

import type { TokenRef } from '@hoodini/core';
import type { SiteAdapter } from '../site.js';
import { detectTokensIn, elementsFor, nearestRow } from '../detect.js';
import { mountOverlay, type OverlayIntent } from '../overlay.js';

export interface SiteAdapterConfig {
  readonly id: string;
  readonly siteMatch: URLPattern;
  /**
   * Containers to anchor on, most specific first. A selector that stops
   * matching costs precision, not function — the shape fallback still finds a
   * block.
   */
  readonly anchorSelectors: readonly string[];
  readonly chainId: number;
  readonly onIntent: (intent: OverlayIntent) => void;
  readonly amounts?: readonly string[];
  /** Gate the Sell control on a real quote — see OverlayOptions.probeSell. */
  readonly probeSell?: (token: TokenRef) => Promise<{ reason: string } | null>;
  /** Warm the venue cache on hover — see OverlayOptions.onWarm. */
  readonly onWarm?: (token: TokenRef) => void;
}

export class ConfigurableSiteAdapter implements SiteAdapter {
  readonly id: string;
  readonly siteMatch: URLPattern;

  readonly #c: SiteAdapterConfig;
  #doc: Document | null = null;

  constructor(config: SiteAdapterConfig) {
    this.#c = config;
    this.id = config.id;
    this.siteMatch = config.siteMatch;
  }

  detectTokens(document: Document): TokenRef[] {
    this.#doc = document;
    return detectTokensIn(document, { chainId: this.#c.chainId });
  }

  findAnchors(tokenRef: TokenRef): Element[] {
    const doc = this.#doc;
    if (!doc) return [];

    const anchors = new Set<Element>();
    for (const el of elementsFor(doc, tokenRef.address)) {
      const block = this.#blockFor(el);
      // Never anchor inside our own control, or a rescan nests overlays.
      if (block.closest('[data-hoodini]')) continue;
      anchors.add(block);
    }
    return [...anchors];
  }

  /** The content block this element belongs to. */
  #blockFor(el: Element): Element {
    for (const selector of this.#c.anchorSelectors) {
      try {
        const hit = el.closest(selector);
        if (hit) return hit;
      } catch {
        // A malformed selector must not take the adapter down with it.
      }
    }
    return nearestRow(el);
  }

  mount(anchor: Element, tokenRef: TokenRef): void {
    mountOverlay(anchor, tokenRef, {
      onIntent: this.#c.onIntent,
      ...(this.#c.amounts ? { amounts: this.#c.amounts } : {}),
      ...(this.#c.probeSell ? { probeSell: this.#c.probeSell } : {}),
      ...(this.#c.onWarm ? { onWarm: this.#c.onWarm } : {}),
    });
  }
}

type Common = {
  chainId: number;
  onIntent: (i: OverlayIntent) => void;
  amounts?: readonly string[];
  probeSell?: (token: TokenRef) => Promise<{ reason: string } | null>;
  onWarm?: (token: TokenRef) => void;
};

/**
 * X (Twitter). `data-testid="tweet"` is X's own test hook and is the most
 * stable handle the site offers — far more so than its generated class names.
 */
export function createXAdapter(o: Common): ConfigurableSiteAdapter {
  return new ConfigurableSiteAdapter({
    id: 'x',
    siteMatch: new URLPattern({ hostname: '{www.}?x.com' }),
    anchorSelectors: ['article[data-testid="tweet"]', 'article[role="article"]', 'article'],
    ...o,
  });
}

/**
 * Telegram Web. Both clients (K and A) are covered: they use different markup,
 * so each gets its message-bubble selector and the shape fallback catches the
 * rest.
 */
export function createTelegramAdapter(o: Common): ConfigurableSiteAdapter {
  return new ConfigurableSiteAdapter({
    id: 'telegram-web',
    siteMatch: new URLPattern({ hostname: 'web.telegram.org' }),
    anchorSelectors: ['.message', '.Message', '[data-mid]', '[data-message-id]', '.bubble'],
    ...o,
  });
}

/**
 * DexScreener. Anchors on a pair row in a list, or the header on a token page.
 */
export function createDexScreenerAdapter(o: Common): ConfigurableSiteAdapter {
  return new ConfigurableSiteAdapter({
    id: 'dexscreener',
    siteMatch: new URLPattern({ hostname: 'dexscreener.com' }),
    anchorSelectors: ['a.ds-dex-table-row', '.ds-dex-table-row', '[class*="table-row"]', 'tr'],
    ...o,
  });
}

/** Every site adapter, in the order a content script should try them. */
export function createSiteAdapters(o: Common): ConfigurableSiteAdapter[] {
  return [createXAdapter(o), createTelegramAdapter(o), createDexScreenerAdapter(o)];
}
