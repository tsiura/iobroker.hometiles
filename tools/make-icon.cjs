'use strict';

/*
 * Draws the adapter icon, admin/hometiles.png: a dark panel holding a 2 x 2
 * grid of coloured tiles, 256 x 256 RGBA with anti-aliased edges. Uses only
 * Node's zlib, so it needs no dependency. From the repository root:
 *
 *   node tools/make-icon.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
/** Samples per pixel along each axis: the edges' anti-aliasing. */
const SAMPLES = 4;

/** Back to front: [left, top, right, bottom, corner radius] and an RGB colour. */
const SHAPES = [
  { rect: [8, 8, 248, 248, 48], color: [31, 41, 55] },
  { rect: [40, 40, 120, 120, 18], color: [245, 158, 11] },
  { rect: [136, 40, 216, 120, 18], color: [56, 189, 248] },
  { rect: [40, 136, 120, 216, 18], color: [52, 211, 153] },
  { rect: [136, 136, 216, 216, 18], color: [229, 231, 235] },
];

function inside(x, y, [left, top, right, bottom, radius]) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** One pixel: the colour of the front-most shape at each sample, averaged; uncovered samples are transparent. */
function pixel(px, py) {
  const sum = [0, 0, 0];
  let covered = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = px + (sx + 0.5) / SAMPLES;
      const y = py + (sy + 0.5) / SAMPLES;
      const shape = SHAPES.findLast((candidate) => inside(x, y, candidate.rect));
      if (!shape) continue;
      covered++;
      for (let i = 0; i < 3; i++) sum[i] += shape.color[i];
    }
  }
  if (covered === 0) return [0, 0, 0, 0];
  return [...sum.map((value) => Math.round(value / covered)), Math.round((255 * covered) / SAMPLES ** 2)];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk: length, type, data and the CRC of type and data. */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// Each row: filter type 0 (none), then its RGBA pixels.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 4);
  for (let x = 0; x < SIZE; x++) Buffer.from(pixel(x, y)).copy(raw, row + 1 + x * 4);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
// Bit depth 8, colour type 6 (RGBA), deflate, adaptive filtering, no interlace.
header.set([8, 6, 0, 0, 0], 8);

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const target = path.join(__dirname, '..', 'admin', 'hometiles.png');
fs.writeFileSync(target, png);
console.log(`Wrote ${target}: ${SIZE} x ${SIZE}, ${png.length} bytes`);
