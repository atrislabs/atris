'use strict';

// atris worktree ship and atris check: a verify that exits 3 with atris
// check's needs-a-lane line proved nothing here, so ship stops before the push
// and never counts it as passed. A plain failing verify fails as it always has.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { CHECK_NEEDS_LANE_LINE } = require('../lib/check-receipt');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function runCli(args, cwd) {
  const env = { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_SHIP_SKIP_NETS: '1' };
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', timeout: 60000, env });
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ship-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  spawnSync('git', ['init', '--bare', '-q', remote]);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# ship\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(repo, 'needs-lane.js'), `console.log(${JSON.stringify(`${CHECK_NEEDS_LANE_LINE}. 1 passed here`)}); process.exit(3);\n`);
  fs.writeFileSync(path.join(repo, 'stray-three.js'), 'process.exit(3);\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  git(['branch', '-M', 'master']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-q', '-u', 'origin', 'master']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  const copy = path.join(dir, 'copy');
  const start = runCli(['worktree', 'start', '--agent', 'codex-shipper', '--task', 'ship check', '--path', copy], repo);
  assert.equal(start.status, 0, start.stderr || start.stdout);
  fs.appendFileSync(path.join(copy, 'README.md'), 'changed\n');
  return { copy, remote, git };
}

test('ship stops on atris check exit 3: not proven here, never a pass', (t) => {
  const { copy, remote, git } = setup(t);
  const result = runCli(['worktree', 'ship', '--message', 'change', '--verify', 'node needs-lane.js', '--no-pr'], copy);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /needs the no-screen lane/);
  const branch = git(['branch', '--show-current'], copy);
  assert.notEqual(spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', `refs/heads/${branch}`]).status, 0, 'nothing was pushed');
});

test('a stray exit 3 without the line is a plain failure, as before', (t) => {
  const { copy } = setup(t);
  const result = runCli(['worktree', 'ship', '--message', 'change', '--verify', 'node stray-three.js', '--no-pr'], copy);
  assert.notEqual(result.status, 0);
  assert.notEqual(result.status, 3);
});
