'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { captureBase, checkRepo } = require('../lib/member-extra-checks');
const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');

function project(t, mode, { useGit = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-extra-checks-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'atris', 'team', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'demo', 'MEMBER.md'), '---\nname: demo\nrole: Builder\n---\n');
  fs.writeFileSync(path.join(root, 'hello.txt'), 'old\n');
  fs.writeFileSync(path.join(root, 'check.cjs'), "const fs = require('node:fs'); if (fs.readFileSync('hello.txt', 'utf8').trim() !== 'new') process.exit(1); console.log('behavior passed');\n");
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    mode === 'clean' ? "printf 'new\\n' > hello.txt" : "printf 'new \\n' > hello.txt",
    mode === 'staged' ? 'git add hello.txt' : '',
    mode === 'committed' ? 'git add hello.txt && git commit -qm changed' : '',
    'echo \'{"type":"result","is_error":false,"result":"updated hello.txt"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const env = { ...scrubAgentEnv(), HOME: path.join(base, 'home'),
    ATRIS_CALLER_RUNTIME: 'terminal', ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_TASKS_DB: path.join(base, 'tasks.db'),
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };
  fs.mkdirSync(env.HOME);
  function git(args) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  }
  if (useGit) {
    git(['init', '-q', '-b', 'master']);
    git(['config', 'user.name', 'test']);
    git(['config', 'user.email', 'test@atris.dev']);
    git(['add', '-A']);
    git(['commit', '-qm', 'baseline']);
  }
  return { root, env, git };
}

function run(p, { plain = false, flags = [], verifier = 'node check.cjs' } = {}) {
  const result = spawnSync(process.execPath, [cli, 'member', 'run', 'demo', 'update hello.txt',
    '--runner', 'claude', '--shared-checkout', '--ignite', '--no-referee', '--max-ticks', '1',
    '--verify', verifier, ...flags, ...(plain ? [] : ['--json'])],
  { cwd: p.root, env: p.env, encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  return { ...result, payload: plain ? null : JSON.parse(result.stdout) };
}

for (const mode of ['unstaged', 'staged', 'committed']) {
  test(`member run blocks ${mode} whitespace even when its named behavior check passes`, (t) => {
    const p = project(t, mode);
    const result = run(p);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const r = result.payload;
    assert.equal(r.ok, false);
    assert.equal(r.started, true);
    assert.equal(r.state, 'blocked');
    assert.equal(r.check_failed, true);
    assert.match(r.error, /repo formatting check failed/);
    assert.equal(r.mission.verifier, 'node check.cjs');
    assert.equal(r.mission.verifier_result.status, 0);
    assert.match(r.mission.verifier_result.stdout, /behavior passed/);
    assert.equal(r.mission.verifier_result.extra_checks.passed, false);
    assert.match(r.mission.verifier_result.extra_checks.stdout, /hello.txt:1: trailing whitespace/);
    assert.equal(r.autoland, undefined);
    const receipt = JSON.parse(fs.readFileSync(path.resolve(p.root, r.work_step.receipt_path), 'utf8'));
    assert.equal(receipt.result.ticks.at(-1).verifier_passed, false);
  });
}

test('clean member run completes and records the extra checks without replacing its named check', (t) => {
  const result = run(project(t, 'clean'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.payload.state, 'complete');
  const check = result.payload.mission.verifier_result;
  assert.equal(check.command, 'node check.cjs');
  assert.equal(check.passed, true);
  assert.equal(check.extra_checks.checks.length, 3);
});

test('plain member run exits one and explains the formatting failure', (t) => {
  const result = run(project(t, 'staged'), { plain: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /repo formatting check failed/);
});

test('non-git member run skips repo checks and completes', (t) => {
  const result = run(project(t, 'unstaged', { useGit: false }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.payload.state, 'complete');
  assert.equal(result.payload.mission.verifier_result.extra_checks.skipped, true);
});

test('a failing named check remains the reason and does not run extra checks', (t) => {
  const result = run(project(t, 'staged'), { verifier: 'node -e "process.exit(1)"' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.payload.mission.verifier_result.extra_checks, undefined);
  assert.match(result.payload.error, /its check failed: node -e/);
});

test('explicit no-verify does not run repo checks', (t) => {
  const p = project(t, 'staged');
  const unchecked = run(p, { flags: ['--no-verify'] });
  assert.equal(unchecked.status, 0, unchecked.stdout + unchecked.stderr);
  assert.equal(unchecked.payload.mission.verifier_result, null);
});

test('unborn repos are checked and git errors fail closed', (t) => {
  const p = project(t, 'clean', { useGit: false });
  p.git(['init', '-q']);
  const base = captureBase(p.root);
  fs.writeFileSync(path.join(p.root, 'hello.txt'), 'new \n');
  p.git(['add', 'hello.txt']);
  assert.equal(checkRepo(p.root, base).passed, false);
  assert.equal(checkRepo(p.root, { head: 'missing-ref' }).passed, false);
});
