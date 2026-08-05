/**
 * Axiom adapter — `axiom.trade`, designed against `docs/dom/axiom.trade.json`.
 *
 * Axiom is a **multi-chain** terminal, and that single fact shapes everything
 * here. Its Pulse columns interleave Solana, BNB Chain and Robinhood Chain rows,
 * so an `0x…` address on this page is not necessarily a Robinhood Chain token.
 * The captured snapshot has a live example: `0xffea30fa…149a7777` and
 * `0x05274cf4…26187777` both end in the `7777` vanity suffix that Robinhood
 * launches use, and both are BNB Chain tokens on Flap — proved by their own
 * `flap.sh/bnb/…` and `coinmarketcap/token/bsc/…` links.
 *
 * Since the same address can exist on two EVM chains, decorating by address
 * shape could offer a Robinhood Chain buy against a token the user was never
 * looking at. So this adapter refuses to decorate a row it cannot positively
 * identify as Robinhood Chain (D-050).
 *
 * ## Where the address comes from
 *
 * Not from the visible text: Axiom renders every contract truncated
 * (`0x5d...2ba3`). The full address is in ordinary attributes, which is what
 * matters — an isolated-world content script can read an `src` or an `href`,
 * but not a React prop:
 *
 *   - `img src="…axiomtrading-<chain>-v2.axiom-cdn.io/<address>.webp"`
 *   - `a href="https://x.com/search?q=<address>"`
 *
 * `detectTokensIn` already reads attributes as well as text, so detection needs
 * no Axiom-specific parsing — only the chain gate below.
 *
 * ## What is NOT a chain marker
 *
 *   - **The address suffix.** `…7777` appears on BNB Chain too (above).
 *   - **The image CDN host.** Robinhood rows are served from
 *     `axiomtrading-eth-v2`, the same bucket as Ethereum.
 *   - **`alt="ETH"`.** On a Robinhood row that alt sits on a file named
 *     `eth-robinhood-v2.svg` — Robinhood Chain's gas token *is* ETH, so the
 *     denomination icon says ETH while the chain is not Ethereum.
 *   - **The quick-buy button's label.** Same reason: it reads `0.1 ETH`.
 *
 * The one unambiguous marker is Axiom's own chain badge, which carries
 * `alt="Robinhood"` on `robinhood-logo.svg`, observed on every Robinhood row in
 * both captures and absent from every BNB row.
 */

import type { Address } from 'viem';
import type { TokenRef } from '@hoodini/core';
import type { SiteAdapter } from '../site.js';
import { detectTokensIn, elementsFor } from '../detect.js';
import { HOST_ATTR, mountOverlay, type OverlayIntent, type SellUnavailable } from '../overlay.js';

export interface AxiomAdapterOptions {
  readonly chainId: number;
  readonly onIntent: (intent: OverlayIntent) => void;
  readonly amounts?: readonly string[];
  /** Gate the Sell control on a real quote — see OverlayOptions.probeSell. */
  readonly probeSell?: (token: TokenRef, percent?: number) => Promise<SellUnavailable | null>;
  /** Warm the venue cache on hover — see OverlayOptions.onWarm. */
  readonly onWarm?: (token: TokenRef) => void;
  /** Shown under the buttons: what a click will submit with (D-065). */
  readonly config?: { readonly slippageBps: number };
  /** Open the focused trade panel — see OverlayOptions.onExpand. */
  readonly onExpand?: (token: TokenRef) => void;
}

/**
 * How far to climb from the node carrying an address before giving up. The
 * observed distance is about nine levels (the address is on the token image,
 * deep inside the icon block); twelve matches `nearestRow`'s budget.
 */
const MAX_CLIMB = 12;

/**
 * Where the control sits on the card.
 *
 * Measured, not guessed, and revised once after looking. Appending into the
 * card's flow put a 19px control at offset 110px in a 115px card clipping at
 * 116px, so it was sliced in half. Positioning it at `right: 104px` then landed
 * it on top of the percentage badges.
 *
 * There is no free space on the card — every edge is a stat row. Axiom accepts
 * that for its own quick-buy by floating it over the content, visible on hover;
 * ours takes the same corner and stays visible, which is why the control now
 * carries its own panel background rather than sitting bare on the page.
 *
 * These are the only numbers here that the DOM capture cannot supply: it
 * records structure, and this depends on rendered geometry.
 */
const PLACEMENT = { bottom: '10px', right: '12px' } as const;

/**
 * A quick-buy control as Axiom labels it: `0 BNB`, `0.1 ETH`, `0.15`, `Buy`.
 *
 * The end anchor is load-bearing. It is what excludes the copy-contract button,
 * whose text is a truncated address (`0x5d...2ba3`): the leading `0` starts a
 * match that then fails to reach the end. An earlier version also tested
 * `/^0x/` explicitly; mutation testing showed that branch was unreachable, so
 * it was decoration rather than protection and is gone.
 */
const BUY_TEXT = /^[\s⚡]*(?:buy|\d[\d.,]*\s*(?:eth|bnb|sol|hood)?)$/i;

/**
 * Axiom names this Tailwind group itself, so unlike the utility classes around
 * it (`flex`, `w-full`, `z-[1]`) it carries intent and is worth matching. It is
 * a hint, not a requirement — the text pattern stands alone if it is renamed
 * (D-034).
 */
const BUY_GROUP = 'quickBuyButton';

function isBuyControl(el: Element): boolean {
  if ([...el.classList].some((c) => c.includes(BUY_GROUP))) return true;
  const text = (el.textContent ?? '').trim();
  // The bound is not cosmetic: a long run of digits and commas — a market cap
  // rendered inside a button, say — satisfies the pattern below and is not a
  // price control.
  if (!text || text.length > 24) return false;
  return BUY_TEXT.test(text);
}

function hasBuyControl(root: Element): boolean {
  for (const el of root.querySelectorAll('button, [role="button"]')) {
    if (isBuyControl(el)) return true;
  }
  return false;
}

/**
 * Is this card a Robinhood Chain token?
 *
 * The alt text is the primary signal; the filename is a fallback for the day
 * Axiom localises or drops the alt. Both were present on every Robinhood row in
 * the capture. Anything else — including a card with no badge at all — is
 * treated as "not Robinhood", because the cost of a false negative is a missing
 * button and the cost of a false positive is a trade on the wrong chain.
 */
function isRobinhoodCard(card: Element): boolean {
  for (const img of card.querySelectorAll('img')) {
    if ((img.getAttribute('alt') ?? '').trim().toLowerCase() === 'robinhood') return true;
    if (/robinhood-logo|eth-robinhood/i.test(img.getAttribute('src') ?? '')) return true;
  }
  return false;
}

/**
 * The smallest ancestor holding both this address and a buy control.
 *
 * Defined by shape rather than by selector, per D-030 — Axiom's markup is pure
 * Tailwind utilities with no `data-*` hooks and no ids, so `div.relative.z-[1]`
 * is not something to build on. Climbing stops at the first ancestor with a
 * control, which is the card: the token's own icon-and-name block has no buy
 * button (the first capture proved it), and the column has many.
 */
function cardFor(el: Element): Element | null {
  let cur: Element | null = el;
  for (let i = 0; i < MAX_CLIMB && cur; i++) {
    if (hasBuyControl(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export class AxiomAdapter implements SiteAdapter {
  readonly id = 'axiom';
  readonly siteMatch = new URLPattern({ hostname: 'axiom.trade' });

  readonly #o: AxiomAdapterOptions;
  #doc: Document | null = null;

  constructor(options: AxiomAdapterOptions) {
    this.#o = options;
  }

  /**
   * Only tokens on a Robinhood Chain card are returned at all — the gate lives
   * in detection, not just in anchoring, so a foreign-chain address never
   * becomes a `TokenRef` that some later caller might quote.
   */
  detectTokens(document: Document): TokenRef[] {
    this.#doc = document;
    return detectTokensIn(document, { chainId: this.#o.chainId }).filter(
      (t) => this.#cardsFor(t.address).length > 0,
    );
  }

  findAnchors(tokenRef: TokenRef): Element[] {
    return this.#cardsFor(tokenRef.address);
  }

  /**
   * Anchor on the card, not on Axiom's buy button.
   *
   * Two reasons. Each card carries *two* quick-buy buttons — one
   * `block sm:hidden`, one `hidden sm:block` — so anchoring on "the buy button"
   * would mount twice, once invisibly. And their desktop button sits inside a
   * container that is `opacity-0` until hover below the `xl` breakpoint, so a
   * control mounted beside it would inherit that and vanish at exactly the
   * width the capture was taken at.
   */
  mount(anchor: Element, tokenRef: TokenRef): void {
    mountOverlay(anchor, tokenRef, {
      onIntent: this.#o.onIntent,
      placement: PLACEMENT,
      ...(this.#o.amounts ? { amounts: this.#o.amounts } : {}),
      ...(this.#o.probeSell ? { probeSell: this.#o.probeSell } : {}),
      ...(this.#o.onWarm ? { onWarm: this.#o.onWarm } : {}),
      ...(this.#o.config ? { config: this.#o.config } : {}),
      ...(this.#o.onExpand ? { onExpand: this.#o.onExpand } : {}),
    });
  }

  #cardsFor(address: Address): Element[] {
    const doc = this.#doc;
    if (!doc) return [];

    const cards = new Set<Element>();
    for (const el of elementsFor(doc, address)) {
      const card = cardFor(el);
      if (!card) continue;
      // Never anchor inside our own control, or a rescan nests overlays.
      if (card.closest(`[${HOST_ATTR}]`)) continue;
      if (!isRobinhoodCard(card)) continue;
      cards.add(card);
    }
    // Deduplicated: an address appears on the image, the X search link and the
    // copy button, all of which resolve to the same card.
    return [...cards];
  }
}

export function createAxiomAdapter(options: AxiomAdapterOptions): AxiomAdapter {
  return new AxiomAdapter(options);
}
