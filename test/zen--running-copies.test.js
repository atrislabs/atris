'use strict';

// A side copy with a program running in it is in use, even when its git
// history is days old: a dev server or a long eval run makes no commits.
// Zen used to put such a copy away, pulling the folder out from under the
// program. The folders come from ATRIS_ZEN_CWDS_FILE here, so lsof on this
// machine is never read.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runningCopies } = require('../lib/zen');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-running-')));
after(() => fs.rmSync(work, { recursive: true, force: true }));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('only copies holding a running program count, and a shared name prefix does not', () => {
  const a = path.join(work, 'side');
  const b = path.join(work, 'side-two');
  const c = path.join(work, 'side-three');
  const used = runningCopies([{ path: a }, { path: b }, { path: c }], [path.join(a, 'evals', 'loopbench'), c]);
  assert.deepEqual([...used].sort(), [a, c].sort());
});

test('atris zen leaves a clean, old side copy alone while a program runs in it', () => {
  const origin = path.join(work, 'origin.git');
  const repo = path.join(work, 'repo');
  fs.mkdirSync(repo);
  git(work, 'init', '-q', '--bare', '--initial-branch=master', origin);
  git(repo, 'init', '-q', '--initial-branch=master');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'app.js'), 'one\n');
  git(repo, 'add', 'app.js');
  git(repo, 'commit', '-q', '-m', 'app');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'master');
  git(repo, 'remote', 'set-head', 'origin', 'master');

  const job = path.join(work, 'eval-run');
  git(repo, 'worktree', 'add', '-q', '--detach', job);
  const gitDir = path.resolve(job, git(job, 'rev-parse', '--git-dir'));
  const days = new Date(Date.now() - 5 * 86400000);
  for (const f of [path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')]) {
    if (fs.existsSync(f)) fs.utimesSync(f, days, days);
  }
  const cwds = path.join(work, 'cwds.txt');
  fs.writeFileSync(cwds, `${repo}\n${path.join(job, 'evals')}\n`);

  const cli = spawnSync(process.execPath, [cliPath, 'zen'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_ZEN_FRESH_MINUTES: '30',
      ATRIS_ZEN_SCHEDULE_FILE: path.join(work, 'no-schedule'),
      ATRIS_ZEN_CWDS_FILE: cwds,
    },
  });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /1 side copy has a program running in it, so it stays/);
  assert.doesNotMatch(cli.stdout, /put away/);
  assert.ok(fs.existsSync(path.join(job, 'app.js')));
});
