/**
 * diagnose-panel.js — why is there no trade panel on this coin page?
 *
 * The panel appears when the page's own URL names a token address *and* the
 * site adapter also detected that address on the page (D-067). Two halves, and
 * "nothing appeared" does not say which one failed.
 *
 * Paste into the console on a coin's page. Reads only.
 */

(() => {
  const HEX = /0x[a-fA-F0-9]{40}/g;
  const line = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);

  console.log('%c[hoodini] panel diagnosis', 'font-weight:bold;font-size:13px');
  line('href', location.href);

  // ── half one: does the route name a token? ────────────────────────────────
  const inPath = [...`${location.pathname}${location.search}`.matchAll(HEX)].map((m) => m[0]);
  line('addresses in path+query', inPath.length ? inPath.join(', ') : 'NONE');

  const inHash = [...location.hash.matchAll(HEX)].map((m) => m[0]);
  if (inHash.length) line('addresses in #fragment', `${inHash.join(', ')}  (ignored on purpose)`);

  // ── half two: did the adapter accept anything here? ───────────────────────
  // A mounted control is proof the adapter detected a Robinhood Chain token on
  // this page. None means detection found nothing, whatever the URL says.
  const mounted = [...document.querySelectorAll('[data-hoodini]')];
  const tokens = [...new Set(mounted.map((h) => (h.getAttribute('data-hoodini-token') || '').toLowerCase()))];
  line('overlays mounted', mounted.length);
  line('tokens the adapter took', tokens.length ? tokens.join(', ') : 'NONE');
  line('panel currently open', document.querySelector('[data-hoodini-panel]') ? 'yes' : 'no');

  // ── what the page looks like, for adapting the detector ───────────────────
  const imgs = [...document.querySelectorAll('img')];
  const rh = imgs.filter((i) => {
    const a = (i.getAttribute('alt') || '').trim().toLowerCase();
    const s = i.getAttribute('src') || '';
    return a === 'robinhood' || /robinhood-logo|eth-robinhood/i.test(s);
  });
  line('robinhood-branded images', rh.length);
  const chainish = [...new Set(imgs.map((i) => (i.getAttribute('alt') || '').trim().toLowerCase()).filter(Boolean))];
  line('image alt values on page', chainish.slice(0, 12).join(', ') || '(none)');

  console.log('');
  if (!inPath.length) {
    console.log(
      '%c  VERDICT: the route does not carry the token address.\n' +
        '  This page is addressed some other way — a slug, an id, or a pair. The\n' +
        '  detector needs a rule for this site. Send Rory the href above.',
      'color:#ffb454',
    );
  } else if (!tokens.length) {
    console.log(
      '%c  VERDICT: the route names a token but the adapter detected nothing here.\n' +
        '  The site adapters were written against list and card layouts, so a\n' +
        '  detail page can legitimately have no row for them to find. This is the\n' +
        '  likely cause, and it is a bug in the detector rather than in the page.',
      'color:#ff8a80',
    );
  } else if (!tokens.some((t) => inPath.map((a) => a.toLowerCase()).includes(t))) {
    console.log(
      '%c  VERDICT: both halves found something, but different tokens.\n' +
        '  The route names one address and the adapter took another, so the panel\n' +
        '  correctly refused rather than guessing which coin you are looking at.',
      'color:#ffb454',
    );
  } else {
    console.log('%c  VERDICT: both halves agree — the panel should be open.', 'color:#3ad9a0');
  }

  console.log('\n  Copy everything above and send it back.');
})();
