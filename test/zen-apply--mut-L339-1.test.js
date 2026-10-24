'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyZen } = require('../lib/zen-apply');

test('a renamed upstream note carries local edits through a clean three-way merge', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-renamed-note-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const previous = { ...process.env };
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-q', '--initial-branch=master');
  const original = 'heading\n\nfirst paragraph\n\nsecond paragraph\n\nlast paragraph\n';
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), original);
  git('add', 'CLAUDE.md');
  git('commit', '-qm', 'initial note');
  git('branch', 'incoming');
  git('checkout', '-q', 'incoming');
  git('mv', 'CLAUDE.md', 'AGENTS.md');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), original.replace('heading', 'upstream heading'));
  git('add', 'AGENTS.md');
  git('commit', '-qm', 'move note and edit heading');
  git('checkout', '-q', 'master');
  git('remote', 'add', 'origin', root);
  git('update-ref', 'refs/remotes/origin/master', 'incoming');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), original.replace('last paragraph', 'my last paragraph'));

  const result = applyZen({ cwd: root, fetch: false, now: new Date('2002-01-01T12:00:00Z'), freshMinutes: 0 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.notes, ['CLAUDE.md moved to AGENTS.md, and your edits went with it']);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    'upstream heading\n\nfirst paragraph\n\nsecond paragraph\n\nmy last paragraph\n');
});
