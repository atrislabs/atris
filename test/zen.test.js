'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkZen, isTeamState, DEFAULT_TEAM_STATE } = require('../lib/zen');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: 30000 });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, ...args) {
  const result = run('git', args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runCli(cwd, ...args) {
  return run(process.execPath, [cliPath, ...args], cwd, { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' });
}

function commit(cwd, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

// A clone of a bare origin, in sync, with a seed checkout that can push ahead.
function createZenRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(seed);
  git(base, 'init', '-q', '--bare', '--initial-branch=master', origin);
  git(seed, 'init', '-q', '--initial-branch=master');
  for (const cwd of [seed]) {
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'user.name', 'test');
  }
  commit(seed, 'atris/TODO.md', '# TODO\n', 'first');
  commit(seed, 'app.js', 'one\n', 'app');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'master');
  git(base, 'clone', '-q', origin, checkout);
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'test');
  return { base, seed, checkout };
}

function kinds(result) {
  return result.problems.map((p) => p.kind).sort();
}

test('team-state matching covers folders and exact files', () => {
  assert.ok(isTeamState('atris/logs/2026/today.md', DEFAULT_TEAM_STATE));
  assert.ok(isTeamState('.claude/agents/x.md', DEFAULT_TEAM_STATE));
  assert.ok(isTeamState('CLAUDE.md', DEFAULT_TEAM_STATE));
  assert.ok(!isTeamState('CLAUDE.md.bak', DEFAULT_TEAM_STATE));
  assert.ok(!isTeamState('src/atris/x.js', DEFAULT_TEAM_STATE));
  assert.ok(!isTeamState('app.js', DEFAULT_TEAM_STATE));
});

test('a synced repo with only team notes changed is zen', () => {
  const { base, checkout } = createZenRepo();
  try {
    fs.writeFileSync(path.join(checkout, 'atris', 'TODO.md'), '# TODO\n- note\n');
    fs.mkdirSync(path.join(checkout, 'atris', 'logs'));
    fs.writeFileSync(path.join(checkout, 'atris', 'logs', 'today.md'), 'log\n');
    fs.writeFileSync(path.join(checkout, 'CLAUDE.md'), 'generated\n');

    const result = checkZen({ cwd: checkout });
    assert.equal(result.ok, true);
    assert.equal(result.zen, true, JSON.stringify(result.problems));
    assert.equal(result.upstream, 'origin/master');
    assert.equal(result.team_files, 3);

    const cli = runCli(checkout, 'zen', '--check');
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /^zen: yes/m);
    assert.match(cli.stdout, /code matches origin\/master/);
    assert.match(cli.stdout, /3 team files kept/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('leftovers, drift and stray code each break zen', () => {
  const { base, seed, checkout } = createZenRepo();
  try {
    // behind origin
    commit(seed, 'app.js', 'two\n', 'newer');
    git(seed, 'push', '-q');
    // one unpushed commit
    commit(checkout, 'local.js', 'x\n', 'local');
    // a merged branch
    git(checkout, 'branch', 'done-work', 'HEAD~1');
    // a stash
    fs.writeFileSync(path.join(checkout, 'app.js'), 'stashed\n');
    git(checkout, 'stash', 'push', '-q');
    // an idle side copy and a busy one
    git(checkout, 'worktree', 'add', '-q', path.join(base, 'idle'), '-b', 'idle-branch');
    git(checkout, 'worktree', 'add', '-q', path.join(base, 'busy'), '-b', 'busy-branch');
    // nobody has switched or committed in the idle copy for an hour
    const idleGit = path.resolve(base, 'idle', git(path.join(base, 'idle'), 'rev-parse', '--git-dir'));
    const hourAgo = new Date(Date.now() - 3600000);
    const idleLog = path.join(idleGit, 'logs', 'HEAD');
    const epoch = Math.floor(hourAgo.getTime() / 1000);
    fs.writeFileSync(idleLog, fs.readFileSync(idleLog, 'utf8').replace(/> \d+ ([+-]\d{4})\t/g, `> ${epoch} $1\t`));
    fs.writeFileSync(path.join(base, 'busy', 'wip.js'), 'wip\n');
    // stray code edit
    fs.writeFileSync(path.join(checkout, 'app.js'), 'edited\n');

    const result = checkZen({ cwd: checkout });
    assert.equal(result.zen, false);
    assert.deepEqual(kinds(result), [
      'ahead', 'behind', 'idle_worktrees', 'merged_branches', 'stashes', 'stray_code',
    ]);
    const by = Object.fromEntries(result.problems.map((p) => [p.kind, p]));
    assert.deepEqual(by.stray_code.files, ['app.js']);
    assert.deepEqual(by.merged_branches.branches, ['done-work']);
    assert.equal(by.idle_worktrees.count, 1);
    assert.equal(result.worktrees_with_work.length, 1);

    const cli = runCli(checkout, 'zen', '--check');
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /^zen: no, 6 things are out of place/m);
    assert.match(cli.stdout, /1 commit behind origin\/master/);
    assert.match(cli.stdout, /1 old stash/);
    assert.match(cli.stdout, /1 side copy has unsaved work/);

    const json = JSON.parse(runCli(checkout, 'zen', '--check', '--json', '--no-fetch').stdout);
    assert.equal(json.zen, false);
    assert.equal(json.stashes, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('zen --check changes nothing in the repo', () => {
  const { base, checkout } = createZenRepo();
  try {
    fs.writeFileSync(path.join(checkout, 'app.js'), 'stashed\n');
    git(checkout, 'stash', 'push', '-q');
    git(checkout, 'branch', 'old');
    const before = git(checkout, 'for-each-ref');
    runCli(checkout, 'zen', '--check');
    assert.equal(git(checkout, 'for-each-ref'), before);
    assert.equal(git(checkout, 'stash', 'list').split('\n').length, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('off the main branch is not zen, and extra team paths come from .atris/zen.json', () => {
  const { base, checkout } = createZenRepo();
  try {
    fs.mkdirSync(path.join(checkout, '.atris'));
    fs.writeFileSync(path.join(checkout, '.atris', 'zen.json'), JSON.stringify({ team_state: ['results/'] }));
    fs.mkdirSync(path.join(checkout, 'results'));
    fs.writeFileSync(path.join(checkout, 'results', 'run.json'), '{}\n');
    assert.equal(checkZen({ cwd: checkout }).zen, true);

    git(checkout, 'checkout', '-q', '-b', 'feature');
    const result = checkZen({ cwd: checkout });
    assert.deepEqual(kinds(result), ['off_main']);
    assert.match(result.problems[0].text, /on branch feature, not master/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('outside a git repo zen says it cannot check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-nogit-'));
  try {
    const cli = runCli(dir, 'zen', '--check');
    assert.equal(cli.status, 2);
    assert.match(cli.stdout, /zen: can't check, not a git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
