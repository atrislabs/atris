const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-ship-detached-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function setupRepo(dir) {
  const remote = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  git(['branch', '-M', 'master']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'master']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  return { remote, repo, git };
}

test('worktree ship creates and pushes a branch from detached head', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const { remote, repo, git } = setupRepo(dir);
    worktreePath = path.join(dir, 'detached-ship-worktree');
    const start = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-shipper',
      '--task',
      'Ship Detached',
      '--path',
      worktreePath,
    ], { cwd: repo });
    assert.equal(start.status, 0, start.stderr || start.stdout);

    git(['checkout', '--detach'], worktreePath);
    fs.appendFileSync(path.join(worktreePath, 'README.md'), 'changed\n');

    const shipped = runCli([
      'worktree',
      'ship',
      '--message',
      'ship detached',
      '--verify',
      'git status --short',
      '--no-pr',
    ], { cwd: worktreePath });

    const branch = `codex/${path.basename(worktreePath)}`;
    assert.equal(shipped.status, 0, shipped.stderr || shipped.stdout);
    assert.match(shipped.stdout, new RegExp(`ship: detached head, created branch ${branch}`));
    assert.equal(git(['branch', '--show-current'], worktreePath), branch);
    assert.match(
      git(['show-ref', '--verify', `refs/heads/${branch}`], worktreePath),
      new RegExp(`refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    );
    assert.match(
      git(['--git-dir', remote, 'show-ref', '--verify', `refs/heads/${branch}`], dir),
      new RegExp(`refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    );
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('worktree ship still blocks from master', () => {
  const dir = makeTempDir();
  try {
    const { repo } = setupRepo(dir);
    const shipped = runCli([
      'worktree',
      'ship',
      '--verify',
      'git status --short',
      '--no-pr',
    ], { cwd: repo });
    assert.equal(shipped.status, 2, shipped.stderr || shipped.stdout);
    assert.match(shipped.stderr, /blocked: ship from a feature worktree branch, not master\/main/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('worktree ship blocks detached head on primary checkout', () => {
  const dir = makeTempDir();
  try {
    const { repo, git } = setupRepo(dir);
    git(['checkout', '--detach'], repo);
    const shipped = runCli([
      'worktree',
      'ship',
      '--verify',
      'git status --short',
      '--no-pr',
    ], { cwd: repo });
    assert.equal(shipped.status, 2, shipped.stderr || shipped.stdout);
    assert.match(shipped.stderr, /blocked: detached head on the primary checkout/);
  } finally {
    cleanupTempDir(dir);
  }
});
