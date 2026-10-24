'use strict';
// JSON that keeps the values a test can tell apart: undefined, NaN, Infinity, -0.
const enc = (v) => JSON.stringify(v, (k, x) => {
  if (x === undefined) return { $u: 1 };
  if (typeof x === 'number' && !Number.isFinite(x)) return { $n: String(x) };
  if (Object.is(x, -0)) return { $n: '-0' };
  return x;
});
const dec = (s) => JSON.parse(s, (k, x) => {
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    if (x.$u === 1 && Object.keys(x).length === 1) return undefined;
    if (typeof x.$n === 'string' && Object.keys(x).length === 1) return x.$n === '-0' ? -0 : Number(x.$n);
  }
  return x;
});
// JSON.parse drops properties whose reviver returns undefined; arrays keep holes as undefined
module.exports = { enc, dec };
