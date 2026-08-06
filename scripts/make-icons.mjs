/**
 * scripts/make-icons.mjs — rasterise the toolbar icons from `assets/icon.svg`.
 *
 * This script used to *generate* placeholder icons: a flat mark on a dark tile,
 * deliberately plain so it read as unfinished. Rory has since supplied real
 * artwork, so a script that writes placeholders over it would be a loaded gun
 * left in the drawer. It now renders the committed source instead.
 *
 * It does not rasterise here. There is no image dependency in this repo and
 * adding one to draw three icons would be worse than the alternative: it writes
 * a page that draws the SVG onto a canvas at each size, which is the browser's
 * own rasteriser and needs nothing installed.
 *
 * Per size, not downsampled from one bitmap. `assets/icon.svg` carries two
 * variants — the full mark, and a simplified one for 16px where the flap's
 * outline is thinner than a pixel and degrades to a smudge.
 *
 *   node scripts/make-icons.mjs
 *   → open the printed URL, then follow the on-page instructions
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(resolve(root, 'assets/icon.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .trim();

/** 16 uses the simplified variant; everything above it uses the full mark. */
const SIZES = [
  { size: 128, use: 'mark' },
  { size: 48, use: 'mark' },
  { size: 16, use: 'mark-small' },
];

const out = resolve(root, 'apps/extension/dist');
mkdirSync(out, { recursive: true });

const page = `<!doctype html><meta charset="utf-8"><title>Hoodini icons</title>
<body style="background:#141a16;margin:0;padding:28px;font:13px/1.6 ui-monospace,monospace;color:#8fa89a">
<h1 style="font-size:15px;color:#e9eef7;margin:0 0 4px">Toolbar icons</h1>
<p style="margin:0 0 20px">Rendered from <code>assets/icon.svg</code>. Each is drawn at its own size.</p>
<div id="strip" style="display:flex;gap:26px;align-items:flex-end;margin-bottom:24px"></div>
<p style="margin:0 0 8px">Copy the hex below and write the files:</p>
<pre style="user-select:all;background:#0d1310;border:1px solid #24322b;border-radius:7px;padding:12px;overflow:auto;max-height:160px;font-size:11px" id="hex">rendering…</pre>
<p style="margin:12px 0 0;color:#5f7a6b">Hex rather than base64: these travel through a shell on the way to disk,
and base64's <code>+ / =</code> are exactly the characters that get mangled en route. Verify the CRC of every chunk
after writing — a corrupt IDAT still looks like a PNG to <code>file(1)</code>.</p>
<script>
const SVG = ${JSON.stringify(svg)};
const SIZES = ${JSON.stringify(SIZES)};
const strip = document.getElementById('strip');
const hexes = {};

function render({ size, use }) {
  return new Promise((res) => {
    const src = SVG
      .replace('width="128" height="128"', 'width="' + size + '" height="' + size + '"')
      .replace('<use href="#mark"', '<use href="#' + use + '"');
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, size, size);
      const bin = atob(c.toDataURL('image/png').split(',')[1]);
      let h = '';
      for (let i = 0; i < bin.length; i++) h += bin.charCodeAt(i).toString(16).padStart(2, '0');
      hexes[size] = h;

      const p = document.createElement('canvas');
      const scale = Math.max(1, Math.round(160 / size));
      p.width = p.height = size * scale;
      const px = p.getContext('2d');
      px.imageSmoothingEnabled = false;
      px.drawImage(c, 0, 0, size * scale, size * scale);
      p.style.cssText = 'image-rendering:pixelated;border:1px solid #24322b;border-radius:4px';
      const cell = document.createElement('div');
      cell.appendChild(p);
      cell.insertAdjacentHTML('beforeend', '<div style="margin-top:6px">' + size + 'px</div>');
      strip.appendChild(cell);
      res();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src);
  });
}

(async () => {
  for (const s of SIZES) await render(s);
  document.getElementById('hex').textContent = JSON.stringify(hexes, null, 1);
})();
</script>`;

writeFileSync(resolve(out, 'icons-preview.html'), page);
console.log('wrote apps/extension/dist/icons-preview.html');
console.log('serve apps/extension/dist and open icons-preview.html, then write the hex to');
console.log('apps/extension/public/icons/icon-{16,48,128}.png — validating every chunk CRC.');
