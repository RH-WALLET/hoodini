/**
 * scripts/social-preview.mjs — P15 in a browser, without installing anything.
 *
 * P15 is a *layout* claim: a strip injected into a tweet is stretched by X's
 * column layout into a tall stack of squeezed buttons, and a floating panel is
 * immune to that. Neither half can be settled by reading code or by a jsdom
 * test — jsdom has no layout engine, so it reports every element as 0×0 and
 * would call both versions fine. This renders both against tweet-shaped markup
 * in a real browser and measures them.
 *
 * The same trick as `popup-preview.mjs`: bundle the *real* modules and drive
 * them, so what is on screen is the shipped overlay and the shipped panel
 * rather than a mock-up of either.
 *
 * One thing it deliberately does not cover: the content script chooses its
 * adapter with `matchesSite(a, location.href)`, and this page is served from
 * localhost. Site matching is pinned by test instead (sites.test.ts). What is
 * checked here is everything downstream of that choice.
 *
 *   pnpm build && node scripts/social-preview.mjs
 *   python3 -m http.server 4175 --directory apps/extension/dist
 *   → http://localhost:4175/social-preview.html
 *
 * The measurements are also on `window.__p15`, so the page can be checked
 * without reading it. Writes into dist, which is gitignored. Nothing here ships.
 */

import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'apps/extension/dist');

if (!existsSync(dist)) {
  console.error('No dist. Run: pnpm build');
  process.exit(1);
}

// Vite belongs to the extension, not to the root, so resolve it from there.
const require = createRequire(pathToFileURL(resolve(root, 'apps/extension/package.json')));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);

// The real modules, bundled the same way the extension bundles them.
const entry = resolve(dist, '.social-preview-entry.js');
writeFileSync(
  entry,
  `export {
     createXAdapter, createDexScreenerAdapter, ConfigurableSiteAdapter,
     mountOverlay, mountPanel, unmountPanel, setPanelStatus,
     pageTokenAddress, pageToken, HOST_ATTR, PANEL_ATTR,
   } from '@hoodini/adapters';\n`,
);

await build({
  root,
  logLevel: 'warn',
  build: {
    lib: { entry, formats: ['es'], fileName: () => 'social-preview.lib.js' },
    outDir: dist,
    emptyOutDir: false,
    minify: false,
  },
});

rmSync(entry, { force: true });

const TOKEN = '0x3CfDc3924d405c98230099e1826fF846BDBbb804';

/**
 * A tweet, shaped the way X shapes one.
 *
 * The part that matters is that every level is a column flexbox with the
 * default `align-items: stretch` — that is what takes an appended inline
 * control and pulls it to the full width of the column, and what turns the
 * strip's own row of buttons into a stack. Reproduced by hand because no X DOM
 * snapshot has been captured (BUILD-PLAN P4); the classes are X's, the layout
 * is what X's stylesheet computes to.
 */
const TWEET = (id) => `
  <article data-testid="tweet" class="tweet" id="${id}">
    <div class="avatar"></div>
    <div class="col">
      <div class="who"><b>hood dev</b> <span class="at">@hooddev · 2h</span></div>
      <div class="body">new one just launched on RH chain ${TOKEN} — early</div>
      <div class="actions"><span>reply</span><span>repost</span><span>like</span></div>
    </div>
  </article>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hoodini — P15 social preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #000; color: #e7e9ea;
         font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  h1 { font-size: 15px; margin: 0; padding: 14px 16px; border-bottom: 1px solid #2f3336; }
  .split { display: grid; grid-template-columns: 1fr 1fr; }
  .side { border-right: 1px solid #2f3336; min-height: 100vh; }
  .side > h2 { font-size: 13px; margin: 0; padding: 10px 16px; color: #8b98a5;
               border-bottom: 1px solid #2f3336; font-weight: 600; }
  .verdict { padding: 8px 16px; font: 600 12px ui-monospace, monospace; }
  .ok { color: #7bf1a8; } .bad { color: #ff9a9a; }

  /* X's timeline column. The article is a *row* — avatar beside a content
     column — and that is the shape that does the damage: anything appended to
     the article becomes a third row item, gets whatever width is left over,
     and is stretched to the full height of the tweet. */
  .timeline { width: 598px; max-width: 100%; }
  .tweet { display: flex; flex-direction: row; align-items: stretch; gap: 12px;
           padding: 12px 16px; border-bottom: 1px solid #2f3336; }
  .tweet .avatar { flex: 0 0 40px; width: 40px; height: 40px; border-radius: 50%; background: #333639; }
  .tweet .col { flex: 1 1 auto; min-width: 0;
                display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
  .at { color: #71767b; font-weight: 400; }
  .body { white-space: normal; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 48px; color: #71767b; font-size: 13px; padding-top: 8px; }
</style>
</head><body>
<h1>P15 — a strip in a tweet, and a panel over one</h1>
<div class="split">
  <div class="side">
    <h2>before — panelOnly off, strip mounted into the tweet</h2>
    <div class="verdict" id="v-before">measuring…</div>
    <div class="timeline" id="before">${TWEET('t-before')}</div>
  </div>
  <div class="side">
    <h2>after — panelOnly on: no strip, floating panel</h2>
    <div class="verdict" id="v-after">measuring…</div>
    <div class="timeline" id="after">${TWEET('t-after')}</div>
  </div>
</div>

<script type="module">
import {
  createXAdapter, ConfigurableSiteAdapter, mountOverlay, mountPanel,
  setPanelStatus, HOST_ATTR, PANEL_ATTR,
} from './social-preview.lib.js';

const TOKEN = '${TOKEN}';
const CHAIN = 4663;
const token = { address: TOKEN, chainId: CHAIN };
const PRESETS = ['0.001', '0.01', '0.05', '0.1', '0.5', '1'];

// ── before: what P15 is replacing. The shipped strip, appended into the tweet.
mountOverlay(document.getElementById('t-before'), token, {
  onIntent: () => {},
  amounts: PRESETS,
  config: { slippageBps: 100 },
});

// ── after: the adapter as it now ships. Detect, resolve, mount nothing.
const x = createXAdapter({ chainId: CHAIN, onIntent: () => {}, amounts: PRESETS });
const scope = document.getElementById('after');
const detected = x.detectTokens(document);
const anchors = detected.flatMap((t) => x.findAnchors(t)).filter((a) => scope.contains(a));
for (const a of anchors) x.mount(a, detected[0]);

/**
 * The panel's token, by the same rule the content script now uses: the route
 * names nothing on a social page, so "the adapter found exactly one" stands in.
 */
const inScope = x.detectTokens(scope);
const panelToken = x.panelOnly && inScope.length === 1 ? inScope[0] : null;

if (panelToken) {
  mountPanel(document, panelToken, {
    profiles: [{ name: 'Main', buyPresets: PRESETS, slippageBps: 100, maxFeeGwei: '0.5' }],
    sellPercents: [10, 25, 50, 75, 90, 100],
    onIntent: () => {},
    position: { x: 980, y: 300 },
  });
  // The gate a post cannot answer for itself (D-069).
  setPanelStatus(document, 'No Robinhood Chain venue trades this token. It is probably on another chain.');
}

// ── measure, rather than eyeball ──────────────────────────────────────────
const report = (id, lines) => { document.getElementById(id).innerHTML = lines.join('<br>'); };
const box = (el) => el ? el.getBoundingClientRect() : null;

const strip = box(document.querySelector('#t-before [' + HOST_ATTR + ']'));
report('v-before', [
  'strips in tweet: <span class="bad">' + document.querySelectorAll('#t-before [' + HOST_ATTR + ']').length + '</span>',
  strip ? 'strip box: <span class="bad">' + Math.round(strip.width) + '×' + Math.round(strip.height) + '</span>' : 'no strip',
  'anchor resolved: ' + (document.getElementById('t-before') ? 'yes' : 'no'),
]);

const panelHost = document.querySelector('[' + PANEL_ATTR + ']');
const panelBox = box(panelHost?.shadowRoot?.querySelector('.panel'));
const stretched = panelHost && getComputedStyle(panelHost.shadowRoot.querySelector('.panel')).position;
report('v-after', [
  'anchors resolved: <span class="ok">' + anchors.length + '</span> (detection still runs)',
  'strips in tweet: <span class="ok">' + document.querySelectorAll('#t-after [' + HOST_ATTR + ']').length + '</span>',
  'panel token: <span class="ok">' + (panelToken ? panelToken.address.slice(0, 10) + '…' : 'none') + '</span>',
  panelBox ? 'panel box: <span class="ok">' + Math.round(panelBox.width) + '×' + Math.round(panelBox.height) + '</span> ' + stretched : 'no panel',
]);

window.__p15 = {
  beforeStrips: document.querySelectorAll('#t-before [' + HOST_ATTR + ']').length,
  beforeStripBox: strip && { w: Math.round(strip.width), h: Math.round(strip.height) },
  afterStrips: document.querySelectorAll('#t-after [' + HOST_ATTR + ']').length,
  afterAnchors: anchors.length,
  panelToken: panelToken?.address ?? null,
  panelPosition: stretched,
  panelBox: panelBox && { w: Math.round(panelBox.width), h: Math.round(panelBox.height) },
};
</script>
</body></html>
`;

writeFileSync(resolve(dist, 'social-preview.html'), html);
console.log('wrote dist/social-preview.html — serve apps/extension/dist and open it');
