'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fleet = require('../lib/fleet');
const { createAgentWorktree, gitFailureDetail } = require('../commands/worktree');

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-git-calls-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const origin = path.join(dir, 'origin.git');
  fs.mkdirSync(root);
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  git(['init', '--bare', '-q', '--initial-branch=main', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', 'origin', 'main']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return { dir, root, origin };
}

// Log every git spawn so the test can count the SSH config probes.
function traceGit(t, dir) {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(dir, 'bin');
  const trace = path.join(dir, 'git.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
const run = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
}

const isProbe = (args) => args[0] === 'config' && args[2] === 'core.sshCommand';
const isNetwork = (args) => ['fetch', 'push', 'ls-remote'].includes(args[0]);

test('a killed git call reads as timed out, not blank', (t) => {
  const { root } = repo(t);
  const killed = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 50, killSignal: 'SIGKILL', encoding: 'utf8' });
  assert.equal(gitFailureDetail(killed), 'timed out');
  assert.equal(gitFailureDetail({ status: 1, stderr: ' fatal: nope \n' }), 'fatal: nope');
  const git = (args) => (args[0] === 'fetch' ? killed : spawnSync('git', args, { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(fleet.landArrival({ worktreePath: root, targetRef: 'origin/main', git }),
    { ok: false, stage: 'fetch', detail: 'timed out' });
});

test('a new worktree cut from an unrefreshed base says so', (t) => {
  const { dir, root, origin } = repo(t);
  fs.rmSync(origin, { recursive: true, force: true });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    createAgentWorktree({ root, member: 'tester', task: 'stale base', base: 'origin/main', path: path.join(dir, 'work') });
  } finally {
    console.error = original;
  }
  const warning = errors.find((line) => line.includes('could not refresh origin/main'));
  assert.ok(warning, errors.join('\n'));
  assert.match(warning, /may be behind/);
});

test('only network git calls pay for the SSH config probe', (t) => {
  const { dir, root } = repo(t);
  const calls = traceGit(t, dir);
  createAgentWorktree({ root, member: 'tester', task: 'probe count', base: 'origin/main', path: path.join(dir, 'work') });
  const seen = calls();
  assert.ok(seen.filter(isNetwork).length > 0);
  assert.ok(seen.filter((args) => !isProbe(args) && !isNetwork(args)).length > 5);
  assert.equal(seen.filter(isProbe).length, seen.filter(isNetwork).length);
});

test('a fleet landing probes the SSH setup once for all its git calls', (t) => {
  const { dir, root } = repo(t);
  const calls = traceGit(t, dir);
  assert.equal(fleet.landArrival({ worktreePath: root, targetRef: 'origin/main' }).ok, true);
  const seen = calls();
  assert.ok(seen.length > 3);
  assert.equal(seen.filter(isProbe).length, 1);
});
