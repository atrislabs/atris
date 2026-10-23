'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { protectFile, saveProtect, readProtect } = require('../lib/campaign-protect');

test('protectFile puts protect.json under campaigns/<id> inside the home folder', () => {
  const home = path.join(os.tmpdir(), 'atris-protect-home');
  const file = protectFile(home, 'cmp-123');
  assert.strictEqual(file, path.join(home, 'campaigns', 'cmp-123', 'protect.json'));
  assert.strictEqual(path.basename(file), 'protect.json');
  assert.strictEqual(path.basename(path.dirname(file)), 'cmp-123');
});

test('protectFile gives each campaign its own file and is stable across calls', () => {
  const home = path.join(os.tmpdir(), 'atris-protect-home');
  const a = protectFile(home, 'alpha');
  const b = protectFile(home, 'beta');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, protectFile(home, 'alpha'));
  assert.strictEqual(path.dirname(path.dirname(a)), path.dirname(path.dirname(b)));
});

test('protectFile does not touch the disk: nothing is created by asking for the path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-protect-file-'));
  try {
    const file = protectFile(home, 'cmp-untouched');
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(fs.existsSync(path.join(home, 'campaigns')), false);
    assert.deepStrictEqual(fs.readdirSync(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('protectFile returns exactly the path saveProtect writes and readProtect reads', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-protect-file-'));
  try {
    const plan = { paths: ['judge/questions.md'], base_commit: 'abc123' };
    const written = saveProtect(home, 'cmp-roundtrip', plan);
    assert.strictEqual(written, protectFile(home, 'cmp-roundtrip'));
    assert.strictEqual(fs.existsSync(protectFile(home, 'cmp-roundtrip')), true);
    assert.deepStrictEqual(readProtect(home, 'cmp-roundtrip'), plan);
    assert.strictEqual(readProtect(home, 'cmp-other'), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('protectFile with an empty campaign id skips the id folder instead of failing', () => {
  const home = path.join(os.tmpdir(), 'atris-protect-home');
  assert.strictEqual(protectFile(home, ''), path.join(home, 'campaigns', 'protect.json'));
});

test('protectFile with a relative home keeps the path relative', () => {
  const file = protectFile('state', 'cmp-1');
  assert.strictEqual(file, path.join('state', 'campaigns', 'cmp-1', 'protect.json'));
  assert.strictEqual(path.isAbsolute(file), false);
});

test('protectFile throws a TypeError when home or the campaign id is missing', () => {
  const home = path.join(os.tmpdir(), 'atris-protect-home');
  assert.throws(() => protectFile(undefined, 'cmp-1'), TypeError);
  assert.throws(() => protectFile(home, undefined), TypeError);
  assert.throws(() => protectFile(home, null), TypeError);
  assert.throws(() => protectFile(home, 42), TypeError);
});
