require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tidyMemberCopies } = require('../lib/member-tidy');

test('tidy reports the git diagnostic when origin is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-diagnostic-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    if (init.status !== 0) throw new Error(init.stderr);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: '2024-01-15T12:00:00Z',
      GIT_COMMITTER_DATE: '2024-01-15T12:00:00Z',
    };
    for (const args of [
      ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'initial'],
      ['worktree', 'add', '-qb', 'finished', path.join(home, '.agent-worktrees', 'repo', 'finished')],
    ]) {
      const command = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
      if (command.status !== 0) throw new Error(command.stderr);
    }
    const result = tidyMemberCopies({ repoRoot: repo });
    assert.match(result.aborted, /origin.*does not appear to be a git repository/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
