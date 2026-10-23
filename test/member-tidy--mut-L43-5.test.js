const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tidyMemberCopies } = require('../lib/member-tidy');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, env: GIT_ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

test('a kept copy exactly two days of hours old is reported in days', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'copy-age-boundary-')));
  try {
    const remote = path.join(base, 'remote.git');
    const seed = path.join(base, 'seed');
    runGit(['init', '-q', '--bare', '-b', 'master', remote], base);
    runGit(['init', '-q', '-b', 'master', seed], base);
    fs.writeFileSync(path.join(seed, 'README.md'), '# fixture\n');
    runGit(['add', '.'], seed);
    runGit(['commit', '-q', '-m', 'init'], seed);
    runGit(['push', '-q', remote, 'master'], seed);

    const arena = path.join(base, 'arena');
    fs.mkdirSync(arena);
    const repo = path.join(arena, 'repo');
    runGit(['clone', '-q', remote, repo], arena);
    const copies = path.join(arena, '.agent-worktrees', 'repo');
    fs.mkdirSync(copies, { recursive: true });

    const wt = path.join(copies, 'unmerged');
    runGit(['worktree', 'add', '-q', '-b', 'unmerged', wt, 'master'], repo);
    fs.writeFileSync(path.join(wt, 'unmerged.txt'), 'work\n');
    runGit(['add', '.'], wt);
    runGit(['commit', '-q', '-m', 'unmerged work'], wt);

    const quiet = path.join(base, 'no-programs');
    fs.writeFileSync(quiet, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const origin = Date.parse('2021-03-10T12:00:00Z');
    fs.utimesSync(wt, new Date(origin), new Date(origin));

    const result = tidyMemberCopies({
      repoRoot: repo,
      dryRun: true,
      lsofBin: quiet,
      now: new Date(origin + 48 * 60 * 60 * 1000),
    });

    const copy = result.copies.find((entry) => entry.name === 'unmerged');
    assert.ok(copy);
    assert.match(copy.reason, /2d old/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
