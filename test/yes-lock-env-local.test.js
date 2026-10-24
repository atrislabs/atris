'use strict';

// 3.74.5: woken members were still held, about 30 requests in 10 minutes,
// for local commands in test fixtures (git rev-parse, git config user.name)
// whose test suite runs git with GIT_CONFIG_COUNT / GIT_CONFIG_PARAMETERS
// (core.hooksPath and the like). The -c and git config environment check
// guards against a push past the wrapper, so it applies only to commands that
// talk to a network remote. Local commands pass in any folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const yesLock = require('../lib/yes-lock');

const BASE_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of Object.keys(BASE_ENV)) if (/^GIT_CONFIG/.test(k)) delete BASE_ENV[k];
const SUITE_ENV = { ...BASE_ENV, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/tmp/x' };
const PARAMS_ENV = { ...BASE_ENV, GIT_CONFIG_PARAMETERS: "'core.hookspath'='/tmp/x'" };
const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function world(t, seal) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-one-lap-forge-sidecar-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const origin = path.join(base, 'origin.git');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: BASE_ENV, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'master');
  git('checkout', '-q', '-b', 'feature');
  git('remote', 'add', 'github', 'git@github.com:example/repo.git');
  yesLock.writeYesLocks(stateDir, 'm', { seal });
  const verdict = (tool, args, env) => yesLock.check({ stateDir, missionId: 'm', seal, tool, args, gitBin, cwd: root, env });
  return { root, origin, stateDir, verdict };
}

const held = v => Boolean(v && v.hold);
const runs = v => !v || (!v.hold && !v.consume);

const LOCAL = [
  ['rev-parse', '--verify', 'origin/master^{commit}'], ['config', 'user.name'], ['status'], ['commit', '--allow-empty', '-m', 'x'],
  ['-c', 'core.hooksPath=/tmp/x', 'status'], ['--exec-path=/tmp', 'status'], ['fetch', 'origin'], ['push', 'origin', 'master'],
];

for (const [label, seal] of [['a woken run', yesLock.handoffSeal()], ['a bet that locks merging', yesLock.sealFor([{ text: 'merge it to master', who: 'you', public: false }])]]) {
  test(`${label}: a local command passes with a test suite's git config env`, (t) => {
    const w = world(t, seal);
    for (const env of [SUITE_ENV, PARAMS_ENV]) {
      for (const args of LOCAL) {
        if (label !== 'a woken run' && args[0] === 'push') continue; // a bet still reads where a push goes
        assert.ok(runs(w.verdict('git', args, env)), `${args.join(' ')} with ${Object.keys(env).filter(k => /^GIT_CONFIG/.test(k)).join(',')}`);
      }
    }
  });

  test(`${label}: a command that talks to a network remote is still held under that env`, (t) => {
    const w = world(t, seal);
    for (const args of [['push', 'github', 'feature'], ['fetch', 'github'], ['-c', 'core.sshCommand=ssh -i k', 'push', 'github', 'feature']]) {
      assert.ok(held(w.verdict('git', args, SUITE_ENV)), args.join(' '));
    }
  });
}

test('a woken run leaves no yes request for local work under that env', (t) => {
  const w = world(t, yesLock.handoffSeal());
  for (const args of LOCAL) w.verdict('git', args, SUITE_ENV);
  assert.deepEqual(yesLock.askedYesLocks(w.stateDir, 'm'), []);
});

// A guarded job whose tests make their own guard (the suite under a woken
// run, or a mission tick inside one) ran each guard's script shell as the
// other's "configured shell", and the inner one ran itself forever.
test('a package script under two nested guards finishes and keeps the configured shell', (t) => {
  const npm = require('node:child_process').spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();
  if (!npm) { t.skip('no npm here'); return; }
  const { prepareMissionGitGuard } = require('../lib/mission-protected-lane');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-nested-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'feature', root]);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { ok: 'echo fine', ship: 'npm publish' } }));
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'npm'), '#!/bin/sh\necho LOCAL-NPM-RAN\n', { mode: 0o755 });
  const shell = path.join(base, 'configured-shell');
  fs.writeFileSync(shell, '#!/bin/sh\necho configured-shell-ran\nexec /bin/sh "$@"\n', { mode: 0o755 });
  const seal = yesLock.handoffSeal();
  const guard = (id, pathValue) => {
    const stateDir = path.join(base, `state-${id}`);
    yesLock.writeYesLocks(stateDir, id, { seal });
    const g = prepareMissionGitGuard({ root, missionId: id, yesLockSeal: seal, stateDir, pathValue });
    t.after(() => g.cleanup());
    return g;
  };
  const outer = guard('m-outer', [path.dirname(npm), path.dirname(process.execPath), path.dirname(gitBin), '/usr/bin', '/bin'].join(path.delimiter));
  const inner = guard('m-inner', outer.env.PATH);
  const run = cmd => require('node:child_process').spawnSync('sh', ['-c', cmd], { cwd: root, env: { ...BASE_ENV, PATH: inner.env.PATH }, encoding: 'utf8', timeout: 60000 });
  const ok = run('npm run ok');
  assert.equal(ok.error, undefined, 'it finished');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^fine$/m);
  fs.writeFileSync(path.join(root, '.npmrc'), `script-shell=${shell}\n`);
  const configured = run('npm run ok');
  assert.equal(configured.error, undefined, 'it finished with a configured shell');
  assert.match(configured.stdout, /^configured-shell-ran$/m, configured.stdout + configured.stderr);
  const ship = run('npm run ship');
  assert.doesNotMatch(ship.stdout + ship.stderr, /LOCAL-NPM-RAN/);
  assert.match(ship.stderr, /held: a handed-off job wants to npm publish/);
});
