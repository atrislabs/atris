'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRunIgnore } = require('../lib/gitignore');

function tempRoot(git = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gitignore-'));
  if (git) fs.mkdirSync(path.join(root, '.git'));
  return root;
}

test('a plain folder that is not a git repo gets no .gitignore', () => {
  const root = tempRoot(false);
  assert.deepEqual(ensureRunIgnore(root), { changed: false });
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
});

test('a git repo with no .gitignore gets one with the run entries', () => {
  const root = tempRoot();
  const result = ensureRunIgnore(root);
  assert.equal(result.changed, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.missing, ['atris/runs/', 'atris/status/']);
  assert.equal(
    fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
    '# atris run output\natris/runs/\natris/status/\n',
  );
});

test('a worktree pointer file counts as a git repo', () => {
  const root = tempRoot(false);
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n');
  assert.equal(ensureRunIgnore(root).changed, true);
});

test('existing content is kept and separated by a blank line', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules');
  ensureRunIgnore(root);
  assert.equal(
    fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
    'node_modules\n\n# atris run output\natris/runs/\natris/status/\n',
  );
});

test('only missing entries are appended, without repeating the comment', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, '.gitignore'), '# atris run output\r\natris/runs/\r\n');
  const result = ensureRunIgnore(root);
  assert.deepEqual(result.missing, ['atris/status/']);
  assert.equal(
    fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
    '# atris run output\r\natris/runs/\r\n\natris/status/\n',
  );
});

test('a second run changes nothing', () => {
  const root = tempRoot();
  ensureRunIgnore(root);
  const before = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.deepEqual(ensureRunIgnore(root), { changed: false });
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), before);
});

test('dryRun reports the plan without writing', () => {
  const root = tempRoot();
  const result = ensureRunIgnore(root, { dryRun: true });
  assert.equal(result.changed, true);
  assert.match(result.block, /atris\/runs\//);
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
});

test('an unreadable .gitignore does not throw', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.gitignore'));
  assert.deepEqual(ensureRunIgnore(root), { changed: false });
});
