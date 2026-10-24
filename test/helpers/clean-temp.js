'use strict';

// Load this first in a test file that makes temp folders. It remembers every
// folder made through fs.mkdtemp (sync, callback, or promise) in this process
// and deletes them when the process exits, so a test that forgets its own
// cleanup still leaves nothing behind. Each test file runs in its own
// process under node --test, so this only touches that file's folders.
const fs = require('fs');

const made = new Set();
const remember = (dir) => { if (typeof dir === 'string') made.add(dir); return dir; };

if (!fs.mkdtempSync.__cleanTemp) {
  const { mkdtempSync, mkdtemp } = fs;
  const mkdtempPromise = fs.promises.mkdtemp;
  fs.mkdtempSync = function (...args) { return remember(mkdtempSync.apply(this, args)); };
  fs.mkdtempSync.__cleanTemp = true;
  fs.mkdtemp = function (...args) {
    const cb = args.pop();
    return mkdtemp.call(this, ...args, (err, dir) => { if (!err) remember(dir); cb(err, dir); });
  };
  fs.promises.mkdtemp = async function (...args) { return remember(await mkdtempPromise.apply(this, args)); };
  process.on('exit', () => {
    for (const dir of made) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
}

module.exports = { tempDirsMade: () => [...made] };
