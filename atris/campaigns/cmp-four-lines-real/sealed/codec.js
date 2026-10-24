'use strict';
// A typed tree, written out by hand: every value is tagged by what it is, so
// nothing the agent returns can pose as a tag, and no toJSON, getter on a
// prototype, or patched global can change what is written. The built-ins it
// uses are captured when this file loads, before any agent code runs.
const S = JSON.stringify, P = JSON.parse, keys = Object.keys, isArr = Array.isArray, is = Object.is;
const own = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
const Big = BigInt, Num = Number;
const bindA = (m) => Function.prototype.call.bind(Array.prototype[m]);
const push = bindA('push'), pop = bindA('pop'), join = bindA('join'), map = bindA('map'), includes = bindA('includes');

function write(v, seen) {
  if (v === undefined) return '{"t":"u"}';
  if (v === null) return '{"t":"z"}';
  const k = typeof v;
  if (k === 'number') return `{"t":"n","v":"${v !== v ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : is(v, -0) ? '-0' : S(v)}"}`;
  if (k === 'string') return `{"t":"s","v":${S(v)}}`;
  if (k === 'boolean') return `{"t":"b","v":${v ? 'true' : 'false'}}`;
  if (k === 'bigint') return `{"t":"g","v":"${v < 0 ? '-' : ''}${S(Num(v < 0 ? -v : v))}"}`;
  if (k !== 'object') return `{"t":"x","v":${S(k)}}`;
  if (includes(seen, v)) return '{"t":"c"}';
  push(seen, v);
  let body;
  if (isArr(v)) {
    const parts = [];
    for (let i = 0; i < v.length; i++) push(parts, own(v, i) ? write(v[i], seen) : '{"t":"h"}');
    body = `{"t":"a","v":[${join(parts, ',')}]}`;
  } else {
    body = `{"t":"o","v":{${join(map(keys(v), (key) => `${S(key)}:${write(v[key], seen)}`), ',')}}}`;
  }
  pop(seen);
  return body;
}
function read(n) {
  switch (n.t) {
    case 'u': return undefined;
    case 'z': return null;
    case 'n': return n.v === '-0' ? -0 : Num(n.v);
    case 's': case 'b': return n.v;
    case 'g': return Big(n.v);
    case 'a': { const a = new Array(n.v.length); n.v.forEach((x, i) => { if (x.t !== 'h') a[i] = read(x); }); return a; }
    case 'o': { const o = {}; for (const [k, x] of Object.entries(n.v)) o[k] = read(x); return o; }
    default: return { unsupported: n.t };
  }
}
const enc = (v) => write(v, []);
module.exports = { enc, dec: (s) => read(P(s)), same: (a, b) => enc(a) === enc(b) };
