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

// A fake claude engine that always writes hello.txt containing "hi", so the
// same work passes one check and fails another.
function fakeEngineEnv(base) {
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    "printf 'hi' > hello.txt",
    'echo \'{"type":"result","is_error":false,"result":"created hello.txt containing hi"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(executable, 0o755);
  return {
    ...scrubAgentEnv(),
    ATRIS_CALLER_RUNTIME: 'terminal',
    ATRIS_SKIP_UPDATE_CHECK: '1',
    HOME: path.join(base, 'home'),
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
  };
}

function freshProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-one-run-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(base, 'home'), { recursive: true });
  fs.mkdirSync(repo);
  const env = fakeEngineEnv(base);
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
  const passed = (result) => assert.equal(result.status, 0, result.stdout + result.stderr);
  passed(git(['init', '-q', '-b', 'master']));
  passed(git(['config', 'user.email', 'test@atris.dev']));
  passed(git(['config', 'user.name', 'test']));
  passed(spawnSync(process.execPath, [cliPath, 'init'], { cwd: repo, encoding: 'utf8', env, timeout: 60000 }));
  passed(git(['add', '-A']));
  passed(git(['commit', '-qm', 'baseline']));
  return { base, repo, env };
}

function memberRun(project, objective, verifier) {
  const res = spawnSync(process.execPath, [
    cliPath, 'member', 'run', 'executor', objective, '--ignite', '--no-referee', ...(verifier ? ['--verify', verifier] : []), '--json',
  ], { cwd: project.repo, encoding: 'utf8', env: project.env, timeout: 120000 });
  let payload = null;
  try { payload = JSON.parse(res.stdout); } catch {}
  assert.ok(payload, `member run printed no json\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return { status: res.status, payload };
}

test('one member run ends complete when the work is done and its check passes', () => {
  const project = freshProject();
  try {
    const { status, payload } = memberRun(project, 'create hello.txt containing hi', 'test "$(cat hello.txt)" = hi');
    assert.equal(status, 0, JSON.stringify(payload).slice(0, 600));
    assert.equal(payload.ok, true);
    assert.equal(payload.state, 'complete');
    assert.equal(payload.check_failed, undefined);
  } finally {
    fs.rmSync(project.base, { recursive: true, force: true });
  }
});

// Before this, a failed check still printed ok:true and exited 0, so a script
// or a calling agent could not tell the mission failed.
test('one member run ends clearly failed with the reason when its check fails', () => {
  const project = freshProject();
  try {
    const { status, payload } = memberRun(project, 'create bye.txt containing bye', 'test "$(cat bye.txt)" = bye');
    assert.equal(status, 1, JSON.stringify(payload).slice(0, 600));
    assert.equal(payload.ok, false);
    assert.equal(payload.started, true);
    assert.equal(payload.state, 'blocked');
    assert.equal(payload.check_failed, true);
    assert.match(payload.error, /check failed: test "\$\(cat bye\.txt\)" = bye/);

    // The plain run a person types streams live and must fail the same way.
    const plain = spawnSync(process.execPath, [
      cliPath, 'member', 'run', 'executor', 'create bye.txt containing bye', '--ignite', '--no-referee', '--verify', 'test "$(cat bye.txt)" = bye',
    ], { cwd: project.repo, encoding: 'utf8', env: project.env, timeout: 120000 });
    assert.equal(plain.status, 1, plain.stdout + plain.stderr);
    assert.match(plain.stderr, /the work ran but its check failed/);
  } finally {
    fs.rmSync(project.base, { recursive: true, force: true });
  }
});

// The member file's check used to lose its closing quote on read, so
// `verify: test "$(cat hello.txt)" = "hi"` became a shell syntax error and a
// correct run could never end complete.
test('one member run ends complete with a quoted check from the member file', () => {
  const project = freshProject();
  try {
    const memberFile = path.join(project.repo, 'atris', 'team', 'executor', 'MEMBER.md');
    const text = fs.readFileSync(memberFile, 'utf8');
    fs.writeFileSync(memberFile, text.replace(/^role: .*$/m, (line) => `${line}\nverify: test "$(cat hello.txt)" = "hi"`));
    const commit = spawnSync('git', ['commit', '-qam', 'add member check'], { cwd: project.repo, env: project.env, encoding: 'utf8' });
    assert.equal(commit.status, 0, commit.stdout + commit.stderr);
    const { status, payload } = memberRun(project, 'create hello.txt containing hi', '');
    assert.equal(payload.mission.verifier, 'test "$(cat hello.txt)" = "hi"');
    assert.equal(status, 0, JSON.stringify(payload).slice(0, 600));
    assert.equal(payload.state, 'complete');
  } finally {
    fs.rmSync(project.base, { recursive: true, force: true });
  }
});
