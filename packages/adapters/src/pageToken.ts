/**
 * Is this page *about* one token?
 *
 * A list and a detail page want different things from this extension. Scanning
 * Pulse, you want the smallest control that can buy without getting in the way.
 * On a coin's own page you are working one token, and the panel earns its space.
 *
 * ## Why the URL, and not the DOM
 *
 * "The page mentions exactly one address" is tempting and wrong: a list that
 * has loaded one row, or a detail page that also renders a holders table, both
 * break it, and they break it by *opening a trading panel on the wrong token*.
 *
 * A terminal that gives a token its own page puts the address in the path —
 * that is how the page is addressable at all:
 *
 *   gmgn.ai/robinhood/token/0xd82f70f5…
 *   axiom.trade/meme/0x5ebe38f4…
 *
 * So the rule is: the path contains an address, and the page also carries that
 * same address somewhere the adapter recognised. The first half says the page
 * is about a token; the second says it is a token this extension can trade, on
 * the right chain, because it came through the adapter's own chain gate (D-050).
 *
 * Sites that address a page by *pair* rather than by token — DexScreener among
 * them — will not match, and that is the honest outcome: the pair address is not
 * the token address, and guessing which of the two tokens was meant would open
 * a panel that buys the wrong thing.
 */

import { isAddress, getAddress, type Address } from 'viem';
import type { TokenRef } from '@hoodini/core';

/**
 * Addresses in a URL path or query, in order.
 *
 * Deliberately not anchored to a particular route shape: terminals move their
 * URLs around, and a pattern per site is a maintenance burden that fails
 * silently when one of them changes.
 */
export function addressesInUrl(url: string): Address[] {
  let target = url;
  try {
    const parsed = new URL(url);
    // Path and query only. The origin can contain hex-looking noise and the
    // fragment is where sites keep state that is not the subject of the page.
    target = `${parsed.pathname}${parsed.search}`;
  } catch {
    // Not a URL we can parse; scan it as text rather than giving up.
  }
  const out: Address[] = [];
  for (const m of target.matchAll(/0x[a-fA-F0-9]{40}/g)) {
    const candidate = m[0];
    if (isAddress(candidate, { strict: false })) out.push(getAddress(candidate));
  }
  return out;
}

/**
 * The token this page is about, or null.
 *
 * `detected` is what the site adapter found, already chain-gated. Passing it in
 * rather than re-scanning keeps the chain check in one place: this function
 * cannot accidentally approve a token from another chain, because it can only
 * return one that the adapter already accepted.
 */
export function pageToken(url: string, detected: readonly TokenRef[]): TokenRef | null {
  const inUrl = addressesInUrl(url);
  if (inUrl.length === 0) return null;

  const wanted = new Set(inUrl.map((a) => a.toLowerCase()));
  const matches = detected.filter((t) => wanted.has(t.address.toLowerCase()));

  // Exactly one, or nothing. Two addresses from the path both present on the
  // page is a route this code does not understand, and opening a panel on
  // whichever came first would be a guess about someone's money.
  return matches.length === 1 ? matches[0]! : null;
}
