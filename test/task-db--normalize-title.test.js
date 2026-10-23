'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-normalize-title-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { normalizeTitle } = require('../lib/task-db');

test('a normal title folds to the same dedupe key', () => {
  assert.strictEqual(normalizeTitle('Fix the Login Bug'), 'fix the login bug');
  assert.strictEqual(normalizeTitle('  Ship the CLI  '), 'ship the cli');
  assert.strictEqual(normalizeTitle('Fix the bug!'), normalizeTitle('  FIX   THE BUG  '));
});

test('messy titles keep digits and collapse spacing', () => {
  assert.strictEqual(normalizeTitle('Ping #42:\n\nnow'), 'ping 42 now');
  assert.strictEqual(normalizeTitle('a - b'), 'a  b');
  assert.strictEqual(normalizeTitle('Reopen\tthe  DB!!'), 'reopen the db');
});

test('blank and falsy titles become an empty key', () => {
  assert.strictEqual(normalizeTitle(''), '');
  assert.strictEqual(normalizeTitle('   \n\t  '), '');
  assert.strictEqual(normalizeTitle('!!!'), '');
  assert.strictEqual(normalizeTitle(null), '');
  assert.strictEqual(normalizeTitle(undefined), '');
  assert.strictEqual(normalizeTitle(0), '');
  assert.strictEqual(normalizeTitle(false), '');
});
