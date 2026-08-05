/**
 * scripts/make-icons.mjs — generate placeholder toolbar icons.
 *
 * Not branding. Rory owns the real artwork; this exists because an action with
 * no icon has nowhere to render a badge, so the pending-trade signal silently
 * did nothing. A placeholder that works beats a blocker that waits.
 *
 * Deliberately plain — a flat mark on a dark tile, no wordmark, no logo — so
 * that it reads as unfinished rather than as a design decision somebody made.
 *
 * No image dependency: a PNG is a signature, three chunks and a CRC, and
 * pulling in a library to draw two rectangles would be worse.
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/extension/public/icons');

const BG = [10, 10, 11, 255]; // near-black, matches the overlay panel
const FG = [123, 241, 168, 255]; // the overlay's green

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  // One filter byte (0 = none) per scanline, then RGBA.
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A rounded tile with a bold H cut out of it. Legible at 16px, which is the bar. */
function draw(x, y, size) {
  const r = size * 0.22; // corner radius
  const inset = 0;
  const dx = Math.min(x - inset, size - 1 - inset - x);
  const dy = Math.min(y - inset, size - 1 - inset - y);
  // Outside the rounded corner → transparent.
  if (dx < r && dy < r) {
    const cx = dx < r ? r : dx;
    const cy = dy < r ? r : dy;
    if (Math.hypot(cx - dx, cy - dy) > r) return [0, 0, 0, 0];
  }

  const u = x / size;
  const v = y / size;
  const barTop = v > 0.24 && v < 0.76;
  const leftBar = u > 0.26 && u < 0.4 && barTop;
  const rightBar = u > 0.6 && u < 0.74 && barTop;
  const cross = v > 0.43 && v < 0.57 && u > 0.26 && u < 0.74;

  return leftBar || rightBar || cross ? FG : BG;
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = resolve(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size, draw));
  console.log(`wrote ${file}`);
}
console.log('\nPlaceholders. Replace with real artwork before submitting to the Chrome Web Store.');
