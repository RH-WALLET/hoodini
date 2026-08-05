/**
 * diagnose-placement.js — the overlay mounted, so why can nobody see it?
 *
 * Run after diagnose-overlay.js reports hosts already in the DOM. Reports, for
 * the first few overlays: where they sit, whether an ancestor clips them, and
 * what is painted on top of them.
 *
 * Reads only, except that it flashes the first overlay outline so you can spot
 * it on screen — that outline is removed after five seconds.
 */

(() => {
  const hosts = [...document.querySelectorAll('[data-hoodini]')];
  console.log('%c[hoodini] placement diagnosis', 'font-weight:bold');
  console.log(`  ${hosts.length} overlay host(s)`);
  if (!hosts.length) return console.warn('  none mounted — run diagnose-overlay.js instead');

  const vw = innerWidth;
  const vh = innerHeight;

  hosts.slice(0, 3).forEach((host, i) => {
    const r = host.getBoundingClientRect();
    const cs = getComputedStyle(host);
    console.log(`\n  ── host ${i} ──`);
    console.log(`  rect            ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    console.log(`  in viewport     ${r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw}  (viewport ${vw}x${vh})`);
    console.log(`  display/opacity ${cs.display} / ${cs.opacity} / visibility:${cs.visibility}`);
    console.log(`  z-index         ${cs.zIndex}`);

    // Who is actually painted at the overlay's centre?
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const onTop = document.elementFromPoint(cx, cy);
    const covered = onTop && onTop !== host && !host.contains(onTop);
    console.log(`  element at centre ${onTop ? `<${onTop.tagName.toLowerCase()} class="${(onTop.className ?? '').toString().slice(0, 60)}">` : '(none — off screen)'}`);
    console.log(`  COVERED BY PAGE   ${covered}`);

    // Does an ancestor clip it away?
    let clipper = null;
    for (let el = host.parentElement, n = 0; el && n < 10; el = el.parentElement, n++) {
      const s = getComputedStyle(el);
      if (/hidden|clip|auto|scroll/.test(s.overflow + s.overflowY + s.overflowX)) {
        const pr = el.getBoundingClientRect();
        const outside = r.top >= pr.bottom - 1 || r.bottom <= pr.top + 1 || r.left >= pr.right - 1 || r.right <= pr.left + 1;
        clipper = { el, overflow: s.overflow, outside, pr };
        console.log(`  clipping ancestor <${el.tagName.toLowerCase()} class="${el.className.toString().slice(0, 50)}">`);
        console.log(`     overflow=${s.overflow} rect=${Math.round(pr.left)},${Math.round(pr.top)} ${Math.round(pr.width)}x${Math.round(pr.height)}`);
        console.log(`     OVERLAY OUTSIDE IT: ${outside}`);
        break;
      }
    }
    if (!clipper) console.log('  no clipping ancestor within 10 levels');

    // Where does it sit inside its own card?
    const card = host.parentElement;
    if (card) {
      const cr = card.getBoundingClientRect();
      console.log(`  parent card     ${Math.round(cr.width)}x${Math.round(cr.height)} — overlay offset from its top: ${Math.round(r.top - cr.top)}px`);
      console.log(`  parent overflows: ${card.scrollHeight > card.clientHeight + 1}`);
    }
  });

  // Make the first one impossible to miss, briefly.
  const first = hosts[0];
  const prev = first.getAttribute('style') ?? '';
  first.setAttribute('style', `${prev};outline:3px solid magenta!important;outline-offset:2px;`);
  console.log('\n  → first overlay outlined in magenta for 5s. Scroll to it if you cannot see it.');
  setTimeout(() => first.setAttribute('style', prev), 5000);
})();
