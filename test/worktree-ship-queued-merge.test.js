'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function setup(t, mode, extraEnv = {}, prepare = null) {
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
  if (prepare) prepare({ primary, work });
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
    console.log(JSON.stringify({state: 'MERGED', mergedAt: '2026-10-16T08:00:00Z', number: 41, url: 'https://github.example/repo/pull/41', mergeCommit: {oid: head}}));
  } else if (process.env.MERGE_TEST_MODE === 'malformed') console.log('{broken');
  else console.log(JSON.stringify({state: process.env.MERGE_TEST_MODE === 'closed' ? 'CLOSED' : 'OPEN', mergedAt: null, number: 41, autoMergeRequest: {enabledAt: '2026-10-16T08:00:00Z'}}));
} else if (args[0] === 'pr' && args[1] === 'merge') console.log('auto-merge enabled; waiting for required checks');
else process.exit(1);
`, { mode: 0o755 });
  const run = spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'Save the real change', '--merge', '--no-map-refresh'], {
    cwd: work, encoding: 'utf8', timeout: 20000,
    env: { ...scrubAgentEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH}`, MERGE_TEST_MODE: mode, MERGE_TEST_REMOTE: remote, ATRIS_SKIP_UPDATE_CHECK: '1', ...extraEnv },
  });
  return { root, remote, primary, work, git, run };
}

const queueFileOf = (fx) => path.join(fx.primary, '.atris', 'state', 'autoland-queue.json');

test('a queued merge keeps the real remote source branch and reports pending', (t) => {
  const { root, remote, git, run } = setup(t, 'pending');
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/queued-change'], root).status, 0, 'deleting the head cancels the pending merge');
  assert.match(run.stdout, /merge: pending/);
  assert.doesNotMatch(run.stdout, /merge: merged|done: worktree shipped/);
});

for (const mode of ['closed', 'unreadable', 'malformed']) {
  test(`an ${mode} merge result keeps the source and cannot report a completed merge`, (t) => {
    const fx = setup(t, mode);
    const { root, remote, git, run } = fx;
    assert.notEqual(run.status, 0, run.stdout);
    assert.equal(git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/queued-change'], root).status, 0);
    assert.doesNotMatch(run.stdout, /merge: merged|done: worktree shipped/);
    assert.equal(fs.existsSync(queueFileOf(fx)), false, 'a failed merge result is not queued');
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
  const record = run.stdout.match(/^merge: record (.*)$/m);
  assert.ok(record, 'ship names the pull request and commit that landed');
  assert.deepEqual(JSON.parse(record[1]), { merge_commit: head, number: 41, url: 'https://github.example/repo/pull/41', merged_at: '2026-10-16T08:00:00Z' });
});

test('a confirmed merge hands the build copy to removal, and a pending one does not', (t) => {
  const keep = { ATRIS_WORKTREE_KEEP_AFTER_SHIP: '1' };
  const merged = setup(t, 'merged', keep).run;
  assert.equal(merged.status, 0, merged.stderr || merged.stdout);
  assert.match(merged.stdout, /merge: merged[\s\S]*cleanup: kept this build copy \(ATRIS_WORKTREE_KEEP_AFTER_SHIP=1\)[\s\S]*done: worktree shipped/);
  // A pending merge has its branch on origin, so its copy may go too; the keep switch still holds it.
  const pending = setup(t, 'pending', keep).run;
  assert.equal(pending.status, 0, pending.stderr || pending.stdout);
  assert.match(pending.stdout, /merge: pending[\s\S]*cleanup: kept this build copy \(ATRIS_WORKTREE_KEEP_AFTER_SHIP=1\)/);
  // Temp folders are never handed to removal, so the default prints nothing.
  assert.doesNotMatch(setup(t, 'merged').run.stdout, /cleanup:/);
});

test('a pending merge is recorded so the tick can queue it again if github drops it', (t) => {
  const fx = setup(t, 'pending');
  assert.equal(fx.run.status, 0, fx.run.stderr || fx.run.stdout);
  assert.match(fx.run.stdout, /merge: pending[\s\S]*queue: recorded pull request 41 for the tick's catch-up/);
  const head = fx.git(['rev-parse', 'HEAD'], fx.work).stdout.trim();
  assert.equal(fx.git(['--git-dir', fx.remote, 'rev-parse', 'refs/heads/queued-change'], fx.root).stdout.trim(), head, 'the recorded commit is the one on github');
  const ledger = JSON.parse(fs.readFileSync(queueFileOf(fx), 'utf8'));
  assert.equal(ledger.schema, 'atris.autoland_queue.v1');
  assert.deepEqual(Object.keys(ledger.entries), ['queued-change']);
  const entry = ledger.entries['queued-change'];
  assert.equal(entry.branch, 'queued-change');
  assert.equal(entry.base, 'master');
  assert.equal(entry.number, 41);
  assert.equal(entry.pushed, head);
  assert.equal(entry.requeues, 0);
  assert.ok(Number.isFinite(Date.parse(entry.queued_at)));
});

test('a merged change writes no queue entry', (t) => {
  const fx = setup(t, 'merged');
  assert.equal(fx.run.status, 0, fx.run.stderr || fx.run.stdout);
  assert.doesNotMatch(fx.run.stdout, /queue:/);
  assert.equal(fs.existsSync(queueFileOf(fx)), false);
});

test('a queue list that cannot be written is reported and the ship still succeeds', (t) => {
  // A file where the state folder should be makes the list unwritable.
  const fx = setup(t, 'pending', {}, ({ primary }) => fs.writeFileSync(path.join(primary, '.atris'), 'not a folder\n'));
  assert.equal(fx.run.status, 0, fx.run.stderr || fx.run.stdout);
  assert.match(fx.run.stdout, /merge: pending[\s\S]*queue: not recorded \(.+\)/);
  assert.doesNotMatch(fx.run.stdout, /queue: recorded/);
  assert.equal(fx.git(['--git-dir', fx.remote, 'show-ref', '--verify', '--quiet', 'refs/heads/queued-change'], fx.root).status, 0);
});
