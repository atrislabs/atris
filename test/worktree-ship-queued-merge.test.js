'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function setup(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-queued-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const primary = path.join(root, 'primary');
  const work = path.join(root, 'work');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(primary);
  fs.mkdirSync(bin);
  const git = (args, cwd = primary) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const checked = (args, cwd) => { const run = git(args, cwd); assert.equal(run.status, 0, run.stderr); return run.stdout.trim(); };
  checked(['init', '--bare', '-q', remote]);
  checked(['init', '-q']);
  checked(['config', 'user.name', 'Test User']);
  checked(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(primary, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(primary, 'app.js'), 'module.exports = 1;\n');
  checked(['add', '.']);
  checked(['commit', '-qm', 'initial']);
  checked(['branch', '-M', 'master']);
  checked(['remote', 'add', 'origin', remote]);
  checked(['push', '-u', 'origin', 'master']);
  checked(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  checked(['worktree', 'add', '-q', '-b', 'queued-change', work, 'master']);
  fs.writeFileSync(path.join(work, 'app.js'), 'module.exports = 2;\n');
  // Git and the CLI are real. The foreign service boundary reports a merge
  // request accepted by a queue, independently of whether git deletes its head.
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  if (args.includes('--jq')) console.log('41 https://github.example/repo/pull/41 OPEN');
  else if (process.env.MERGE_TEST_MODE === 'unreadable') process.exit(1);
  else if (process.env.MERGE_TEST_MODE === 'merged') {
    const { execFileSync } = require('node:child_process');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    execFileSync('git', ['--git-dir', process.env.MERGE_TEST_REMOTE, 'update-ref', 'refs/heads/master', head]);
    console.log(JSON.stringify({state: 'MERGED', mergedAt: '2026-10-16T08:00:00Z'}));
  } else if (process.env.MERGE_TEST_MODE === 'malformed') console.log('{broken');
  else console.log(JSON.stringify({state: process.env.MERGE_TEST_MODE === 'closed' ? 'CLOSED' : 'OPEN', mergedAt: null, autoMergeRequest: {enabledAt: '2026-10-16T08:00:00Z'}}));
} else if (args[0] === 'pr' && args[1] === 'merge') console.log('auto-merge enabled; waiting for required checks');
else process.exit(1);
`, { mode: 0o755 });
  const run = spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'Save the real change', '--merge', '--no-map-refresh'], {
    cwd: work, encoding: 'utf8', timeout: 20000,
    env: { ...scrubAgentEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH}`, MERGE_TEST_MODE: mode, MERGE_TEST_REMOTE: remote, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  return { root, remote, work, git, run };
}

test('a queued merge keeps the real remote source branch and reports pending', (t) => {
  const { root, remote, git, run } = setup(t, 'pending');
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/queued-change'], root).status, 0, 'deleting the head cancels the pending merge');
  assert.match(run.stdout, /merge: pending/);
  assert.doesNotMatch(run.stdout, /merge: merged|done: worktree shipped/);
});

for (const mode of ['closed', 'unreadable', 'malformed']) {
  test(`an ${mode} merge result keeps the source and cannot report a completed merge`, (t) => {
    const { root, remote, git, run } = setup(t, mode);
    assert.notEqual(run.status, 0, run.stdout);
    assert.equal(git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/queued-change'], root).status, 0);
    assert.doesNotMatch(run.stdout, /merge: merged|done: worktree shipped/);
  });
}


test('a confirmed merged change is in the real target before its source is deleted', (t) => {
  const { root, remote, work, git, run } = setup(t, 'merged');
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /merge: merged/);
  assert.match(run.stdout, /done: worktree shipped/);
  assert.equal(git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/queued-change'], root).status, 1);
  const head = git(['rev-parse', 'HEAD'], work).stdout.trim();
  assert.equal(git(['--git-dir', remote, 'merge-base', '--is-ancestor', head, 'master'], root).status, 0);
});
