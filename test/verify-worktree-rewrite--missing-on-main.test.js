'use strict';

// missingOnMain asks one question for the landing gate: does every file a
// proof check reads by relative path exist in the main checkout? It returns
// the first missing path (relative to the main checkout) or null. Each case
// builds a throwaway directory, so the answer never depends on this machine.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { missingOnMain } = require('../lib/verify-worktree-rewrite');

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-on-main-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function touch(root, rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

test('returns null when every file a check reads exists on main', () => {
  withRoot((root) => {
    touch(root, 'scripts/t.mjs');
    touch(root, 'test/a.test.js');
    const steps = [
      { argv: ['node', '--check', 'scripts/t.mjs'] },
      { argv: ['node', '--test', 'test/a.test.js'] },
    ];
    assert.strictEqual(missingOnMain(steps, root), null);
  });
});

test('returns the first missing file, relative to main, and stops there', () => {
  withRoot((root) => {
    touch(root, 'scripts/ok.js');
    const steps = [
      { argv: ['node', '--check', 'scripts/ok.js'] },
      { argv: ['node', 'scripts/gone.js'] },
      { argv: ['node', 'scripts/also-gone.js'] },
    ];
    assert.strictEqual(missingOnMain(steps, root), path.join('scripts', 'gone.js'));
  });
});

test('a missing step folder is reported before the file inside it', () => {
  withRoot((root) => {
    const steps = [{ cwd: 'packages/app', argv: ['node', '--check', 'index.js'] }];
    assert.strictEqual(missingOnMain(steps, root), path.join('packages', 'app'));
  });
});

test('a bare file name is looked up inside the step folder, not the root', () => {
  withRoot((root) => {
    touch(root, 'packages/app/index.js');
    const inside = [{ cwd: 'packages/app', argv: ['node', '--check', 'index.js'] }];
    assert.strictEqual(missingOnMain(inside, root), null);

    const outside = [{ cwd: 'packages', argv: ['node', '--check', 'index.js'] }];
    assert.strictEqual(missingOnMain(outside, root), path.join('packages', 'index.js'));
  });
});

test('an absolute path under main is checked and reported relative to main', () => {
  withRoot((root) => {
    const abs = path.join(root, 'scripts', 'gone.mjs');
    const steps = [{ argv: ['node', abs] }];
    assert.strictEqual(missingOnMain(steps, root), path.join('scripts', 'gone.mjs'));

    touch(root, 'scripts/gone.mjs');
    assert.strictEqual(missingOnMain(steps, root), null);
  });
});

test('nothing to check gives null: no steps, no argv, or no file-shaped argument', () => {
  withRoot((root) => {
    assert.strictEqual(missingOnMain([], root), null);
    assert.strictEqual(missingOnMain(undefined, root), null);
    assert.strictEqual(missingOnMain([{}], root), null);
    assert.strictEqual(missingOnMain([{ argv: ['npm', 'test'] }], root), null);
  });
});
