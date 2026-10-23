'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');

// A codex session around the suite would make member run pick codex_goal.
for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_CALLER_RUNTIME']) delete process.env[name];

// Scratch missions must not inherit the surrounding mission driver's identity.
delete process.env.ATRIS_MISSION_DRIVER_DETACHED;
delete process.env.ATRIS_MISSION_DRIVER_PARENT_PID;

function workspace(t, beforeCleanup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-run-start-'));
  t.after(async () => {
    if (beforeCleanup) await beforeCleanup(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'atris', 'team', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'demo', 'MEMBER.md'), '---\nname: demo\nrole: Builder\n---\n');
  return root;
}

function fakeClaude(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then',
    '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
    '  exit 0',
    'fi',
    'echo \'{"type":"result","is_error":false,"result":"finished the bounded task"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(executable, 0o755);
  return bin;
}

function run(root, args, bin = null, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, 'member', 'run', 'demo', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(bin ? { PATH: `${bin}${path.delimiter}${process.env.PATH}` } : {}),
      ...extraEnv,
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('member run without a check creates and runs a mission', (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  const result = run(root, ['bounded work', '--runner', 'claude', '--max-ticks', '1', '--minutes', '1', '--json'], bin);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, true);
  assert.ok(payload.ran_ticks > 0);
  assert.ok(payload.mission_id);
  assert.equal(payload.mission.verifier, '');
});

test('member run without a check still runs the mission default check', (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const result = run(root, ['bounded work', '--runner', 'claude', '--shared-checkout', '--max-ticks', '1', '--minutes', '1', '--json'], bin);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, true);
  assert.equal(payload.ticks[0].verifier_passed, true);
  assert.equal(payload.mission.verifier_result.command, 'git diff --check');
});

test('member run with text passes the chosen runner and engine to the run', (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  const argvFile = path.join(root, 'mission-run-args.json');
  const hookFile = path.join(root, 'record-run.cjs');
  fs.writeFileSync(hookFile, [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'mission' && args[1] === 'run') fs.writeFileSync(process.env.ATRIS_TEST_RUN_ARGS, JSON.stringify(args));",
    '',
  ].join('\n'));
  const result = run(root, [
    'bounded work', '--runner', 'atris2', '--engine', 'claude',
    '--max-ticks', '1', '--minutes', '1', '--no-verify', '--json',
  ], bin, { ATRIS_TEST_RUN_ARGS: argvFile,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${hookFile}`.trim() });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, true);
  assert.equal(payload.mission.objective, 'bounded work');
  assert.equal(payload.mission.runner, 'atris2');
  assert.equal(payload.ran_ticks, 1);
  const runArgs = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.deepEqual(runArgs.slice(0, 3), ['mission', 'run', payload.mission_id]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf('--runner'), runArgs.indexOf('--runner') + 2), ['--runner', 'atris2']);
  assert.deepEqual(runArgs.slice(runArgs.indexOf('--engine'), runArgs.indexOf('--engine') + 2), ['--engine', 'claude']);
  assert.deepEqual(runArgs.slice(runArgs.indexOf('--max-wall'), runArgs.indexOf('--max-wall') + 2), ['--max-wall', '60']);
  for (const flag of ['--headless', '--self-drive', '--complete-on-pass']) assert.equal(runArgs.includes(flag), false);
  assert.equal(runArgs.includes('--no-verify'), true);
});

test('member run keeps flag values when mission text follows the flags', (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  const result = run(root, ['--runner', 'atris2', '--engine', 'claude', 'claude', 'bounded', 'work',
    '--max-ticks', '1', '--no-verify', '--json'], bin);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, true);
  assert.equal(payload.mission.objective, 'claude bounded work');
  assert.equal(payload.mission.runner, 'atris2');
});

test('member run reports the mission command refusal without replacing its reason', (t) => {
  const root = workspace(t);
  const result = run(root, ['bounded work', '--runner', 'claude', '--engine', 'missing-engine',
    '--max-ticks', '1', '--no-verify', '--json']);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, false);
  assert.match(payload.error, /Unknown engine "missing-engine"/);
});

test('member run reports no start when the mission runs zero work steps', (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    'echo \'{"type":"result","is_error":true,"result":"worker failed"}\'',
    '',
  ].join('\n'));
  const result = run(root, ['bounded work', '--runner', 'claude', '--max-ticks', '1', '--no-verify', '--json'], bin);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, false);
  assert.equal(payload.ran_ticks, 0);
  assert.equal(payload.ok, false);
});

test('member run streams human progress before the work finishes', async (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    'sleep 1',
    'touch "$ATRIS_TEST_RUNNER_FINISHED"',
    'echo \'{"type":"result","is_error":false,"result":"finished the bounded task"}\'',
    '',
  ].join('\n'));
  const finishedFile = path.join(root, 'runner-finished');
  let stderr = '';
  let liveProgress = false;
  const child = spawn(process.execPath, [cli, 'member', 'run', 'demo', 'bounded work',
    '--runner', 'claude', '--max-ticks', '1', '--no-verify'], {
    cwd: root,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TEST_RUNNER_FINISHED: finishedFile,
      PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.includes('[mission run]') && !fs.existsSync(finishedFile)) liveProgress = true;
  });
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(status, 0, stderr);
  assert.equal(liveProgress, true, stderr);
});

test('member run prints checkout and dependency link before work finishes', async (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test User'], ['add', 'atris', 'package.json', '.gitignore'], ['commit', '-qm', 'baseline']]) {
    const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  const finishedFile = path.join(root, 'runner-finished');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    'sleep 1',
    'touch "$ATRIS_TEST_RUNNER_FINISHED"',
    'echo \'{"type":"result","is_error":false,"result":"finished the bounded task"}\'',
    '',
  ].join('\n'));
  let stdout = '';
  let printedEarly = false;
  const child = spawn(process.execPath, [cli, 'member', 'run', 'demo', 'bounded work',
    '--runner', 'claude', '--max-ticks', '1', '--no-verify'], {
    cwd: root,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TEST_RUNNER_FINISHED: finishedFile,
      PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('worktree:') && stdout.includes('linked node_modules') && !fs.existsSync(finishedFile)) printedEarly = true;
  });
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(status, 0, stdout);
  assert.equal(printedEarly, true, stdout);
});

test('member run detach and dry-run do not require a completed work step', (t) => {
  const root = workspace(t, waitForMissionDriverExit);
  const bin = fakeClaude(root);
  const detached = run(root, ['bounded work', '--runner', 'claude', '--no-verify', '--detach'], bin);
  assert.equal(detached.status, 0, detached.stderr || detached.stdout);
  assert.doesNotMatch(detached.stderr, /mission did not run a work step/);

  const preview = run(root, ['preview work', '--runner', 'claude', '--no-verify', '--fleet', '--dry-run'], bin);
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.doesNotMatch(preview.stderr, /mission did not run a work step/);
});

test('member run with a check starts a headless run and reports its real state', (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  const result = run(root, ['bounded work', '--verify', 'node -e "process.exit(0)"', '--max-ticks', '1', '--minutes', '1', '--json'], bin);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, true);
  assert.equal(payload.mission.verifier, 'node -e "process.exit(0)"');
  assert.equal(payload.state, payload.mission.status);
  assert.ok(payload.ran_ticks > 0);
  assert.notEqual(payload.state, 'complete');
});

test('member run uses an explicit check in member config', (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'atris', 'team', 'demo', 'MEMBER.md'),
    '---\nname: demo\nrole: Builder\nverify: node -e "process.exit(0)"\n---\n');
  const bin = fakeClaude(root);
  const result = run(root, ['bounded work', '--max-ticks', '1', '--minutes', '1', '--json'], bin);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).started, true);
});

test('ignited member run says where to watch, and json or quiet skip it', (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  const base = ['bounded work', '--engine', 'claude', '--ignite', '--shared-checkout', '--max-ticks', '1', '--minutes', '1'];

  const plain = run(root, base, bin);
  assert.equal(plain.status, 0, plain.stderr || plain.stdout);
  assert.match(plain.stdout, /^watch: tail -f ~\/\.atris\/progress\/demo\.log$/m);
  assert.match(plain.stdout, /^board: atris member board --watch$/m);

  const json = run(root, [...base, '--json'], bin);
  assert.equal(json.status, 0, json.stderr || json.stdout);
  assert.doesNotMatch(json.stdout + json.stderr, /watch: tail -f|board: atris member board/);

  const quiet = run(root, [...base, '--quiet'], bin);
  assert.doesNotMatch(quiet.stdout + quiet.stderr, /watch: tail -f|board: atris member board/);
});


async function waitForMissionDriverExit(root, timeout = 60000) {
  const stateDir = path.join(root, '.atris', 'state');
  const deadline = Date.now() + timeout;
  let identity;
  while (Date.now() < deadline) {
    const names = fs.readdirSync(stateDir).filter((name) => /^mission-driver-.*\.json$/.test(name));
    if (names.length > 1) throw new Error('more than one detached mission driver');
    if (names.length === 1) {
      let state;
      try { state = JSON.parse(fs.readFileSync(path.join(stateDir, names[0]), 'utf8')); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (state) {
        const suffix = typeof state.mission_id === 'string' && state.mission_id.trim().slice(-8).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!suffix || names[0] !== `mission-driver-${suffix}.json` || !Number.isInteger(state.pid) || state.pid <= 0 || typeof state.started_at !== 'string' || !Number.isFinite(Date.parse(state.started_at))) {
          throw new Error('invalid detached mission driver identity');
        }
        identity ||= { name: names[0], mission_id: state.mission_id, pid: state.pid, started_at: state.started_at };
        if (names[0] === identity.name && state.mission_id === identity.mission_id && state.pid === identity.pid && state.started_at === identity.started_at
          && typeof state.exited_at === 'string' && Number.isFinite(Date.parse(state.exited_at)) && Date.parse(state.exited_at) >= Date.parse(state.started_at)) return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the detached mission driver to finish');
}

function ownedDriverWriter(root, control) {
  const script = [
    "const fs = require('node:fs'), path = require('node:path');",
    "const root = process.argv[1], mission_id = 'cleanup-12345678';",
    "const stateDir = path.join(root, '.atris', 'state'), file = path.join(stateDir, 'mission-driver-12345678.json');",
    "const state = { mission_id, pid: process.pid, started_at: new Date().toISOString() };",
    "fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(state));",
    "process.send({ ready: true, pid: process.pid, mission_id });",
    "process.on('message', (command) => {",
    "  if (command === 'mismatch') { fs.writeFileSync(file, JSON.stringify({ ...state, pid: process.pid + 1, exited_at: new Date().toISOString() })); process.send('mismatch'); return; }",
    "  if (command === 'finish') {",
    "    const logDir = path.join(root, 'atris', 'logs'); fs.mkdirSync(logDir, { recursive: true });",
    "    fs.appendFileSync(path.join(logDir, 'mission-12345678-driver.log'), 'last owned write before completion\\n');",
    "    fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...state, exited_at: new Date().toISOString() }));",
    "  }",
    "  process.disconnect();",
    "});",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script, root], { cwd: control, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 5000 });
  let error = null;
  let stderr = '';
  child.on('error', (value) => { error = value; });
  child.stderr.on('data', (value) => { stderr += value; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, error, stderr })));
  const message = () => new Promise((resolve, reject) => {
    child.once('message', resolve);
    closed.then((result) => reject(result.error || new Error(result.stderr || 'owned writer closed before its message')));
  });
  let released = false;
  const release = (command) => { if (!released && child.connected) { released = true; child.send(command); } };
  return { child, closed, message, release };
}

test('detached cleanup keeps the root until its owned writer finishes', async (t) => {
  const control = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-driver-cleanup-control-'));
  t.after(() => fs.rmSync(control, { recursive: true, force: true }));
  let cleanup;
  const root = workspace({ after(fn) { cleanup = fn; } }, waitForMissionDriverExit);
  const writer = ownedDriverWriter(root, control);
  try {
    const ready = await writer.message();
    assert.equal(ready.pid, writer.child.pid);
    let settled = false;
    const cleaning = Promise.resolve().then(() => cleanup());
    cleaning.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(root), true);
    assert.equal(settled, false);
    writer.release('finish');
    await cleaning;
    assert.equal(fs.existsSync(root), false);
  } finally {
    writer.release('finish');
    const result = await writer.closed;
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(result, { code: 0, signal: null, error: null, stderr: '' });
  }
});

test('detached cleanup rejects a mismatched completion and keeps its root', async (t) => {
  const control = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-driver-cleanup-control-'));
  t.after(() => fs.rmSync(control, { recursive: true, force: true }));
  let cleanup;
  const root = workspace({ after(fn) { cleanup = fn; } }, (dir) => waitForMissionDriverExit(dir, 100));
  const writer = ownedDriverWriter(root, control);
  try {
    await writer.message();
    const cleaning = Promise.resolve().then(() => cleanup()).then(() => null, (error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(root), true);
    const mismatch = writer.message();
    writer.child.send('mismatch');
    await mismatch;
    const error = await cleaning;
    assert.match(error?.message || 'cleanup resolved', /timed out waiting for the detached mission driver/);
    assert.equal(fs.existsSync(root), true);
  } finally {
    writer.release('stop');
    const result = await writer.closed;
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(result, { code: 0, signal: null, error: null, stderr: '' });
  }
});
