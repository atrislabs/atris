'use strict';
if (require.main !== module) return;
// runner.js <agent-src-dir> <module> <function>: reads encoded args on stdin,
// calls the agent's function, prints {value, args, error}. Runs sealed: it
// cannot read the held-out tests, the network, or the real home.
const fs = require('fs');
const path = require('path');
const { enc, dec } = require('./codec');
const [dir, mod, fn] = process.argv.slice(2);
const args = dec(fs.readFileSync(0, 'utf8'));
let out;
try {
  const value = require(path.join(dir, mod))[fn](...args);
  out = { value, args };
} catch (error) {
  out = { error: { name: error && error.name, message: String(error && error.message) }, args };
}
process.stdout.write(enc(out));
