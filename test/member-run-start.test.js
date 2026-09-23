'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-run-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
