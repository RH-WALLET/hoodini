/**
 * Token detection from a page's DOM.
 *
 * Everything here treats the page as hostile input. An address scraped from a
 * site is a *hint* about what the user is looking at, never an instruction:
 * it is checksum-validated here and resolved on-chain by the service worker
 * before anything is quoted or traded (ARCHITECTURE.md).
 */

import { getAddress, isAddress, type Address } from 'viem';
import type { TokenRef } from '@hoodini/core';

/**
 * Loose match; each hit is validated properly before being returned.
 *
 * The lookarounds are load-bearing. Without them a 41-character hex string
 * matches its first 40 characters, yielding a *different* address than the one
 * on screen — so a page displaying `0x<41 hex>` would decorate a token the user
 * never saw. Anything butted up against more hex is not an address.
 */
const EVM_RE = /(?<![0-9a-zA-Z_])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g;

/**
 * Addresses that are never a tradeable token, so a page mentioning them does
 * not sprout a buy button. Kept deliberately short — filtering by heuristic
 * would hide real tokens.
 */
const NEVER_TOKENS = new Set<string>([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

export interface DetectOptions {
  readonly chainId: number;
  /** Cap on returned tokens, so a page listing thousands cannot stall a scan. */
  readonly limit?: number;
}

/**
 * Pull candidate token addresses out of arbitrary text.
 *
 * `isAddress` is called in **strict** mode, which is what enforces EIP-55: a
 * mixed-case address whose checksum does not verify is a typo or a spoof and is
 * dropped rather than coerced. All-lowercase input asserts no checksum and is
 * accepted.
 *
 * `strict: true` is passed explicitly even though it is viem's default. An
 * earlier version of this function re-implemented the check by hand on top of
 * `isAddress`; the manual block turned out to be unreachable, so it was
 * decorative rather than protective. Naming the option keeps the dependency
 * visible instead of hiding it in a library default that could change.
 */
export function addressesInText(text: string): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(EVM_RE)) {
    const raw = match[0];
    const lower = raw.toLowerCase();
    if (seen.has(lower) || NEVER_TOKENS.has(lower)) continue;
    if (!isAddress(raw, { strict: true })) continue;
    seen.add(lower);
    out.push(getAddress(lower));
  }
  return out;
}

/**
 * Scan an element subtree for token references, reading both text and
 * attributes — terminals routinely put the address in an `href` or a `data-*`
 * rather than in visible text.
 */
export function detectTokensIn(root: ParentNode, options: DetectOptions): TokenRef[] {
  const { chainId, limit = 200 } = options;
  const found = new Map<string, TokenRef>();

  const consider = (text: string, symbol?: string) => {
    for (const address of addressesInText(text)) {
      if (found.size >= limit) return;
      const key = address.toLowerCase();
      if (found.has(key)) continue;
      found.set(key, symbol ? { address, chainId, symbol } : { address, chainId });
    }
  };

  for (const el of root.querySelectorAll('*')) {
    if (found.size >= limit) break;
    for (const attr of el.attributes) consider(attr.value);
    // Only this element's own text, so an address is attributed to the node
    // that actually contains it rather than to every ancestor.
    for (const node of el.childNodes) {
      if (node.nodeType === 3 /* TEXT_NODE */) consider(node.textContent ?? '');
    }
  }

  return [...found.values()];
}

/** Elements whose own text or attributes carry this token's address. */
export function elementsFor(root: ParentNode, address: Address): Element[] {
  const target = address.toLowerCase();
  const hits: Element[] = [];
  for (const el of root.querySelectorAll('*')) {
    const inAttrs = [...el.attributes].some((a) => a.value.toLowerCase().includes(target));
    const inText = [...el.childNodes].some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').toLowerCase().includes(target),
    );
    if (inAttrs || inText) hits.push(el);
  }
  return hits;
}

/**
 * Walk up to the repeating row a control should attach to.
 *
 * A raw address usually sits on a `<span>` or `<a>` too small to host a button;
 * the useful anchor is the row that node belongs to. "Row" is inferred from
 * shape — an ancestor with several same-shaped siblings — rather than from
 * class names, which are minified and change without warning.
 */
export function nearestRow(el: Element, maxDepth = 12): Element {
  let cur: Element = el;
  for (let i = 0; i < maxDepth; i++) {
    const parent = cur.parentElement;
    if (!parent) break;
    const sameShape = [...parent.children].filter((c) => c.tagName === cur.tagName);
    if (sameShape.length >= 3 && (cur.textContent?.length ?? 0) > 40) return cur;
    cur = parent;
  }
  return el;
}
