const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { worktreeCommand } = require('../commands/worktree');

// Collects what the command prints instead of letting it reach the test output.
function captureOutput(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  try {
    const code = fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// Everything lives under one temp folder. ATRIS_* vars are cleared and HOME
// points inside the folder, so no machine setting or global git config leaks in.
function withSandbox(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-command-'));
  const cwd = process.cwd();
  const savedEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = path.join(base, 'home');
    fs.mkdirSync(process.env.HOME);
    return run(base);
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// An empty repo on a fixed branch name, so output does not depend on init.defaultBranch.
// Returns the realpath git reports for it (macOS temp folders sit behind a symlink).
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(git(['init', '-q']).status, 0);
  assert.strictEqual(git(['symbolic-ref', 'HEAD', 'refs/heads/main']).status, 0);
  return fs.realpathSync(dir);
}

test('worktreeCommand help prints the usage block and returns 0', () => {
  for (const arg of ['help', '--help', '-h']) {
    const result = captureOutput(() => worktreeCommand([arg]));
    assert.strictEqual(result.code, 0, arg);
    assert.match(result.out, /^Usage: atris worktree <guide\|start\|ship\|status\|doctor\|guard\|prune\|cleanup\|sweep>$/m);
    assert.match(result.out, /atris worktree guard \[--allow-primary\] \[--allow-dirty\]/);
    assert.match(result.out, /atris worktree status.*--agent <name>.*--member <name>.*copies/i);
  }
});

test('worktreeCommand with an unknown subcommand prints usage and returns 2', () => {
  const result = captureOutput(() => worktreeCommand(['bogus']));
  assert.strictEqual(result.code, 2);
  assert.match(result.out, /^Usage: atris worktree <guide\|start\|ship\|status\|doctor\|guard\|prune\|cleanup\|sweep>$/m);
});

test('worktreeCommand guide and recipe print the agent recipe and return 0', () => {
  for (const arg of ['guide', 'recipe']) {
    const result = captureOutput(() => worktreeCommand([arg]));
    assert.strictEqual(result.code, 0, arg);
    assert.strictEqual(result.out.split('\n')[0], 'Atris worktree agent recipe');
    assert.match(result.out, /atris worktree ship --message "<commit>" --verify "<cmd>" --merge/);
  }
});

test('worktreeCommand status lists the primary checkout with staged, unstaged and untracked counts', () => {
  withSandbox((base) => {
    const repo = initRepo(path.join(base, 'repo'));
    process.chdir(repo);

    // No args defaults to status.
    let result = captureOutput(() => worktreeCommand());
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.out, `${repo} [primary current] branch=main staged=0 unstaged=0 untracked=0`);

    fs.writeFileSync(path.join(repo, 'notes.txt'), 'draft\n');
    result = captureOutput(() => worktreeCommand(['status']));
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.out, `${repo} [primary current] branch=main staged=0 unstaged=0 untracked=1`);

    assert.strictEqual(spawnSync('git', ['add', 'notes.txt'], { cwd: repo }).status, 0);
    result = captureOutput(() => worktreeCommand(['status']));
    assert.strictEqual(result.out, `${repo} [primary current] branch=main staged=1 unstaged=0 untracked=0`);
  });
});

test('worktreeCommand status filters copies by folder or branch prefix', () => {
  withSandbox((base) => {
    const repo = initRepo(path.join(base, 'repo'));
    const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.strictEqual(git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial']).status, 0);
    const folderMatch = path.join(base, 'alice-folder');
    const branchMatch = path.join(base, 'other-folder');
    const noMatch = path.join(base, 'malice-folder');
    assert.strictEqual(git(['worktree', 'add', '-qb', 'other-branch', folderMatch]).status, 0);
    assert.strictEqual(git(['worktree', 'add', '-qb', 'alice-branch', branchMatch]).status, 0);
    assert.strictEqual(git(['worktree', 'add', '-qb', 'malice-branch', noMatch]).status, 0);
    process.chdir(repo);

    for (const flag of ['--agent', '--member']) {
      const result = captureOutput(() => worktreeCommand(['status', flag, 'alice']));
      assert.strictEqual(result.code, 0);
      assert.match(result.out, /alice-folder/);
      assert.match(result.out, /other-folder/);
      assert.doesNotMatch(result.out, /malice-folder|branch=main/);
      assert.strictEqual(result.out.split('\n').length, 2);
    }
    const missing = captureOutput(() => worktreeCommand(['status', '--agent', 'nobody']));
    assert.strictEqual(missing.out, 'no copies for nobody');
  });
});

test('worktreeCommand status outside a git repo throws the git error', (t) => {
  withSandbox((base) => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: outside, encoding: 'utf8' });
    if (probe.status === 0) {
      t.skip('the temp folder sits inside a git repo on this machine');
      return;
    }
    process.chdir(outside);
    assert.throws(() => worktreeCommand(['status']), /not a git repository/);
  });
});

test('worktreeCommand guard blocks the primary checkout, passes clean work, and blocks dirty work', () => {
  withSandbox((base) => {
    const repo = initRepo(path.join(base, 'repo'));
    process.chdir(repo);

    // The primary checkout is refused unless --allow-primary is passed.
    let result = captureOutput(() => worktreeCommand(['guard']));
    assert.strictEqual(result.code, 2);
    assert.match(result.err, /^blocked: this is the primary checkout; create an agent worktree first$/m);

    result = captureOutput(() => worktreeCommand(['guard', '--allow-primary']));
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.out, 'atris worktree guard: ok');

    fs.writeFileSync(path.join(repo, 'notes.txt'), 'draft\n');
    result = captureOutput(() => worktreeCommand(['guard', '--allow-primary']));
    assert.strictEqual(result.code, 3);
    assert.strictEqual(result.err, 'blocked: checkout is dirty staged=0 unstaged=0 untracked=1');

    result = captureOutput(() => worktreeCommand(['guard', '--allow-primary', '--allow-dirty']));
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.out, 'atris worktree guard: ok');
  });
});
