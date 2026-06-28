'use strict';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-help-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('worktree start and ship subcommand help are read-only outside a git repo', () => {
  const dir = makeTempDir();
  try {
    for (const sub of ['start', 'ship']) {
      const res = runCli(['worktree', sub, '--help'], { cwd: dir });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, new RegExp(`Usage: atris worktree ${sub}`));
      assert.doesNotMatch(res.stderr, /not a git repository|blocked:|refusing:/i);
    }
    assert.equal(fs.existsSync(path.join(dir, '.agent-worktrees')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('worktree ship --help does not push or open PR from an isolated branch', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q'], repo);
    runGit(['config', 'user.email', 'test@example.com'], repo);
    runGit(['config', 'user.name', 'Test User'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.'], repo);
    runGit(['commit', '-qm', 'init'], repo);
    runGit(['branch', '-M', 'master'], repo);
    runGit(['remote', 'add', 'origin', remote], repo);
    runGit(['push', '-u', 'origin', 'master'], repo);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master'], repo);

    worktreePath = path.join(dir, 'agent-worktree');
    const start = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-shipper',
      '--task',
      'Help Guard',
      '--path',
      worktreePath,
    ], { cwd: repo });
    assert.equal(start.status, 0, start.stderr || start.stdout);

    const branch = runGit(['branch', '--show-current'], worktreePath);
    const help = runCli(['worktree', 'ship', '--help'], { cwd: worktreePath });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris worktree ship/);
    assert.doesNotMatch(help.stdout, /push:|commit:|verify:|pr:|merge_check:/);
    const remoteRefs = spawnSync('git', [`--git-dir=${remote}`, 'for-each-ref', '--format=%(refname)', 'refs/heads'], { encoding: 'utf8' });
    assert.equal(remoteRefs.status, 0, remoteRefs.stderr || remoteRefs.stdout);
    assert.doesNotMatch(remoteRefs.stdout, new RegExp(`^refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});
