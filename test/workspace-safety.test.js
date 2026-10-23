'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveSafeOutputDir } = require('../lib/workspace-safety');

function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

test('a normal project folder is kept as is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ws-'));
  assert.deepEqual(resolveSafeOutputDir(dir, { slug: 'acme' }), { dir: path.resolve(dir), relocated: false });
});

test('home, the filesystem root, and system paths relocate to cwd/slug', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ws-cwd-'));
  const cases = [
    [os.homedir(), 'your home directory'],
    [path.parse(cwd).root, 'the filesystem root'],
    ['/etc', 'the system path /etc'],
    [path.join(os.homedir(), 'Documents'), 'a reserved home folder (~/Documents)'],
  ];
  for (const [requested, reason] of cases) {
    const result = quiet(() => resolveSafeOutputDir(requested, { slug: 'acme', cwd }));
    assert.deepEqual(result, { dir: path.join(cwd, 'acme'), relocated: true, originalReason: reason }, requested);
  }
});

test('an empty request is refused as an empty path', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ws-cwd-'));
  const result = quiet(() => resolveSafeOutputDir('', { slug: 'acme', cwd }));
  assert.equal(result.originalReason, 'empty path');
  assert.equal(result.dir, path.join(cwd, 'acme'));
});

test('only top-level home folders are reserved, nested ones are fine', () => {
  const ok = path.join(os.homedir(), 'code-atris-test-only');
  assert.equal(resolveSafeOutputDir(ok, { slug: 'x' }).relocated, false);
  const nested = path.join(os.homedir(), 'code-atris-test-only', 'Documents');
  assert.equal(resolveSafeOutputDir(nested, { slug: 'x' }).relocated, false);
});

test('when cwd/slug is itself unsafe it falls back to ~/atris-workspaces/slug', () => {
  const result = quiet(() => resolveSafeOutputDir(os.homedir(), { slug: 'Documents', cwd: os.homedir() }));
  assert.equal(result.dir, path.join(os.homedir(), 'atris-workspaces', 'Documents'));
});
