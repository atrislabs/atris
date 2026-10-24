'use strict';
if (require.main !== module) return;
// runner.js <agent-src-dir> <module> <function>: reads encoded args on stdin,
// calls the agent's function, prints {value, args, thrown}. Runs sealed: it
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
  // a real built-in error is checked here, in the realm that threw it;
  // anything else (a plain object named TypeError) comes back as plain data
  const C = error && typeof error === 'object' ? globalThis[error.name] : null;
  const builtin = typeof C === 'function' && (C === Error || C.prototype instanceof Error) && error instanceof C
    && Object.getPrototypeOf(error) === C.prototype;
  out = { args, thrown: builtin ? { builtin: error.name, message: String(error.message) } : { value: error } };
}
process.stdout.write(enc(out));
