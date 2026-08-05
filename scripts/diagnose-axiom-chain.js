/**
 * diagnose-axiom-chain.js — is the overlay broken, or is nothing on screen ours?
 *
 * The Axiom adapter gates on chain (D-050): a card is decorated only when it
 * carries Robinhood branding, because the generic fallback would otherwise
 * decorate BNB, Solana and Ethereum rows as though they were Robinhood Chain.
 * So "no buttons" has two completely different causes, and guessing between
 * them wastes a session.
 *
 * This separates them: it reports whether the content script is present at all,
 * then takes a census of which chains Pulse is actually showing right now.
 *
 * Paste into the console on axiom.trade. Reads only. Mounts nothing, sends
 * nothing, and touches no key.
 */

(() => {
  const line = (k, v) => console.log(`  ${String(k).padEnd(30)} ${v}`);
  console.log('%c[hoodini] axiom chain census', 'font-weight:bold;font-size:13px');
  line('host', location.host);
  line('path', location.pathname);

  // 1. Did the content script inject at all? A swapped extension leaves an
  //    already-open tab with no content script until it is reloaded.
  const mounted = document.querySelectorAll('[data-hoodini]');
  line('overlays mounted', mounted.length);

  // 2. Find the repeating card shape, the same way the adapter does.
  const imgs = [...document.querySelectorAll('img')];
  const cards = new Set();
  for (const img of imgs) {
    let n = img;
    for (let i = 0; i < 8 && n; i++) {
      n = n.parentElement;
      if (!n) break;
      const r = n.getBoundingClientRect();
      if (r.height > 60 && r.height < 260 && r.width > 220) { cards.add(n); break; }
    }
  }
  line('candidate cards', cards.size);

  // 3. Which chain does each card claim? This is the whole question.
  const census = new Map();
  let robinhood = 0;
  for (const card of cards) {
    let tag = 'unlabelled';
    for (const img of card.querySelectorAll('img')) {
      const alt = (img.getAttribute('alt') || '').trim().toLowerCase();
      const src = img.getAttribute('src') || '';
      if (alt === 'robinhood' || /robinhood-logo|eth-robinhood/i.test(src)) { tag = 'robinhood'; break; }
      if (alt) { tag = alt; continue; }
      const m = src.match(/(solana|ethereum|bsc|bnb|base|tron|hyperliquid|sui|robinhood)/i);
      if (m && m[1]) tag = m[1].toLowerCase();
    }
    if (tag === 'robinhood') robinhood++;
    census.set(tag, (census.get(tag) || 0) + 1);
  }

  console.log('%c  chains on screen right now:', 'font-weight:bold');
  for (const [chain, n] of [...census.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${chain}${chain === 'robinhood' ? '   <-- ours' : ''}`);
  }

  console.log('');
  if (!mounted.length && robinhood > 0) {
    console.log(
      '%c  VERDICT: broken. There are Robinhood cards here and nothing mounted.\n' +
        '  Hard-reload the tab (Cmd+Shift+R). If it is still empty after a reload,\n' +
        '  the content script is not injecting — check chrome://extensions for errors.',
      'color:#ff8a80',
    );
  } else if (!mounted.length && robinhood === 0) {
    console.log(
      '%c  VERDICT: working as designed. Pulse is showing no Robinhood Chain\n' +
        '  tokens at the moment, and the adapter refuses to decorate other chains\n' +
        '  on purpose (D-050). Switch Pulse to the Robinhood/HOOD chain filter, or\n' +
        '  try dexscreener.com, which was seen working earlier.',
      'color:#ffb454',
    );
  } else {
    console.log(`%c  VERDICT: ${mounted.length} overlay(s) mounted. If you cannot see them it is a\n` +
      '  placement problem rather than a detection one — run diagnose-placement.js.',
      'color:#3ad9a0');
  }
})();
