const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stringsCommand, saveRegistry, loadRegistry } = require('../commands/strings');

function inTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-strings-mut-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return fn(dir);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function capture(fn) {
  const lines = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { code: fn(), out: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
  }
}

function seed() {
  saveRegistry({ version: 1, strings: [], terms: [{ ban: 'live', prefer: 'active', why: '' }] });
}

// Bare `term` has no --list flag, so only the right side of the guard
// (no --ban, no --remove) sends it to the listing branch. If that guard
// required --list too, a bare call would wrongly hit the usage error.
test('bare term lists the preferred terms and exits 0', () => {
  inTmp(() => {
    seed();
    const { code, out } = capture(() => stringsCommand(['term']));
    assert.equal(code, 0);
    assert.match(out, /preferred terms/);
    assert.match(out, /"live"/);
  });
});

// With --list plus --remove, the listing branch should win: real callers
// combine flags and --list is documented to show the terms. If the guard
// required both sides, the term would be deleted instead of shown.
test('term --list --remove shows the list and keeps the term', () => {
  inTmp(() => {
    seed();
    const { code, out } = capture(() => stringsCommand(['term', '--list', '--remove', 'live']));
    assert.equal(code, 0);
    assert.match(out, /preferred terms/);
    const terms = loadRegistry().terms;
    assert.equal(terms.length, 1);
    assert.equal(terms[0].ban, 'live');
  });
});
