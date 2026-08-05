/**
 * Generic address adapter.
 *
 * Decorates any page that displays raw EVM addresses, by shape rather than by
 * site-specific selectors. That makes it useful on explorers and screeners
 * (Blockscout, DexScreener) without bespoke work, and it is the reference
 * implementation the runtime is tested against.
 *
 * A site-specific adapter will always beat it on a terminal — it knows which
 * column is the token and where a button belongs — but this one degrades
 * gracefully instead of doing nothing.
 */

import type { TokenRef } from '@hoodini/core';
import type { SiteAdapter } from '../site.js';
import { detectTokensIn, elementsFor, nearestRow } from '../detect.js';
import { mountOverlay, type OverlayIntent } from '../overlay.js';

export interface GenericAdapterOptions {
  readonly chainId: number;
  readonly onIntent: (intent: OverlayIntent) => void;
  /** Gate the Sell control on a real quote — see OverlayOptions.probeSell. */
  readonly probeSell?: (token: TokenRef, percent?: number) => Promise<{ reason: string } | null>;
  /** Warm the venue cache on hover — see OverlayOptions.onWarm. */
  readonly onWarm?: (token: TokenRef) => void;
  /** Shown under the buttons: what a click will submit with (D-065). */
  readonly config?: { readonly slippageBps: number };
  /** Open the focused trade panel — see OverlayOptions.onExpand. */
  readonly onExpand?: (token: TokenRef) => void;
  /** Defaults to every https page; narrowed by the manifest in practice. */
  readonly pattern?: URLPattern;
  readonly amounts?: readonly string[];
}

export class GenericAddressAdapter implements SiteAdapter {
  readonly id = 'generic';
  readonly siteMatch: URLPattern;

  readonly #o: GenericAdapterOptions;
  #doc: Document | null = null;

  constructor(options: GenericAdapterOptions) {
    this.#o = options;
    this.siteMatch = options.pattern ?? new URLPattern({ protocol: 'https' });
  }

  detectTokens(document: Document): TokenRef[] {
    // Held so findAnchors can search the same tree the tokens came from,
    // rather than assuming a global document.
    this.#doc = document;
    return detectTokensIn(document, { chainId: this.#o.chainId });
  }

  findAnchors(tokenRef: TokenRef): Element[] {
    const doc = this.#doc;
    if (!doc) return [];
    const rows = new Set<Element>();
    for (const el of elementsFor(doc, tokenRef.address)) {
      const row = nearestRow(el);
      // Never anchor inside our own control, or a rescan would nest overlays.
      if (row.closest('[data-hoodini]')) continue;
      rows.add(row);
    }
    return [...rows];
  }

  mount(anchor: Element, tokenRef: TokenRef): void {
    mountOverlay(anchor, tokenRef, {
      onIntent: this.#o.onIntent,
      ...(this.#o.amounts ? { amounts: this.#o.amounts } : {}),
      ...(this.#o.probeSell ? { probeSell: this.#o.probeSell } : {}),
      ...(this.#o.onWarm ? { onWarm: this.#o.onWarm } : {}),
      ...(this.#o.config ? { config: this.#o.config } : {}),
      ...(this.#o.onExpand ? { onExpand: this.#o.onExpand } : {}),
    });
  }
}
