'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applyZen } = require('../lib/zen-apply');

test('an abandoned staged rename is preserved in the saved copy', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zen-rename-')));
  const keys = ['HOME', 'ATRIS_ZEN_SCHEDULE_FILE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = path.join(base, 'repo');
  const side = path.join(base, 'side');
  fs.mkdirSync(root);
  const schedule = path.join(base, 'schedule');
  fs.writeFileSync(schedule, '');
  Object.assign(process.env, {
    HOME: base,
    ATRIS_ZEN_SCHEDULE_FILE: schedule,
    GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '2020-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T12:00:00Z',
  });
  function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  try {
    git(root, 'init', '-q', '--initial-branch=master');
    fs.writeFileSync(path.join(root, 'draft.js'), 'module.exports = 42;\n');
    git(root, 'add', 'draft.js');
    git(root, 'commit', '-q', '-m', 'initial');
    git(root, 'remote', 'add', 'origin', root);
    git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    git(root, 'worktree', 'add', '-q', '-b', 'rename-work', side);
    git(side, 'mv', 'draft.js', 'finished.js');
    const touched = new Date('2020-01-01T12:00:00Z');
    fs.utimesSync(path.join(side, 'finished.js'), touched, touched);

    const result = applyZen({ cwd: root, fetch: false,
      now: new Date('2020-01-10T12:00:00Z'), freshMinutes: 30 });
    const saved = result.saved.find(ref => ref.startsWith('refs/heads/zen-backup/'));
    assert.ok(saved, 'the abandoned rename must have a saved backup');
    assert.equal(git(root, 'show', `${saved}:finished.js`), 'module.exports = 42;');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
