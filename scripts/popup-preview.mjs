/**
 * scripts/popup-preview.mjs — render the popup outside Chrome, for design work.
 *
 * The popup is a normal React app that happens to talk to a service worker, so
 * the only thing stopping it rendering in a plain tab is `chrome.*`. This writes
 * a page that stubs those APIs with representative data and loads the real
 * built bundle, which means what you are looking at is the actual component
 * tree and the actual stylesheet rather than a mock-up of them.
 *
 * Regenerate after every build: `pnpm build` empties dist, and the asset names
 * are content-hashed.
 *
 *   pnpm --filter @hoodini/extension build && node scripts/popup-preview.mjs
 *   → open http://localhost:4174/popup-preview.html
 *
 * Writes into dist, which is gitignored. Nothing here ships.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'apps/extension/dist');
const entry = resolve(dist, 'src/popup/index.html');

if (!existsSync(entry)) {
  console.error('No built popup found. Run: pnpm --filter @hoodini/extension build');
  process.exit(1);
}

const html = readFileSync(entry, 'utf8');
const css = html.match(/assets\/index-[A-Za-z0-9_-]+\.css/)?.[0];
const js = html.match(/assets\/index\.html-[A-Za-z0-9_-]+\.js/)?.[0];
if (!css || !js) {
  console.error('Could not find the popup assets in the built index.html.');
  process.exit(1);
}

/** One holding priced, one priced differently, one that cannot be sold — the
 *  three states a row can be in, so the design is reviewed against all of them
 *  rather than against the happy one. */
const preview = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hoodini popup preview</title>
<script>
const ADDR = '0x1A463b7b289AD1C2Ad73Ff95Ea2C048D9BB8e051';
const q = new URLSearchParams(location.search);
const STATE = q.get('state') || 'unlocked';
const REPLIES = {
  'wallet.status': {
    hasVault: STATE !== 'setup',
    address: ADDR,
    isUnlocked: STATE === 'unlocked',
    autoLockMs: 900000,
  },
  'wallet.balance': { wei: '9186860490006000' },
  'positions.list': {
    positions: [
      { token: '0x3CfDc3924d405c98230099e1826fF846BDBbb804', symbol: 'YEW', decimals: 18, balance: '0', balanceFormatted: '398019.2404', valueWei: '995007240128386', valueAsset: null, valueUnavailableReason: null, venueId: 'uniswap-v4' },
      { token: '0xff5ed17855d6a4915a63643fe95e3f882acee887', symbol: 'PONS', decimals: 18, balance: '0', balanceFormatted: '12500.0000', valueWei: '2310000000000000', valueAsset: null, valueUnavailableReason: null, venueId: 'doppler' },
      { token: '0x05274cf4b065e8665cec084c4a41608926187777', symbol: 'HOOD', decimals: 18, balance: '0', balanceFormatted: '842.5500', valueWei: null, valueAsset: null, valueUnavailableReason: 'pool has no sell side', venueId: 'flap' },
    ],
    totalWei: '3305007240128386', valued: 2, unvalued: 1,
  },
  'settings.get': { buyPresets: ['0.001', '0.01', '0.1'], slippageBps: 100 },
  'consent.status': { armed: q.get('armed') === '1', armedAt: null, liveUnlocked: true },
  'trade.pending': q.get('pending') === '1'
    ? { request: { id: 'r1', side: 'buy', token: '0x3CfDc3924d405c98230099e1826fF846BDBbb804', amount: '1000000000000000', slippageBps: 100, origin: 'https://axiom.trade', createdAt: Date.now() } }
    : { request: null },
  'trade.quote': { out: '398019240430042974631535', quoteAsset: null, venueId: 'uniswap-v4' },
};
window.chrome = {
  runtime: {
    id: 'preview', getURL: (p) => p,
    sendMessage: async (m) => ({ ok: true, data: REPLIES[m.type] ?? {} }),
    onMessage: { addListener() {}, removeListener() {} },
  },
  tabs: { create() {} },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
};
</script>
<link rel="stylesheet" crossorigin href="/${css}">
</head><body><div id="root"></div>
<script type="module" crossorigin src="/${js}"></script>
</body></html>
`;

writeFileSync(resolve(dist, 'popup-preview.html'), preview);
console.log('wrote dist/popup-preview.html');
console.log('  states: ?state=unlocked | ?state=locked | ?state=setup');
console.log('  flags : &armed=1  &pending=1');
