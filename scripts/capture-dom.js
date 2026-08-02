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
 * ## What it captures
 *
 * Only page structure: tag names, class names, data-* attribute NAMES, and the
 * outerHTML of two representative rows. It looks for EVM addresses to find the
 * rows, then truncates their text.
 *
 * It does NOT read cookies, localStorage, sessionStorage, form values, or any
 * authenticated API response — a DOM snapshot should never carry your session.
 * Skim the output before sending it; it is your page, not mine.
 */

(() => {
  const EVM = /0x[a-fA-F0-9]{40}/;
  const EVM_G = /0x[a-fA-F0-9]{40}/g;

  /** Every element whose own text or attributes contain an EVM address. */
  const carriers = [];
  for (const el of document.querySelectorAll('*')) {
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join(' ');
    const attrs = [...el.attributes].map((a) => `${a.name}=${a.value}`).join(' ');
    if (EVM.test(ownText) || EVM.test(attrs)) carriers.push(el);
  }

  if (carriers.length === 0) {
    console.warn(
      '[hoodini] No EVM addresses found in the DOM.\n' +
        'The list may render addresses only on hover/expand, or use a canvas/virtualised list.\n' +
        'Try opening a single token page and re-running, and mention that in the reply.',
    );
    return;
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

  const rows = [...new Set(carriers.map(rowOf))];

  const signature = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join('.')}`;
  const bySig = {};
  for (const r of rows) (bySig[signature(r)] ??= []).push(r);

  // The most repeated signature is the token row.
  const [topSig, topRows] = Object.entries(bySig).sort((a, b) => b[1].length - a[1].length)[0] ?? [];

  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    classes: [...el.classList],
    dataAttrs: [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-') || n === 'id'),
    addresses: (el.outerHTML.match(EVM_G) ?? []).slice(0, 3),
    childCount: el.children.length,
    // Trimmed: enough to recognise the row, not enough to be a page dump.
    outerHTML: el.outerHTML.length > 4000 ? el.outerHTML.slice(0, 4000) + '…[truncated]' : el.outerHTML,
  });

  const snapshot = {
    capturedAt: new Date().toISOString(),
    url: location.href,
    host: location.host,
    viewport: { w: innerWidth, h: innerHeight },
    addressCarriers: carriers.length,
    distinctRowShapes: Object.keys(bySig).length,
    likelyRowSelector: topSig,
    likelyRowCount: topRows?.length ?? 0,
    // Two rows: one alone can hide which parts are per-token vs static chrome.
    sampleRows: (topRows ?? []).slice(0, 2).map(describe),
    // Where a button could go without fighting the app's own layout.
    anchorHints: (topRows ?? []).slice(0, 1).flatMap((r) =>
      [...r.querySelectorAll('button, a[role="button"], [class*="action"], [class*="btn"]')]
        .slice(0, 6)
        .map((b) => ({ tag: b.tagName.toLowerCase(), classes: [...b.classList].slice(0, 4), text: (b.textContent ?? '').trim().slice(0, 24) })),
    ),
    framework: {
      react: !!document.querySelector('#root, #__next, [data-reactroot]'),
      nextjs: !!document.querySelector('#__next') || !!window.__NEXT_DATA__,
      // Virtualised lists recycle nodes, which decides whether mount() can be
      // one-shot or must re-run on mutation.
      virtualised: !!document.querySelector('[class*="virtual"], [data-index], [class*="ReactVirtualized"]'),
    },
  };

  const json = JSON.stringify(snapshot, null, 2);
  console.log('%c[hoodini] DOM snapshot', 'font-weight:bold');
  console.log(`  host              ${snapshot.host}`);
  console.log(`  address carriers  ${snapshot.addressCarriers}`);
  console.log(`  likely row        ${snapshot.likelyRowSelector}  ×${snapshot.likelyRowCount}`);
  console.log(`  react/next/virt   ${snapshot.framework.react}/${snapshot.framework.nextjs}/${snapshot.framework.virtualised}`);
  console.log(snapshot);

  try {
    copy(json); // devtools helper
    console.log('%c  ✓ copied to clipboard — paste it into the chat', 'color:#0a0');
  } catch {
    console.log('  (copy() unavailable — right-click the object above → Copy object)');
  }
  return snapshot;
})();
