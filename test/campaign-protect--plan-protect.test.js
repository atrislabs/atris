'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planProtect } = require('../lib/campaign-protect');

function fixture(t, committed = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-protect-'));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_') || key.startsWith('GIT_')) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: tmp,
    XDG_CONFIG_HOME: tmp,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(tmp, 'no-global-config'),
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Test Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    GIT_AUTHOR_DATE: '2024-01-02T03:04:05Z',
    GIT_COMMITTER_DATE: '2024-01-02T03:04:05Z'
  });
  const root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--template=', '--initial-branch=main');
  let head;
  if (committed) {
    fs.writeFileSync(path.join(root, 'judge.txt'), 'fixed questions\n');
    git('add', 'judge.txt');
    git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
    head = git('rev-parse', 'HEAD');
  }
  return { tmp, root: fs.realpathSync(root), head };
}

test('planProtect normalizes nested paths and removes duplicates in first-seen order', (t) => {
  const { root, head } = fixture(t);
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);

  assert.deepStrictEqual(planProtect(nested, [
    '../judge.txt', '.././judge.txt', 'future.txt', path.join(root, 'judge.txt')
  ]), { paths: ['judge.txt', 'nested/future.txt'], base_commit: head });
});

test('planProtect accepts an empty list in a committed checkout', (t) => {
  const { root, head } = fixture(t);
  assert.deepStrictEqual(planProtect(root, []), { paths: [], base_commit: head });
});

test('planProtect rejects the checkout itself and paths outside it', (t) => {
  const { root, tmp } = fixture(t);
  for (const given of ['.', '..', '../repo-sibling/file.txt', path.join(tmp, 'outside.txt')]) {
    assert.deepStrictEqual(planProtect(root, ['judge.txt', given]), {
      error: `--protect ${given} is not inside this checkout`
    });
  }
});

test('planProtect reports an uncommitted checkout and a non-git directory', (t) => {
  const { root, tmp } = fixture(t, false);
  assert.deepStrictEqual(planProtect(root, ['judge.txt']), {
    error: '--protect needs a checkout with at least one commit'
  });
  assert.deepStrictEqual(planProtect(tmp, []), {
    error: '--protect needs a git checkout'
  });
});
