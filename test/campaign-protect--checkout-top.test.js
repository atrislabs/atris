'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { checkoutTop } = require('../lib/campaign-protect');

for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

const fixtureRoots = [];
test.after(() => {
  for (const root of fixtureRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

function tempDir() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-checkout-top-')));
  fixtureRoots.push(root);
  return root;
}

process.env.HOME = tempDir();

test('resolves the top-level directory for git repository root and subdirectories', () => {
  const base = tempDir();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });

  const deep = path.join(repo, 'sub', 'inner');
  fs.mkdirSync(deep, { recursive: true });

  assert.strictEqual(checkoutTop(repo), repo);
  assert.strictEqual(checkoutTop(deep), repo);
});

test('resolves the canonical target path when given a symlinked directory', () => {
  const base = tempDir();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });

  const link = path.join(base, 'repo-link');
  fs.symlinkSync(repo, link, 'dir');

  assert.strictEqual(checkoutTop(link), repo);
});

test('returns null for non-git directories and missing paths', () => {
  const base = tempDir();
  const notRepo = path.join(base, 'plain-dir');
  fs.mkdirSync(notRepo);

  assert.strictEqual(checkoutTop(notRepo), null);
  assert.strictEqual(checkoutTop(path.join(base, 'non-existent-path')), null);
});
