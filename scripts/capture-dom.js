/**
 * capture-dom.js — snapshot a terminal's token rows for SiteAdapter design (P3).
 *
 * Terminals like Axiom sit behind Cloudflare bot protection, so they cannot be
 * fetched by automation. They can, however, be read trivially from the browser
 * you are already logged into — which is also exactly where the extension will
 * run, so what this captures is precisely what a SiteAdapter will see.
 *
 * ## How to use
 *
 * 1. Open the terminal and get to the token list you want overlaid.
 * 2. DevTools → Console. (Chrome may require typing `allow pasting` first.)
 * 3. Paste this whole file, press Enter.
 * 4. It copies a JSON snapshot to your clipboard and prints a summary.
 * 5. Paste the result into the chat, or save it to docs/dom/<site>.json.
 *
 * ## v2 — why this changed
 *
 * v1 looked for a full 40-hex address and gave up if it found none. On Axiom,
 * GMGN and Terminal every address is rendered middle-truncated (`0x2d…7777`),
 * so v1 bailed on all three, left the clipboard untouched, and reported nothing
 * about pages it could read perfectly well. A capture tool that only works in
 * the easy case is not a capture tool.
 *
 * v2 never gives up. It tries full addresses in text, then in attributes, then
 * truncated forms, and always reports which mode found the rows — because
 * "the full address is not in the DOM" is itself the finding that decides how
 * detection has to work.
 *
 * ## What it captures
 *
 * Only page structure: tag names, class names, attribute NAMES, link targets,
 * and the outerHTML of two representative rows, truncated.
 *
 * It does NOT read cookies, localStorage, sessionStorage, form values, or any
 * authenticated API response — a DOM snapshot should never carry your session.
 * Skim the output before sending it; it is your page, not mine.
 */

(() => {
  /** A real, complete EVM address. */
  const FULL = /0x[a-fA-F0-9]{40}/;
  const FULL_G = /0x[a-fA-F0-9]{40}/g;

  /**
   * An address as these terminals actually render it: `0x2d…7777`, `0x97...e95d`.
   * Deliberately EVM-only — a truncated Solana address is base58 and would match
   * half the prose on the page, and Solana rows are ones we want to exclude
   * anyway.
   */
  const TRUNC = /0x[a-fA-F0-9]{2,10}\s*(?:…|\.{2,3})\s*[a-fA-F0-9]{3,10}/;

  const ownTextOf = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join(' ');

  const attrsOf = (el) => [...el.attributes].map((a) => `${a.name}=${a.value}`).join(' ');

  /**
   * Three passes, cheapest and most useful first. The mode that succeeds tells
   * the adapter where to read an address from at runtime, so it is recorded.
   */
  const passes = [
    { mode: 'full-text', test: (el) => FULL.test(ownTextOf(el)) },
    { mode: 'full-attribute', test: (el) => FULL.test(attrsOf(el)) },
    { mode: 'truncated-text', test: (el) => TRUNC.test(ownTextOf(el)) },
  ];

  const all = [...document.querySelectorAll('*')];
  let carriers = [];
  let mode = 'none';
  for (const pass of passes) {
    const hits = all.filter(pass.test);
    if (hits.length > 0) {
      carriers = hits;
      mode = pass.mode;
      break;
    }
  }

  /** Walk up to the repeating ancestor — the "row" a button would mount into. */
  const rowOf = (el) => {
    let cur = el;
    for (let i = 0; i < 12 && cur?.parentElement; i++) {
      const p = cur.parentElement;
      // A row's parent holds several siblings of the same shape.
      const shaped = [...p.children].filter((c) => c.tagName === cur.tagName);
      if (shaped.length >= 3 && cur.textContent && cur.textContent.length > 40) return cur;
      cur = p;
    }
    return el;
  };

  /**
   * A quick-buy control as these terminals label it: `0 BNB`, `0.1 ETH`, `0.15`,
   * `Buy`. Explicitly not the copy-CA button, whose text is an address and would
   * otherwise pass the "contains digits" test.
   */
  const isBuyControl = (el) => {
    const s = (el.textContent ?? '').trim();
    if (!s || s.length > 24 || /^0x/i.test(s)) return false;
    return /^buy$/i.test(s) || /^[⚡\s]*[\d.]+\s*(eth|bnb|sol|hood)?$/i.test(s);
  };

  /**
   * rowOf stops at the first repeating ancestor, which on Axiom is the icon and
   * name block — the quick-buy button lives outside it, so the first capture
   * missed the very element an overlay needs to sit beside. Keep climbing until
   * the subtree actually contains a control, but stop well short of swallowing
   * the whole column.
   */
  const cardOf = (el) => {
    let cur = el;
    for (let i = 0; i < 5 && cur?.parentElement; i++) {
      if ([...cur.querySelectorAll('button, [role="button"]')].some(isBuyControl)) return cur;
      cur = cur.parentElement;
    }
    return el;
  };

  const rows = [...new Set(carriers.map((c) => cardOf(rowOf(c))))];

  const signature = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join('.')}`;
  const bySig = {};
  for (const r of rows) (bySig[signature(r)] ??= []).push(r);

  // The most repeated signature is the token row.
  const [topSig, topRows] = Object.entries(bySig).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  const samples = (topRows ?? []).slice(0, 2);

  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    classes: [...el.classList],
    dataAttrs: [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-') || n === 'id'),
    fullAddresses: [...new Set(el.outerHTML.match(FULL_G) ?? [])].slice(0, 3),
    truncatedTexts: [...new Set((el.textContent ?? '').match(new RegExp(TRUNC, 'g')) ?? [])].slice(0, 3),
    /**
     * Link targets are the most likely home of the full address once the
     * visible text is truncated — and unlike a React prop, an href is a real
     * attribute, so an isolated-world content script can actually read it.
     */
    hrefs: [...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).slice(0, 6),
    /** Tooltips are the other common hiding place. */
    labels: [...el.querySelectorAll('[title],[aria-label]')]
      .map((n) => n.getAttribute('title') ?? n.getAttribute('aria-label'))
      .filter((v) => v && (FULL.test(v) || TRUNC.test(v)))
      .slice(0, 4),
    childCount: el.children.length,
    /**
     * Every control in the card, with its parent's classes. Recorded separately
     * because outerHTML gets truncated long before the buy button, which sits at
     * the end of the card — and that button is the whole point of the capture.
     */
    controls: [...el.querySelectorAll('button, [role="button"]')].slice(0, 12).map((b) => ({
      tag: b.tagName.toLowerCase(),
      classes: [...b.classList].slice(0, 6),
      text: (b.textContent ?? '').trim().slice(0, 24),
      isBuy: isBuyControl(b),
      parentClasses: [...(b.parentElement?.classList ?? [])].slice(0, 6),
    })),
    // Trimmed: enough to recognise the row, not enough to be a page dump.
    outerHTML: el.outerHTML.length > 5000 ? el.outerHTML.slice(0, 5000) + '…[truncated]' : el.outerHTML,
  });

  /**
   * Axiom mixes SOL, BNB and HOOD rows in one column, and an 0x address can
   * exist on more than one EVM chain — so the adapter must read a per-row chain
   * marker or stay silent. This looks for whatever carries that marker.
   */
  const chainHints = samples.slice(0, 1).flatMap((r) => [
    ...[...r.querySelectorAll('img')].slice(0, 6).map((i) => ({
      kind: 'img',
      src: (i.getAttribute('src') ?? '').slice(0, 120),
      alt: i.getAttribute('alt') ?? '',
    })),
    ...[...r.querySelectorAll('*')]
      .map((n) => (ownTextOf(n) ?? '').trim())
      .filter((t) => /^(sol|eth|bnb|hood|base)$/i.test(t))
      .slice(0, 6)
      .map((t) => ({ kind: 'text', text: t })),
  ]);

  const snapshot = {
    capturedAt: new Date().toISOString(),
    url: location.href,
    host: location.host,
    viewport: { w: innerWidth, h: innerHeight },

    /** How rows were found. Decides the whole detection strategy. */
    addressMode: mode,
    addressCarriers: carriers.length,

    /**
     * The question v1 could not answer: is a complete address present anywhere
     * in the DOM this page renders? If false, no amount of selector work will
     * make text scraping viable and detection must come from link targets.
     */
    fullAddressAnywhereInDom: FULL.test(document.documentElement.outerHTML),
    distinctFullAddresses: [...new Set(document.documentElement.outerHTML.match(FULL_G) ?? [])].length,

    distinctRowShapes: Object.keys(bySig).length,
    likelyRowSelector: topSig ?? null,
    likelyRowCount: topRows?.length ?? 0,
    // Two rows: one alone can hide which parts are per-token vs static chrome.
    sampleRows: samples.map(describe),
    chainHints,

    // Where a button could go without fighting the app's own layout.
    anchorHints: samples.slice(0, 1).flatMap((r) =>
      [...r.querySelectorAll('button, a[role="button"], [class*="action"], [class*="btn"]')]
        .slice(0, 8)
        .map((b) => ({
          tag: b.tagName.toLowerCase(),
          classes: [...b.classList].slice(0, 4),
          text: (b.textContent ?? '').trim().slice(0, 24),
        })),
    ),

    framework: {
      react: !!document.querySelector('#root, #__next, [data-reactroot]'),
      nextjs: !!document.querySelector('#__next') || !!window.__NEXT_DATA__,
      // Virtualised lists recycle nodes, which decides whether mount() can be
      // one-shot or must re-run on mutation.
      virtualised: !!document.querySelector('[class*="virtual"], [data-index], [class*="ReactVirtualized"]'),
      /**
       * Recorded to explain a missing address, NOT as a plan: React keeps props
       * as expando properties on the node, which an isolated-world content
       * script cannot see. Reading them would mean injecting into the page
       * world, which this project does not do.
       */
      reactPropsOnRow: samples[0] ? Object.keys(samples[0]).some((k) => k.startsWith('__react')) : false,
    },
  };

  const json = JSON.stringify(snapshot, null, 2);

  console.log('%c[hoodini] DOM snapshot', 'font-weight:bold');
  console.log(`  host              ${snapshot.host}`);
  console.log(`  address mode      ${snapshot.addressMode}  (${snapshot.addressCarriers} carriers)`);
  console.log(`  full CA in DOM    ${snapshot.fullAddressAnywhereInDom}  (${snapshot.distinctFullAddresses} distinct)`);
  console.log(`  likely row        ${snapshot.likelyRowSelector}  ×${snapshot.likelyRowCount}`);
  console.log(`  react/next/virt   ${snapshot.framework.react}/${snapshot.framework.nextjs}/${snapshot.framework.virtualised}`);
  console.log(snapshot);

  if (mode === 'none') {
    console.warn(
      '[hoodini] No address-shaped text found at all — not even truncated.\n' +
        'The list may be canvas-rendered, or inside a shadow root.\n' +
        'Send the summary above anyway; an empty result is still an answer.',
    );
  }

  // Always leave something on the clipboard, even in the empty case — a silent
  // no-op is what made v1 useless.
  try {
    copy(json); // devtools helper
    console.log('%c  ✓ copied to clipboard — paste it into the chat', 'color:#0a0');
  } catch {
    console.log('  (copy() unavailable — right-click the object above → Copy object)');
  }

  // Retrievable if the clipboard gets overwritten before you paste it.
  window.__hoodiniSnapshot = json;
  return snapshot;
})();
