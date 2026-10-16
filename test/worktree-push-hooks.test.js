'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function setup(t, hookBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-push-hook-'));
  const remote = path.join(root, 'remote.git');
  const primary = path.join(root, 'primary');
  const work = path.join(root, 'work');
  const pidFile = path.join(root, 'hook.pid');
  const finished = path.join(root, 'hook.finished');
  t.after(() => {
    if (fs.existsSync(pidFile) && !fs.existsSync(finished)) {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(primary);
  const env = { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' };
  const git = (args, cwd = primary) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const checked = (args, cwd) => {
    const run = git(args, cwd);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return run.stdout.trim();
  };
  checked(['init', '--bare', '-q', remote]);
  checked(['init', '-q']);
  checked(['config', 'user.name', 'Test User']);
  checked(['config', 'user.email', 'test@example.com']);
  // These tests exercise only their own real hook, regardless of user config.
  checked(['config', 'core.hooksPath', path.join(primary, '.git', 'hooks')]);
  fs.writeFileSync(path.join(primary, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(primary, 'app.js'), 'module.exports = 1;\n');
  checked(['add', '.']);
  checked(['commit', '-qm', 'initial']);
  checked(['branch', '-M', 'master']);
  checked(['remote', 'add', 'origin', remote]);
  checked(['push', '-u', 'origin', 'master']);
  checked(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  checked(['worktree', 'add', '-q', '-b', 'hook-change', work, 'master']);
  fs.writeFileSync(path.join(work, 'app.js'), 'module.exports = 2;\n');
  const body = typeof hookBody === 'function' ? hookBody({ finished }) : hookBody;
  fs.writeFileSync(path.join(primary, '.git', 'hooks', 'pre-push'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${body}\n`, { mode: 0o755 });
  return {
    git, remote, work, finished,
    ship: () => spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'Keep the required checks', '--verify', `${process.execPath} --check app.js`, '--no-pr', '--no-map-refresh'], {
      cwd: work, env, encoding: 'utf8', timeout: 50000,
    }),
  };
}

test('a real pre-push hook can finish after the old thirty-second network cap', (t) => {
  const fixture = setup(t, ({ finished }) => `setTimeout(() => { fs.writeFileSync(${JSON.stringify(finished)}, "passed"); process.exit(0); }, 31000);`);
  const run = fixture.ship();
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(fs.readFileSync(fixture.finished, 'utf8'), 'passed');
  assert.equal(fixture.git(['--git-dir', fixture.remote, 'show-ref', '--verify', '--quiet', 'refs/heads/hook-change']).status, 0);
  const head = fixture.git(['rev-parse', 'HEAD'], fixture.work).stdout.trim();
  const remoteHead = fixture.git(['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/hook-change']).stdout.trim();
  assert.equal(remoteHead, head);
  assert.match(run.stdout, /done: worktree shipped/);
});

test('a real rejected push retains the hook reason on stdout and keeps the remote unchanged', (t) => {
  const fixture = setup(t, 'console.log("required check failed: a concrete regression was found"); console.error("hook refused the change"); process.exit(1);');
  const run = fixture.ship();
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stderr, /required check failed: a concrete regression was found/);
  assert.match(run.stderr, /hook refused the change/);
  assert.equal(fixture.git(['--git-dir', fixture.remote, 'show-ref', '--verify', '--quiet', 'refs/heads/hook-change']).status, 1);
  assert.doesNotMatch(run.stdout, /done: worktree shipped/);
});
