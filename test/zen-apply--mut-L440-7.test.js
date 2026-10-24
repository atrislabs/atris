'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyZen } = require('../lib/zen-apply');

test('an upstream deletion does not report a locally renamed note as restored', () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zen-renamed-note-')));
  const previous = { ...process.env };
  try {
    // Fence configuration and any optional workspace state inside this fixture.
    process.env.HOME = temp;
    process.env.XDG_CONFIG_HOME = temp;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_CONFIG_GLOBAL = path.join(temp, 'no-config');
    process.env.GIT_AUTHOR_DATE = '2000-01-01T00:00:00Z';
    process.env.GIT_COMMITTER_DATE = '2000-01-01T00:00:00Z';
    const git = (cwd, ...args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || String(result.error || ''));
      return result.stdout.trim();
    };
    const origin = path.join(temp, 'origin.git');
    const seed = path.join(temp, 'seed');
    const checkout = path.join(temp, 'checkout');
    git(temp, 'init', '--bare', '--initial-branch=master', origin);
    git(temp, 'init', '--initial-branch=master', seed);
    git(seed, 'config', 'user.name', 'test');
    git(seed, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(seed, 'CLAUDE.md'), 'a team note\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'initial note');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-u', 'origin', 'master');
    git(temp, 'clone', origin, checkout);
    git(checkout, 'mv', 'CLAUDE.md', 'GEMINI.md');
    // An incoming note collides with an untracked local copy, forcing the
    // retry that temporarily saves notes before applying the update.
    fs.writeFileSync(path.join(checkout, 'AGENTS.md'), 'incoming note\n');
    fs.writeFileSync(path.join(seed, 'AGENTS.md'), 'incoming note\n');
    git(seed, 'add', 'AGENTS.md');
    git(seed, 'rm', 'CLAUDE.md');
    git(seed, 'commit', '-m', 'remove old note');
    git(seed, 'push');
    git(checkout, 'fetch', 'origin');

    const result = applyZen({ cwd: checkout, fetch: false, now: new Date('2100-01-01T12:00:00Z'), freshMinutes: 1 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.done, ['caught up 1 commit from origin/master']);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
    assert.equal(fs.existsSync(path.join(checkout, 'CLAUDE.md')), false);
    assert.equal(fs.readFileSync(path.join(checkout, 'GEMINI.md'), 'utf8'), 'a team note\n');
    // The old path was deleted, so there is no restored upstream copy to report.
    assert.deepEqual(result.notes, []);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
