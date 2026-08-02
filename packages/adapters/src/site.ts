/**
 * SiteAdapter — the one interface every supported page hides behind.
 *
 * A content script owns exactly one SiteAdapter per matched URL. The adapter's
 * only job is DOM: find token references on the page, find where a button
 * belongs, and mount it. It performs no chain reads, holds no keys, and never
 * builds a transaction — all of that lives in the service worker.
 *
 * P0: interface only.
 */

import type { TokenRef } from '@nock/core';

export interface SiteAdapter {
  /** Stable identifier, e.g. 'x' | 'telegram-web' | 'dexscreener'. */
  readonly id: string;

  /** Pages this adapter owns. Must be narrower than the manifest's host perms. */
  readonly siteMatch: URLPattern;

  /**
   * Scrape token references out of the current DOM. Called on load and on every
   * mutation batch, so it must be cheap and must never throw on partial DOM.
   * Addresses found here are untrusted page content: they are validated as
   * checksummed addresses and resolved on-chain before anything is shown.
   */
  detectTokens(document: Document): TokenRef[];

  /**
   * Elements a buy/sell control should attach to for this token — a row, a
   * card, a tweet. May return several (a token can appear more than once) or
   * none (the token is mentioned but has no anchorable UI).
   */
  findAnchors(tokenRef: TokenRef): Element[];

  /**
   * Render the overlay control into `anchor`. Must be idempotent: re-mounting on
   * the same anchor replaces rather than duplicates, since SPA re-renders will
   * call this repeatedly for the same node.
   */
  mount(anchor: Element, tokenRef: TokenRef): void;
}
