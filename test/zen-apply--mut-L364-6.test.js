'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyZen } = require('../lib/zen-apply');

test('catching up preserves a tracked note edit without reporting an untracked collision', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zen-tracked-note-')));
  const previous = { ...process.env };
  try {
    // Keep identity, reflog dates, and configuration independent of the host.
    process.env.HOME = root;
    process.env.XDG_CONFIG_HOME = root;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'no-global-config');
    process.env.GIT_AUTHOR_DATE = '2000-01-01T00:00:00Z';
    process.env.GIT_COMMITTER_DATE = '2000-01-01T00:00:00Z';
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const note = path.join(root, 'CLAUDE.md');
    git('init', '-q', '--initial-branch=master');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    const base = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join('');
    fs.writeFileSync(note, base);
    git('add', 'CLAUDE.md');
    git('commit', '-qm', 'base');
    const start = git('rev-parse', 'HEAD');
    fs.writeFileSync(note, base.replace('line 1\n', 'incoming first line\n'));
    git('commit', '-qam', 'incoming note');
    const incoming = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/master', incoming);
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
    git('config', 'branch.master.remote', 'origin');
    git('config', 'branch.master.merge', 'refs/heads/master');
    git('config', 'remote.origin.url', root);
    git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git('reset', '--hard', start);
    fs.writeFileSync(note, base.replace('line 12\n', 'my last line\n'));

    const result = applyZen({ cwd: root, fetch: false, now: new Date('2001-01-01T12:00:00Z'), freshMinutes: 1 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.done, ['caught up 1 commit from origin/master']);
    assert.deepEqual(result.left, []);
    // A tracked note merges cleanly. It must not also be treated as a new file.
    assert.deepEqual(result.notes, []);
    assert.equal(fs.readFileSync(note, 'utf8'), base
      .replace('line 1\n', 'incoming first line\n')
      .replace('line 12\n', 'my last line\n'));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
