'use strict';

// Codex review round 8 on #1483: four ways a woken run got past the
// allowlist, each closed as a class. The lock guards against accidents, not
// a hostile agent; full paths and curl go around it by design.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const yesLock = require('../lib/yes-lock');
const { prepareMissionGitGuard } = require('../lib/mission-protected-lane');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of Object.keys(GIT_ENV)) if (/^GIT_CONFIG/.test(k)) delete GIT_ENV[k];
const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function world(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-r8-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const origin = path.join(base, 'origin.git');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'master');
  git('checkout', '-q', '-b', 'feature');
  git('commit', '-q', '--allow-empty', '-m', 'work');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(stateDir, 'm-woken', { seal });
  const verdict = (tool, args, env = GIT_ENV) => yesLock.check({ stateDir, missionId: 'm-woken', seal, tool, args, gitBin, cwd: root, env });
  const guard = (pathValue) => {
    const g = prepareMissionGitGuard({ root, missionId: 'm-woken', yesLockSeal: seal, stateDir, pathValue });
    t.after(() => g.cleanup());
    return g;
  };
  return { base, root, origin, stateDir, seal, git, verdict, guard };
}

const held = v => Boolean(v && v.hold);
const runs = v => !v || (!v.hold && !v.consume);

// ---- 1: npm, yarn, pnpm read the command the way the tool does --------------------

test('codex 1: npm -- publish is a publish; an empty or unknown command is held', (t) => {
  const w = world(t);
  for (const [tool, args] of [['npm', ['--', 'publish']], ['npm', ['--registry', 'x', '--', 'publish']], ['yarn', ['--', 'publish']],
    ['pnpm', ['--', 'publish']], ['npm', []], ['yarn', []], ['pnpm', []], ['npm', ['--', 'frob']],
    ['npm', ['run', 'ship', '--script-shell=/bin/bash']], ['pnpm', ['--shell-emulator', 'run', 'ship']]]) {
    assert.ok(held(w.verdict(tool, args)), `${tool} ${args.join(' ')}`);
  }
  assert.ok(runs(w.verdict('npm', ['test', '--', '--watch'])), 'words after -- go to the script');
  assert.ok(runs(w.verdict('npm', ['run', 'build', '--', 'publish'])));
  assert.deepEqual(yesLock.analyze('npm', ['--', 'publish']).cats, ['publish'], 'a bet reads it the same way');
});

// ---- 2: a ref a command writes must be a plain branch name -------------------------

test('codex 2: git branch -f @{-1} is held, and so is any target that is not a plain branch name', (t) => {
  const w = world(t);
  assert.equal(w.git('rev-parse', '--symbolic-full-name', '@{-1}'), 'refs/heads/master', 'the last branch is master');
  for (const args of [
    ['branch', '-f', '@{-1}', 'HEAD'], ['branch', '-D', '@{-1}'], ['branch', '-f', '@', 'HEAD'], ['branch', 'HEAD~1'],
    ['checkout', 'HEAD~1'], ['checkout', '@{-1}'], ['switch', '@{-1}'], ['checkout', '-B', '@{-1}'], ['switch', '-C', 'refs/heads/x'],
    ['worktree', 'add', '../wt', '@{-1}'], ['worktree', 'add', '-B', '@{-1}', '../wt'], ['stash', 'branch', '@{-1}'],
    ['push', 'origin', 'HEAD:refs/heads/@{-1}'],
  ]) assert.ok(held(w.verdict('git', args)), args.join(' '));
  // a name that is a symbolic ref to master resolves to master
  w.git('symbolic-ref', 'refs/heads/alias', 'refs/heads/master');
  assert.ok(held(w.verdict('git', ['branch', '-f', 'alias', 'HEAD'])), 'resolves to master');
  assert.ok(held(w.verdict('git', ['checkout', 'alias'])));
  // where a command starts from is not what it writes
  for (const args of [['branch', 'next', '@{-1}'], ['checkout', '-b', 'next', 'HEAD~1'], ['switch', '-c', 'next', 'origin/master'],
    ['branch', '-f', 'feature', 'HEAD'], ['checkout', 'feature'], ['checkout', 'origin/master'], ['checkout', 'HEAD~1', '--', 'x.js']]) {
    assert.ok(runs(w.verdict('git', args)), args.join(' '));
  }
});

// ---- 3: git takes no config or exec path from the command line or environment -------

test('codex 3: git -c, --config-env, --exec-path and GIT_CONFIG env are held in a woken run', (t) => {
  const w = world(t);
  for (const args of [['-c', 'core.fsmonitor=git push origin HEAD:refs/heads/master; false', 'status'], ['-c', 'color.ui=never', 'log'],
    ['--config-env=core.pager=P', 'log'], ['--exec-path=/tmp', 'status'], ['--exec-path', 'status']]) {
    assert.ok(held(w.verdict('git', args)), args.join(' '));
  }
  for (const env of [{ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'x' }, { GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='x'" },
    { GIT_CONFIG_GLOBAL: '/tmp/x' }, { GIT_EXEC_PATH: '/tmp' }]) {
    assert.ok(held(w.verdict('git', ['status'], { ...GIT_ENV, ...env })), JSON.stringify(env));
  }
  assert.ok(runs(w.verdict('git', ['status'], { ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1' })), 'turning system config off adds nothing');
  // the real attack, through the real wrapper: master on origin does not move
  const before = execFileSync('git', ['rev-parse', 'refs/heads/master'], { cwd: w.origin, encoding: 'utf8' }).trim();
  w.git('checkout', '-q', 'feature');
  const g = w.guard([path.dirname(process.execPath), path.dirname(gitBin), '/usr/bin', '/bin'].join(path.delimiter));
  const res = spawnSync('sh', ['-c', `git -c core.fsmonitor='git push -q origin HEAD:refs/heads/master; false' status`], { cwd: w.root, env: { ...GIT_ENV, PATH: g.env.PATH }, encoding: 'utf8' });
  assert.equal(res.status, 77, res.stderr);
  assert.equal(execFileSync('git', ['rev-parse', 'refs/heads/master'], { cwd: w.origin, encoding: 'utf8' }).trim(), before, 'origin master did not move');
});

// ---- 4: a command an allowed command starts keeps the wrappers first ------------------

// A guard folder on PATH with a stand-in npm, as a woken run has.
function fakeGuardPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\necho wrapped\n', { mode: 0o755 });
  return dir;
}

function withPath(value, fn) {
  const old = process.env.PATH;
  process.env.PATH = value;
  try { return fn(); } finally { process.env.PATH = old; }
}

test('codex 4: task ready, its falsifier probe, verified proofs and mission verifiers keep the wrapper folder first', (t) => {
  const dir = fakeGuardPath(t);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-r8-ws-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const nodeDir = path.dirname(process.execPath);
  // the node folder (which holds the real npm) is put first by each of these;
  // the wrapper folder must still win
  const PATHV = [dir, '/usr/bin', '/bin'].join(path.delimiter);
  const { writeTaskReceipt } = require('../lib/task-receipt');
  const receipt = withPath(PATHV, () => writeTaskReceipt({ taskId: 'T1', command: 'npm publish --dry-run', root: ws }));
  assert.match(receipt.output, /wrapped/, `task ready ran the real npm: ${receipt.output}`);
  const { buildVerifiedProof } = require('../lib/task-proof');
  const proof = withPath(PATHV, () => buildVerifiedProof('npm publish --dry-run | grep -q wrapped', '', undefined, { cwd: ws }));
  assert.equal(proof.ok, true, JSON.stringify(proof));
  const { envWithNodeDir } = require('../lib/spawn-env');
  const env = envWithNodeDir({ PATH: PATHV });
  assert.equal(env.PATH.split(path.delimiter)[0], dir, 'the wrapper folder stays first');
  assert.ok(env.PATH.split(path.delimiter).includes(nodeDir));
  const { probeVerifierCanFail } = require('../lib/falsifier-probe');
  const probe = withPath(PATHV, () => probeVerifierCanFail({ command: 'npm publish --dry-run | grep -q wrapped' }));
  assert.equal(probe.canFail, false, `the probe reached the wrapper: ${JSON.stringify(probe)}`);
});

test('a package script that calls a project-local npm reaches the wrapper, not the local npm', (t) => {
  const w = world(t);
  const npm = spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();
  if (!npm) { t.skip('no npm on this machine'); return; }
  fs.writeFileSync(path.join(w.root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { ship: 'npm publish' } }));
  fs.mkdirSync(path.join(w.root, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'node_modules', '.bin', 'npm'), '#!/bin/sh\necho LOCAL-NPM-RAN\n', { mode: 0o755 });
  const g = w.guard([path.dirname(npm), path.dirname(process.execPath), path.dirname(gitBin), '/usr/bin', '/bin'].join(path.delimiter));
  const res = spawnSync('sh', ['-c', 'npm run -s ship'], { cwd: w.root, env: { ...GIT_ENV, PATH: g.env.PATH }, encoding: 'utf8' });
  assert.doesNotMatch(res.stdout + res.stderr, /LOCAL-NPM-RAN/, 'the script did not reach the local npm');
  assert.match(res.stderr, /held: a handed-off job wants to npm publish/);
  assert.notEqual(res.status, 0);
});
