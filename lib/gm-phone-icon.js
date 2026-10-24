'use strict';

// The phone page's icon: the lava orb's amber on the page's dark, small. An
// svg for the browser tab, and a 180px png for the home screen (iPhones take
// only a png there), drawn here with node's own zlib, no packages. Both go
// into the page inline as data, so no request for them ever needs the link's key.

const zlib = require('node:zlib');

const BG = [0x14, 0x11, 0x10];
// the lava's colors, lit from the upper left: cream where lit, amber, then deep
const LIT = [255, 232, 170];
const AMBER = [251, 150, 44];
const DEEP = [150, 52, 14];

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  + '<defs><radialGradient id="o" cx="40%" cy="38%" r="66%">'
  + '<stop offset="0" stop-color="#ffe8aa"/><stop offset=".38" stop-color="#fb962c"/><stop offset="1" stop-color="#96340e"/>'
  + '</radialGradient></defs>'
  + '<rect width="64" height="64" rx="14" fill="#141110"/><circle cx="32" cy="32" r="20" fill="url(#o)"/></svg>';

const iconSvg = () => `data:image/svg+xml,${encodeURIComponent(SVG)}`;

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = v => Math.max(0, Math.min(1, v));

// one pixel of the orb at (x, y) on a size-wide square, as [r, g, b]
function orbPixel(x, y, size) {
  const c = size / 2, r = size * 0.33;
  const d = Math.hypot(x - c, y - c);
  // the lit point sits up and to the left; the color runs from it outward
  const lit = Math.hypot(x - size * 0.43, y - size * 0.41) / (r * 1.32);
  const face = lit < 0.38 ? mix(LIT, AMBER, lit / 0.38) : mix(AMBER, DEEP, clamp01((lit - 0.38) / 0.62));
  // a soft glow just past the edge, then the page
  const glow = mix(BG, AMBER, 0.16 * Math.pow(clamp01(1 - (d - r) / (r * 0.5)), 2));
  const edge = clamp01(r + 0.5 - d);
  return mix(glow, face, edge).map(Math.round);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

// a size-wide square png of the orb, rgb with no alpha (the home screen fills
// see-through corners with black), each row filtered by its left neighbour so
// the smooth color compresses small
function orbPng(size = 180) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 1;
    let prev = [0, 0, 0];
    for (let x = 0; x < size; x++) {
      const px = orbPixel(x + 0.5, y + 0.5, size);
      for (let k = 0; k < 3; k++) raw[row + 1 + x * 3 + k] = (px[k] - prev[k]) & 0xff;
      prev = px;
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let touch = null;
const touchIconPng = () => (touch || (touch = `data:image/png;base64,${orbPng(180).toString('base64')}`));

module.exports = { iconSvg, touchIconPng };
