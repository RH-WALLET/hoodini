/**
 * Sites that tag a token's chain and address together, in one attribute.
 *
 * GMGN and Terminal both do this, and it is a stronger arrangement than the
 * one Axiom offers. On Axiom the chain lives in a badge and the address in an
 * image URL, so the two can in principle be read apart — and reading the
 * address without the chain is exactly the mistake D-050 exists to prevent.
 * Here they are the same string:
 *
 *   GMGN      href="/robinhood/token/0xd82f70f5…"
 *   Terminal  src="https://thumbnails.padre.gg/ROBINHOOD-0x5ebe38f4…"
 *
 * You cannot extract one without the other, which makes the chain gate a
 * property of parsing rather than a check someone can forget to call.
 *
 * One machine, two config entries — the same call D-045 made for the V4 hooks,
 * and for the same reason: the sites differ in their locator pattern and their
 * anchor, not in their logic.
 *
 * Designed against `docs/dom/gmgn.ai.home.json` and
 * `docs/dom/trade.padre.gg.json`.
 */

import { getAddress, isAddress, type Address } from 'viem';
import type { TokenRef } from '@hoodini/core';
import type { SiteAdapter } from '../site.js';
import { nearestRow } from '../detect.js';
import {
  HOST_ATTR,
  mountOverlay,
  type OverlayIntent,
  type OverlayPlacement,
  type SellUnavailable,
} from '../overlay.js';

/**
 * A pattern that pulls a chain slug and an address out of one attribute value.
 * Must expose both as named groups, so a config cannot accidentally supply a
 * pattern that yields an address with no chain attached.
 */
export interface ChainTaggedLocator {
  readonly pattern: RegExp;
  /** Human note for the snapshot this came from. */
  readonly source: string;
}

export interface ChainTaggedConfig {
  readonly id: string;
  readonly siteMatch: URLPattern;
  readonly locators: readonly ChainTaggedLocator[];
  /**
   * Chain slugs on this site that mean Robinhood Chain, lowercased. Anything
   * else is a different chain and gets no control.
   */
  readonly chainSlugs: readonly string[];
  /**
   * Containers to anchor on, most specific first. A stale selector costs
   * precision, not function — the shape fallbacks below still find a row
   * (D-034).
   */
  readonly anchorSelectors?: readonly string[];
  readonly chainId: number;
  readonly onIntent: (intent: OverlayIntent) => void;
  readonly amounts?: readonly string[];
  readonly probeSell?: (token: TokenRef) => Promise<SellUnavailable | null>;
  /** Warm the venue cache on hover — see OverlayOptions.onWarm. */
  readonly onWarm?: (token: TokenRef) => void;
  /** Position against the row rather than flowing after it — see PLACEMENT. */
  readonly placement?: OverlayPlacement;
}

/**
 * Where the control sits on a terminal row.
 *
 * Carried over from Axiom, where flow placement was measured putting a 19px
 * control at offset 110px in a 115px card that clips at 116px (D-052). These
 * two are the same shape of layout — GMGN's rows are a fixed 124px inside a
 * virtual-list wrapper, and both sites put their own quick-buy on the right —
 * so the same correction almost certainly applies.
 *
 * **Almost certainly is not the same as verified.** Nobody has watched either
 * of these render. It is applied because leaving them in the flow would ship a
 * defect already seen once on a structurally identical page, not because the
 * geometry has been checked.
 */
const PLACEMENT: OverlayPlacement = { bottom: '10px', right: '12px' };

/**
 * A quick-buy control as these terminals label it: `0.15`, `0.1 ETH`, `Buy`.
 *
 * The end anchor excludes the copy-contract button, whose text is a truncated
 * address — a leading `0` starts a match that then fails to reach the end.
 */
const BUY_TEXT = /^[\s⚡]*(?:buy|\d[\d.,]*\s*(?:eth|bnb|sol|hood)?)$/i;

function isBuyControl(el: Element): boolean {
  const text = (el.textContent ?? '').trim();
  // A long run of digits and commas — a market cap inside a button — satisfies
  // the pattern and is not a price control.
  if (!text || text.length > 24) return false;
  return BUY_TEXT.test(text);
}

/** How far to climb before giving up on finding a row. */
const MAX_CLIMB = 12;

/**
 * Elements that cannot display a child, so cannot host a control.
 *
 * This matters here in a way it did not for the other adapters: on Terminal the
 * address lives on the token thumbnail, so the natural anchor *is* an `<img>`.
 * `appendChild` on one succeeds and renders nothing — the worst kind of
 * failure, since every test about mounting would still pass while the user saw
 * no button. Found by mutation testing, not by reading the code.
 */
const CANNOT_HOST = new Set(['IMG', 'INPUT', 'BR', 'HR', 'EMBED', 'SOURCE', 'TRACK', 'AREA', 'COL', 'WBR']);

function hostable(el: Element): Element {
  return CANNOT_HOST.has(el.tagName) && el.parentElement ? el.parentElement : el;
}

export class ChainTaggedSiteAdapter implements SiteAdapter {
  readonly id: string;
  readonly siteMatch: URLPattern;

  readonly #c: ChainTaggedConfig;
  #doc: Document | null = null;

  constructor(config: ChainTaggedConfig) {
    this.#c = config;
    this.id = config.id;
    this.siteMatch = config.siteMatch;
  }

  detectTokens(document: Document): TokenRef[] {
    this.#doc = document;
    const found = new Map<string, TokenRef>();
    for (const [address] of this.#hits(document)) {
      found.set(address.toLowerCase(), { address, chainId: this.#c.chainId });
    }
    return [...found.values()];
  }

  findAnchors(tokenRef: TokenRef): Element[] {
    const doc = this.#doc;
    if (!doc) return [];

    const target = tokenRef.address.toLowerCase();
    const anchors = new Set<Element>();
    for (const [address, el] of this.#hits(doc)) {
      if (address.toLowerCase() !== target) continue;
      anchors.add(this.#anchorFor(el));
    }
    return [...anchors];
  }

  mount(anchor: Element, tokenRef: TokenRef): void {
    mountOverlay(anchor, tokenRef, {
      onIntent: this.#c.onIntent,
      ...(this.#c.placement ? { placement: this.#c.placement } : {}),
      ...(this.#c.amounts ? { amounts: this.#c.amounts } : {}),
      ...(this.#c.probeSell ? { probeSell: this.#c.probeSell } : {}),
      ...(this.#c.onWarm ? { onWarm: this.#c.onWarm } : {}),
    });
  }

  /**
   * Every (address, carrying element) pair on the page whose chain slug is
   * ours.
   *
   * The gate is here, in the one place an address can enter the adapter at
   * all, rather than in `detectTokens` and again in `findAnchors`. A token
   * from another chain is never constructed, so there is nothing downstream to
   * forget to check.
   *
   * Sibling adapters guard against re-anchoring inside their own overlay. This
   * one does not need to, and mutation testing proved it: a locator must find a
   * chain slug *and* an address in a single attribute value, and the only
   * attributes an overlay host carries are `data-hoodini` and a bare
   * `data-hoodini-token` address — no chain, so no match, so the host can never
   * be a hit. A config whose locator could match a bare address would break
   * that, which is why the chain group is mandatory below rather than optional.
   */
  *#hits(root: ParentNode): Generator<[Address, Element]> {
    for (const el of root.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        for (const { pattern } of this.#c.locators) {
          // Patterns are config, not page input, but a global flag would carry
          // lastIndex between calls — so match fresh each time.
          const m = attr.value.match(pattern);
          const chain = m?.groups?.['chain'];
          const address = m?.groups?.['address'];
          if (!chain || !address) continue;
          if (!this.#c.chainSlugs.includes(chain.toLowerCase())) continue;
          // Page content is untrusted: an address-shaped string is not an
          // address until viem says so (strict, so a bad checksum is dropped
          // rather than coerced).
          if (!isAddress(address, { strict: true })) continue;
          yield [getAddress(address.toLowerCase()), el];
        }
      }
    }
  }

  /**
   * The element a control belongs on.
   *
   * Three strategies, weakest commitment last. A configured selector is a hint
   * that the site has a semantic hook — GMGN ships `TokenItem.tsx` in a Sentry
   * attribute, which is worth using while it lasts. Absent that, the row is
   * the smallest ancestor that also holds a buy control, which is what worked
   * on Axiom and Terminal. Absent even that — GMGN's home tab has no quick-buy
   * at all — fall back to shape.
   */
  #anchorFor(el: Element): Element {
    for (const selector of this.#c.anchorSelectors ?? []) {
      try {
        const hit = el.closest(selector);
        if (hit) return hit;
      } catch {
        // A malformed selector must not take the adapter down with it.
      }
    }

    let cur: Element | null = el;
    for (let i = 0; i < MAX_CLIMB && cur; i++) {
      if ([...cur.querySelectorAll('button, [role="button"]')].some(isBuyControl)) return cur;
      cur = cur.parentElement;
    }

    return hostable(nearestRow(el));
  }
}

type Common = {
  chainId: number;
  onIntent: (i: OverlayIntent) => void;
  amounts?: readonly string[];
  probeSell?: (token: TokenRef) => Promise<SellUnavailable | null>;
  onWarm?: (token: TokenRef) => void;
};

/**
 * GMGN. Every row is a `div` carrying `href="/robinhood/token/0x…"` — an href
 * on a div, not an anchor, which is why this reads attributes rather than
 * looking for links.
 *
 * `data-sentry-source-file` is GMGN's Sentry instrumentation, shipped in
 * production and naming the actual React component. It is the most semantic
 * hook any of the three terminals offers, so it is tried first — but it is
 * still someone else's build artefact, hence the fallbacks.
 *
 * The list is virtualised, so a row node gets reused for a different token as
 * you scroll. `mountOverlay` rebinds on token change rather than duplicating,
 * which is what makes that safe.
 */
export function createGmgnAdapter(o: Common): ChainTaggedSiteAdapter {
  return new ChainTaggedSiteAdapter({
    id: 'gmgn',
    siteMatch: new URLPattern({ hostname: 'gmgn.ai' }),
    locators: [
      {
        pattern: /^\/(?<chain>[a-z0-9-]+)\/token\/(?<address>0x[a-fA-F0-9]{40})\b/,
        source: 'docs/dom/gmgn.ai.home.json — row href',
      },
    ],
    chainSlugs: ['robinhood'],
    anchorSelectors: ['[data-sentry-source-file="TokenItem.tsx"]'],
    placement: PLACEMENT,
    ...o,
  });
}

/**
 * Terminal (ex-Padre). The token thumbnail's URL is
 * `thumbnails.padre.gg/<CHAIN>-<address>`, and it sits inside the row, so one
 * `querySelector` yields both facts.
 *
 * No anchor selector: its `css-*` classes are emotion hashes that change every
 * build, and MUI's stable globals (`MuiButton-secondary`) describe the button
 * rather than the row. Shape is the honest option here — the row is the
 * smallest ancestor holding both the thumbnail and the `0.15` quick-buy.
 */
export function createTerminalAdapter(o: Common): ChainTaggedSiteAdapter {
  return new ChainTaggedSiteAdapter({
    id: 'terminal',
    siteMatch: new URLPattern({ hostname: 'trade.padre.gg' }),
    locators: [
      {
        pattern: /thumbnails\.padre\.gg\/(?<chain>[A-Za-z0-9]+)-(?<address>0x[a-fA-F0-9]{40})\b/,
        source: 'docs/dom/trade.padre.gg.json — token thumbnail',
      },
    ],
    chainSlugs: ['robinhood'],
    placement: PLACEMENT,
    ...o,
  });
}
