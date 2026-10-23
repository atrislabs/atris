'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyZen } = require('../lib/zen-apply');

test('an empty external diff does not report an unpushed team note as lost', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-empty-diff-'));
  const previous = { ...process.env };
  try {
    // Keep Git identity, configuration, and all generated files local to this test.
    Object.assign(process.env, {
      HOME: tmp,
      XDG_CONFIG_HOME: tmp,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(tmp, 'no-config'),
      GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
    });
    const git = (cwd, ...args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const origin = path.join(tmp, 'origin.git');
    const repo = path.join(tmp, 'repo');
    git(tmp, 'init', '--bare', '--initial-branch=master', origin);
    git(tmp, 'clone', origin, repo);
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'original note\n');
    git(repo, 'add', 'CLAUDE.md');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'push', '-u', 'origin', 'master');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'unpushed note\n');
    git(repo, 'commit', '-am', 'note update');

    // --name-only still lists the note, while the patch-producing diff is empty.
    const helper = path.join(tmp, 'empty-diff');
    fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(repo, 'config', 'diff.external', `"${helper}"`);
    assert.equal(git(repo, 'diff', '--name-only', 'origin/master', 'HEAD'), 'CLAUDE.md');
    assert.equal(git(repo, 'diff', '--binary', 'origin/master', 'HEAD', '--', 'CLAUDE.md'), '');

    const result = applyZen({
      cwd: repo,
      fetch: false,
      freshMinutes: 1,
      now: new Date('2100-01-02T12:00:00Z'),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.notes, []);
    assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), 'original note\n');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
