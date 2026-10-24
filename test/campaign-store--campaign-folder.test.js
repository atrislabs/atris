'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { campaignFolder } = require('../lib/campaign-store');

const ENV_KEY = 'ATRIS_CAMPAIGN_DB';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-folder-'));
}

// Run fn with ATRIS_CAMPAIGN_DB set to value, or removed when value is null.
function withDbEnv(value, fn) {
  const saved = process.env[ENV_KEY];
  if (value === null) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
}

function makeCheckout(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function hasGitAncestor(dir) {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    if (path.dirname(cur) === cur) return false;
  }
}

test('campaignFolder: an explicit database path puts the folder beside it', () => {
  const dir = tempDir();
  const db = path.join(dir, 'custom', 'store.db');
  const folder = withDbEnv(db, () => campaignFolder('cmp-ship-1a2b', path.join(dir, 'ignored-root')));
  assert.strictEqual(folder, path.join(dir, 'custom', 'campaigns', 'cmp-ship-1a2b'));
});

test('campaignFolder: a checkout keeps campaign files under .atris/state', () => {
  const dir = tempDir();
  const repo = makeCheckout(dir, 'repo');
  const folder = withDbEnv(null, () => campaignFolder('cmp-ship-1a2b', repo));
  assert.strictEqual(folder, path.join(repo, '.atris', 'state', 'campaigns', 'cmp-ship-1a2b'));
});

test('campaignFolder: a subfolder resolves to the same folder as the checkout root', () => {
  const dir = tempDir();
  const repo = makeCheckout(dir, 'repo');
  const sub = path.join(repo, 'lib', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  withDbEnv(null, () => {
    assert.strictEqual(campaignFolder('cmp-a', sub), campaignFolder('cmp-a', repo));
    assert.strictEqual(campaignFolder('cmp-a', sub), path.join(repo, '.atris', 'state', 'campaigns', 'cmp-a'));
  });
});

test('campaignFolder: a linked worktree shares the main checkout folder', () => {
  const dir = tempDir();
  const main = makeCheckout(dir, 'main');
  const worktree = path.join(dir, 'wt');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  const folder = withDbEnv(null, () => campaignFolder('cmp-shared', worktree));
  assert.strictEqual(folder, path.join(main, '.atris', 'state', 'campaigns', 'cmp-shared'));
});

test('campaignFolder: a .git pointer that is not a worktree keeps the folder in place', () => {
  const dir = tempDir();
  const sub = path.join(dir, 'submodule');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/submodule\n');
  const folder = withDbEnv(null, () => campaignFolder('cmp-sub', sub));
  assert.strictEqual(folder, path.join(sub, '.atris', 'state', 'campaigns', 'cmp-sub'));
});

test('campaignFolder: no checkout above the root falls back to the root itself', { skip: hasGitAncestor(os.tmpdir()) && 'temp folder sits inside a git checkout' }, () => {
  const dir = tempDir();
  const folder = withDbEnv(null, () => campaignFolder('cmp-loose', dir));
  assert.strictEqual(folder, path.join(dir, '.atris', 'state', 'campaigns', 'cmp-loose'));
});

test('campaignFolder: root defaults to the current working directory', () => {
  const dir = tempDir();
  const repo = makeCheckout(dir, 'repo');
  const before = process.cwd();
  process.chdir(repo);
  try {
    const folder = withDbEnv(null, () => campaignFolder('cmp-cwd'));
    assert.strictEqual(folder, path.join(fs.realpathSync(repo), '.atris', 'state', 'campaigns', 'cmp-cwd'));
  } finally {
    process.chdir(before);
  }
});

test('campaignFolder: different ids get different folders under one campaigns dir', () => {
  const dir = tempDir();
  const repo = makeCheckout(dir, 'repo');
  withDbEnv(null, () => {
    const a = campaignFolder('cmp-a', repo);
    const b = campaignFolder('cmp-b', repo);
    assert.notStrictEqual(a, b);
    assert.strictEqual(path.dirname(a), path.dirname(b));
    assert.strictEqual(path.basename(path.dirname(a)), 'campaigns');
  });
});

test('campaignFolder: an empty id returns the campaigns directory itself', () => {
  const dir = tempDir();
  const repo = makeCheckout(dir, 'repo');
  const folder = withDbEnv(null, () => campaignFolder('', repo));
  assert.strictEqual(folder, path.join(repo, '.atris', 'state', 'campaigns'));
});

test('campaignFolder: it only computes the path and never creates anything', () => {
  const dir = tempDir();
  const repo = makeCheckout(dir, 'repo');
  const folder = withDbEnv(null, () => campaignFolder('cmp-pure', repo));
  assert.strictEqual(fs.existsSync(folder), false);
  assert.strictEqual(fs.existsSync(path.join(repo, '.atris')), false);
});
