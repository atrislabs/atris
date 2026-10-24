'use strict';
// A typed tree, not JSON: every value is tagged by what it is, so nothing the
// agent returns can pose as a tag, toJSON never runs, and undefined, NaN,
// Infinity, -0, and array holes come back exactly.
function enc(v, seen = new Set()) {
  if (v === undefined) return { t: 'u' };
  if (v === null) return { t: 'z' };
  const k = typeof v;
  if (k === 'number') return { t: 'n', v: Object.is(v, -0) ? '-0' : String(v) };
  if (k === 'string') return { t: 's', v };
  if (k === 'boolean') return { t: 'b', v };
  if (k === 'bigint') return { t: 'g', v: String(v) };
  if (k !== 'object') return { t: 'x', v: k }; // functions, symbols: kept as a type only
  if (seen.has(v)) return { t: 'c' };
  seen.add(v);
  if (Array.isArray(v)) {
    const items = [];
    for (let i = 0; i < v.length; i++) items.push(Object.prototype.hasOwnProperty.call(v, i) ? enc(v[i], seen) : { t: 'h' });
    seen.delete(v);
    return { t: 'a', v: items };
  }
  const o = {};
  for (const key of Object.keys(v)) o[key] = enc(v[key], seen);
  seen.delete(v);
  return { t: 'o', v: o };
}
function dec(n) {
  switch (n.t) {
    case 'u': return undefined;
    case 'z': return null;
    case 'n': return n.v === '-0' ? -0 : Number(n.v);
    case 's': case 'b': return n.v;
    case 'g': return BigInt(n.v);
    case 'a': { const a = new Array(n.v.length); n.v.forEach((x, i) => { if (x.t !== 'h') a[i] = dec(x); }); return a; }
    case 'o': { const o = {}; for (const [k, x] of Object.entries(n.v)) o[k] = dec(x); return o; }
    default: return { unsupported: n.t };
  }
}
module.exports = { enc: (v) => JSON.stringify(enc(v)), dec: (s) => dec(JSON.parse(s)), same: (a, b) => JSON.stringify(enc(a)) === JSON.stringify(enc(b)) };
