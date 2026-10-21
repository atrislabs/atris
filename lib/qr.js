'use strict';

// A small QR code encoder: byte mode, error correction level M, versions 1
// to 10 (up to 213 bytes, plenty for a link). Follows the QR spec (ISO 18004)
// the same way most small encoders do: pick the smallest version that fits,
// add Reed-Solomon error correction per block, interleave, place the bits,
// then try all eight masks and keep the one with the lowest penalty.
//
// encodeQr(text) -> { version, size, mask, modules } where modules[y][x] is
// true for a dark square. qrLines(text) renders it for a terminal with half
// block characters, two rows of squares per line, quiet zone included.

const MAX_VERSION = 10;
// Level M tables, index = version (index 0 unused).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const ECC_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_BITS_M = 0;

function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * ECC_BLOCKS[ver];
}

// Multiply in GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function getBit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

// Data bits for byte mode, padded to the version's data capacity.
function dataBytes(bytes, ver) {
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  return out;
}

// Split into blocks, add error correction to each, and interleave.
function withEcc(data, ver) {
  const numBlocks = ECC_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
    });
  }
  return result;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function makeGrid(ver) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  return { ver, size, modules, isFunction, set };
}

function drawFormatBits(grid, mask) {
  const { size, set } = grid;
  const data = (FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i += 1) set(8, i, getBit(bits, i));
  set(8, 7, getBit(bits, 6));
  set(8, 8, getBit(bits, 7));
  set(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, getBit(bits, i));
  set(8, size - 8, true);
}

function drawVersion(grid) {
  const { ver, size, set } = grid;
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const bit = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(a, b, bit);
    set(b, a, bit);
  }
}

function drawFunctionPatterns(grid) {
  const { size, set } = grid;
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (x, y) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const pos = alignmentPositions(grid.ver);
  const n = pos.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(grid, 0);
  drawVersion(grid);
}

function drawCodewords(grid, data) {
  const { size, modules, isFunction } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < data.length * 8) {
          modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid, mask) {
  const { size, modules, isFunction } = grid;
  const test = MASKS[mask];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isFunction[y][x] && test(x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

// The spec's four penalty rules: runs of 5+ in a line, 2x2 blocks, finder
// look-alikes (1:1:3:1:1 with 4 light on a side), and dark/light balance.
function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const line = get => {
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        run = 1;
      }
    }
    for (let i = 0; i + 10 < size + 4; i += 1) {
      const at = k => (i + k >= 0 && i + k < size ? get(i + k) : false);
      const core = at(0) && !at(1) && at(2) && at(3) && at(4) && !at(5) && at(6);
      if (!core) continue;
      const lightBefore = [1, 2, 3, 4].every(k => !at(-k));
      const lightAfter = [7, 8, 9, 10].every(k => !at(k));
      if (lightBefore || lightAfter) score += 40;
    }
  };
  for (let y = 0; y < size; y += 1) line(x => modules[y][x]);
  for (let x = 0; x < size; x += 1) line(y => modules[y][x]);
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark += 1;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

function encodeQr(text, { mask: forcedMask = null } = {}) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let ver = 1;
  for (; ver <= MAX_VERSION; ver += 1) {
    const needed = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (needed <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) throw new Error(`text too long for a QR code here (${bytes.length} bytes, max 213)`);
  const grid = makeGrid(ver);
  drawFunctionPatterns(grid);
  drawCodewords(grid, withEcc(dataBytes(bytes, ver), ver));
  let mask = forcedMask;
  if (mask == null) {
    let best = Infinity;
    for (let m = 0; m < 8; m += 1) {
      applyMask(grid, m);
      drawFormatBits(grid, m);
      const p = penalty(grid.modules);
      if (p < best) {
        best = p;
        mask = m;
      }
      applyMask(grid, m);
    }
  }
  applyMask(grid, mask);
  drawFormatBits(grid, mask);
  return { version: ver, size: grid.size, mask, modules: grid.modules };
}

// Terminal art: two rows of squares per line with half block characters.
// With color on (the default) each line forces black on bright white, so the
// code scans the same on a dark or a light terminal. With color off, light
// squares print as blocks, which reads right on a dark terminal.
const FULL = '█';
const UPPER = '▀';
const LOWER = '▄';

function qrLines(text, { quiet = 2, color = true } = {}) {
  const { modules, size } = encodeQr(text);
  const at = (x, y) => (x >= 0 && y >= 0 && x < size && y < size ? modules[y][x] : false);
  const lines = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < size + quiet; x += 1) {
      const top = color ? at(x, y) : !at(x, y);
      const bottom = color ? at(x, y + 1) : !at(x, y + 1);
      line += top && bottom ? FULL : top ? UPPER : bottom ? LOWER : ' ';
    }
    lines.push(color ? `\x1b[30;107m${line}\x1b[0m` : line);
  }
  return lines;
}

module.exports = { encodeQr, qrLines, rsDivisor, rsRemainder, gfMul, dataCodewords, alignmentPositions };
