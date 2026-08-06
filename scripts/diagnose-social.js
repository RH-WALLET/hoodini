/**
 * diagnose-social.js — do the X and Telegram adapters actually work?
 *
 * These two were written without DOM snapshots (BUILD-PLAN P4), so their
 * selectors are the only part of this extension nobody has ever checked against
 * the real markup. This checks them, on a page you are already looking at.
 *
 * Open a post or a chat that contains a contract address and paste this in.
 * Reads only; mounts nothing.
 */

(() => {
  const HEX = /(?<![0-9a-zA-Z_])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g;
  const line = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);

  // Exactly the lists the adapters try, in order (packages/adapters/src/adapters/sites.ts).
  const SELECTORS = {
    'x.com': ['article[data-testid="tweet"]', 'article[role="article"]', 'article'],
    'web.telegram.org': ['.message', '.Message', '[data-mid]', '[data-message-id]', '.bubble'],
  };

  const host = location.hostname.replace(/^www\./, '');
  const selectors = SELECTORS[host] ?? SELECTORS[Object.keys(SELECTORS).find((k) => host.endsWith(k)) ?? ''];

  console.log('%c[hoodini] social adapter check', 'font-weight:bold;font-size:13px');
  line('host', location.hostname);
  if (!selectors) {
    console.log('  Not X or Telegram Web. Open a post or a chat and try again.');
    return;
  }

  // ── 1. do the anchors exist at all? ───────────────────────────────────────
  console.log('%c  anchor selectors, in the order the adapter tries them:', 'font-weight:bold');
  let chosen = null;
  for (const sel of selectors) {
    let n = 0;
    try {
      n = document.querySelectorAll(sel).length;
    } catch {
      n = -1;
    }
    console.log(`    ${String(n).padStart(5)}  ${sel}${n > 0 && !chosen ? '   <-- would be used' : ''}`);
    if (n > 0 && !chosen) chosen = sel;
  }
  if (!chosen) {
    console.log(
      '%c\n  VERDICT: no selector matches. The adapter would find nothing here and\n' +
        '  the markup has moved. Send this output back.',
      'color:#ff8a80',
    );
    return;
  }

  // ── 2. are there addresses, and do they sit inside those anchors? ─────────
  const all = [...(document.body.innerText || '').matchAll(HEX)].map((m) => m[0]);
  const unique = [...new Set(all.map((a) => a.toLowerCase()))];
  line('addresses in page text', unique.length ? unique.length : 'NONE — open a post with a CA in it');

  let anchored = 0;
  const samples = [];
  for (const el of document.querySelectorAll(chosen)) {
    const text = el.innerText || '';
    const hits = [...text.matchAll(HEX)].map((m) => m[0]);
    if (!hits.length) continue;
    anchored++;
    if (samples.length < 3) samples.push({ address: hits[0], anchor: chosen, chars: text.length });
  }
  line(`anchors containing an address`, anchored);
  for (const s of samples) console.log(`      ${s.address}  in a ${s.chars}-char ${s.anchor}`);

  // ── 3. the part that matters more than the selectors ─────────────────────
  console.log('');
  if (!unique.length) {
    console.log(
      '%c  VERDICT: selectors match this page, but there is no address to decorate.\n' +
        '  Open a post that quotes a contract address and run it again.',
      'color:#ffb454',
    );
  } else if (!anchored) {
    console.log(
      '%c  VERDICT: addresses exist but none are inside a matched anchor, so no\n' +
        '  button would appear. The container selector needs updating.',
      'color:#ff8a80',
    );
  } else {
    console.log(
      '%c  VERDICT: the adapter would decorate ' + anchored + ' post(s) here.',
      'color:#3ad9a0',
    );
  }

  console.log(
    '%c\n  Worth knowing either way: neither of these adapters can tell which chain\n' +
      '  an address belongs to — a post never says. An address is not chain-\n' +
      '  specific, so a tweet about a Base or Ethereum token can name an address\n' +
      '  that is a DIFFERENT token on Robinhood Chain. Decorating it would offer\n' +
      '  a buy for something the post was not about.',
    'color:#8493aa',
  );
})();
