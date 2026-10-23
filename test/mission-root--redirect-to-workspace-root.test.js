'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-redirect-root-'));
const savedHome = process.env.HOME;
const savedCwd = process.cwd();
const savedAtris = new Map();
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    savedAtris.set(key, process.env[key]);
    delete process.env[key];
  }
}
process.env.HOME = home;

const { redirectToWorkspaceRoot } = require('../lib/mission-root');

function writeSpine(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# spine\n');
}

function restoreProcess() {
  try { process.chdir(savedCwd); } catch (_) { /* the original folder is already gone */ }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  for (const [key, value] of savedAtris) process.env[key] = value;
}

test.after(() => {
  restoreProcess();
  fs.rmSync(home, { recursive: true, force: true });
});

test.describe('redirectToWorkspaceRoot', { concurrency: 1 }, () => {
  test('a subdirectory moves onto the workspace root', () => {
    const repo = path.join(home, 'repo');
    const sub = path.join(repo, 'features', 'food-ordering');
    writeSpine(repo);
    fs.mkdirSync(sub, { recursive: true });
    const before = process.cwd();
    try {
      const result = redirectToWorkspaceRoot(sub);
      assert.deepStrictEqual(result, {
        from: path.resolve(sub),
        root: path.resolve(repo),
      });
      assert.strictEqual(fs.realpathSync(process.cwd()), fs.realpathSync(repo));
      assert.notStrictEqual(result.from, result.root);
    } finally {
      process.chdir(before);
    }
  });

  test('the workspace root and a link that steps outside it stay put', () => {
    const repo = path.join(home, 'edge-repo');
    const outside = path.join(home, 'outside');
    const link = path.join(home, 'link-to-repo');
    writeSpine(repo);
    fs.mkdirSync(path.join(repo, 'nested'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(repo, link, 'dir');
    const before = process.cwd();
    try {
      process.chdir(outside);
      assert.strictEqual(redirectToWorkspaceRoot(repo), null);
      assert.strictEqual(fs.realpathSync(process.cwd()), fs.realpathSync(outside));

      const viaLink = path.join(link, 'nested');
      assert.strictEqual(redirectToWorkspaceRoot(viaLink), null);
      assert.strictEqual(fs.realpathSync(process.cwd()), fs.realpathSync(outside));
    } finally {
      process.chdir(before);
    }
  });

  test('an empty folder, a blank path, and a null path do not move', () => {
    const empty = path.join(home, 'empty');
    fs.mkdirSync(empty);
    const before = process.cwd();
    try {
      assert.strictEqual(redirectToWorkspaceRoot(empty), null);
      assert.strictEqual(process.cwd(), before);

      process.chdir(empty);
      assert.strictEqual(redirectToWorkspaceRoot(''), null);
      assert.strictEqual(redirectToWorkspaceRoot(), null);
      assert.strictEqual(fs.realpathSync(process.cwd()), fs.realpathSync(empty));

      assert.throws(() => redirectToWorkspaceRoot(null), TypeError);
      assert.strictEqual(fs.realpathSync(process.cwd()), fs.realpathSync(empty));
    } finally {
      process.chdir(before);
    }
  });
});
