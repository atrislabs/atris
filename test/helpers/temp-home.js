'use strict';

// Points HOME and the put-away store at a fresh temp folder for the whole
// test file, so nothing a test runs can write into the real home folder.
// Require it before anything that reads HOME. Child processes inherit it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-HOME-')));
const prior = { HOME: process.env.HOME, ATRIS_PUT_AWAY_DIR: process.env.ATRIS_PUT_AWAY_DIR };
process.env.HOME = home;
process.env.ATRIS_PUT_AWAY_DIR = path.join(home, '.atris', 'put-away');

test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

module.exports = { home, putAwayDir: process.env.ATRIS_PUT_AWAY_DIR };
