/**
 * diagnose-overlay.js — why is there no button?
 *
 * Paste into the console of a site the extension claims to support. It
 * reproduces the adapter's decision chain step by step against the live DOM and
 * reports where the chain breaks, so a missing overlay stops being a guess.
 *
 * Reads only. Mounts nothing, sends nothing.
 */

(() => {
  const FULL = /(?<![0-9a-zA-Z_])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/;
  const BUY_TEXT = /^[\s⚡]*(?:buy|\d[\d.,]*\s*(?:eth|bnb|sol|hood)?)$/i;

  const line = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);

  console.log('%c[hoodini] overlay diagnosis', 'font-weight:bold');
  line('host', location.host);

  // 0. Did anything already mount? If so this is a styling problem, not a
  //    detection one, and everything below is a red herring.
  const hosts = document.querySelectorAll('[data-hoodini]');
  line('overlay hosts already in DOM', hosts.length);
  if (hosts.length) {
    const first = hosts[0];
    const box = first.getBoundingClientRect();
    line('  first host size', `${Math.round(box.width)}x${Math.round(box.height)}`);
    line('  first host visible', box.width > 0 && box.height > 0);
    line('  shadow root', first.shadowRoot ? 'present' : 'MISSING');
    console.log('  → mounted. If you cannot see it, it is CSS or placement, not detection.');
    return;
  }

  const all = [...document.querySelectorAll('*')];
  line('elements on page', all.length);

  // 1. Detection: which elements carry a full address, and where?
  const carriersAttr = all.filter((el) => [...el.attributes].some((a) => FULL.test(a.value)));
  const carriersText = all.filter((el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && FULL.test(n.textContent ?? '')),
  );
  line('elements with address in attrs', carriersAttr.length);
  line('elements with address in text', carriersText.length);

  const carriers = [...new Set([...carriersAttr, ...carriersText])];
  if (carriers.length === 0) {
    console.warn('  → no addresses found at all. Detection cannot start; the list may not have rendered yet.');
    return;
  }

  // 2. The climb: does an ancestor hold something that looks like a buy control?
  const isBuy = (el) => {
    const t = (el.textContent ?? '').trim();
    return !!t && t.length <= 24 && BUY_TEXT.test(t);
  };
  const cardOf = (el) => {
    let cur = el;
    for (let i = 0; i < 12 && cur; i++) {
      if ([...cur.querySelectorAll('button, [role="button"]')].some(isBuy)) return cur;
      cur = cur.parentElement;
    }
    return null;
  };

  const cards = new Set();
  let noCard = 0;
  for (const c of carriers) {
    const card = cardOf(c);
    if (card) cards.add(card);
    else noCard++;
  }
  line('carriers that found a card', carriers.length - noCard);
  line('carriers with NO buy control', noCard);
  line('distinct cards', cards.size);

  if (cards.size === 0) {
    console.warn('  → no ancestor within 12 levels holds a buy-looking control.');
    const sample = carriers[0];
    const btns = [...(sample.closest('div,li,article,section') ?? sample).querySelectorAll('button')]
      .slice(0, 8)
      .map((b) => JSON.stringify((b.textContent ?? '').trim().slice(0, 24)));
    console.log('  nearby button labels:', btns.join(' ') || '(none)');
    return;
  }

  // 3. The chain gate — the step most likely to be silently rejecting everything.
  const isRobinhood = (card) =>
    [...card.querySelectorAll('img')].some(
      (i) =>
        (i.getAttribute('alt') ?? '').trim().toLowerCase() === 'robinhood' ||
        /robinhood-logo|eth-robinhood/i.test(i.getAttribute('src') ?? ''),
    );

  const passing = [...cards].filter(isRobinhood);
  line('cards passing the chain gate', `${passing.length} of ${cards.size}`);

  if (passing.length === 0) {
    console.warn('  → every card was rejected as not-Robinhood. The badge markup has probably changed.');
    const badges = [...[...cards][0].querySelectorAll('img')]
      .slice(0, 8)
      .map((i) => `${JSON.stringify(i.getAttribute('alt') ?? '')}=${(i.getAttribute('src') ?? '').split('/').pop()}`);
    console.log('  images in the first card:', badges.join('  ') || '(none)');
    return;
  }

  console.log(
    `%c  → detection is fine: ${passing.length} card(s) should be decorated.`,
    'color:#0a0',
  );
  console.log('  So the content script is not running, or is failing before it mounts.');
  console.log('  Check devtools console with the Verbose level enabled — the extension');
  console.log('  reports scan errors through console.debug, which Chrome hides by default.');
})();
