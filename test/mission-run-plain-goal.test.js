'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/atris.js');
const objective = 'write a checked result for this workspace';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plain-goal-'));
  fs.mkdirSync(path.join(root, 'atris/team/mission-lead'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris/team/mission-lead/MEMBER.md'), '# Mission Lead\n');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  git(['add', 'atris']);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline']);
  // A real executable at the worker boundary writes the deliverable. The CLI,
  // child process, disk state, verifier and receipts all run without mocks.
  const worker = path.join(root, 'worker');
  fs.writeFileSync(worker, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--output-format --permission-mode --session-id --resume --include-partial-messages"; exit 0; fi\nprintf "checked result\\n" > result.txt\necho \'{"type":"result","is_error":false,"result":"saved result.txt"}\'\n');
  fs.chmodSync(worker, 0o755);
  return { root, worker };
}

function run(root, worker, args = [], envOverrides = {}) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_CALLER_RUNTIME: 'terminal', ATRIS_CLAUDE_BIN: worker };
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND', 'ATRIS_CLAUDE_COMMAND', 'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_COMMAND_TEMPLATE']) delete env[name];
  env.ATRIS_RUNNER_BIN = worker;
  const check = args.includes('--verify') ? [] : ['--verify', 'test -s result.txt'];
  return spawnSync(process.execPath, [cli, 'mission', 'run', objective, ...check, '--max-ticks', '1', '--max-wall', '30', '--json', ...args], {
    cwd: root, encoding: 'utf8', timeout: 40000, env: { ...env, ...envOverrides },
  });
}

function withWorkspace(fn) {
  const fixture = workspace();
  try { fn(fixture); } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
}

test('a plain terminal goal runs a worker and its frozen check in one command', () => withWorkspace(({ root, worker }) => {
  const result = run(root, worker);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, 'mission_run');
  assert.equal(payload.mission.runner, 'claude');
  assert.equal(payload.ran_ticks, 1);
  assert.equal(payload.ticks[0].verifier_passed, true);
  assert.equal(payload.mission.status, 'ready');
  assert.equal(fs.readFileSync(path.join(root, 'result.txt'), 'utf8'), 'checked result\n');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, payload.summary_receipt), 'utf8'));
  assert.equal(receipt.result.frozen.verifier, 'test -s result.txt');
  assert.equal(receipt.result.ticks[0].verifier_passed, true);
}));

test('an explicit caller goal retains the native goal handoff without launching a worker', () => withWorkspace(({ root, worker }) => {
  const result = run(root, worker, ['--runner', 'codex_goal']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, 'mission_run_started');
  assert.equal(payload.requires_native_goal_start, true);
  assert.equal(payload.native_goal_action.tool, 'create_goal');
  assert.equal(fs.existsSync(path.join(root, 'result.txt')), false);
}));

test('a live Codex caller still gets its native goal without a nested worker', () => withWorkspace(({ root, worker }) => {
  const result = run(root, worker, [], { ATRIS_CALLER_RUNTIME: 'codex', CODEX_THREAD_ID: 'test-thread' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mission.runner, 'codex_goal');
  assert.equal(payload.requires_native_goal_start, true);
  assert.equal(fs.existsSync(path.join(root, 'result.txt')), false);
}));

test('a new objective also executes an explicitly selected built-in worker', () => withWorkspace(({ root, worker }) => {
  const result = run(root, worker, ['--runner', 'drill', '--verify', 'test -s .atris/state/drill-runner-touch.txt']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, 'mission_run');
  assert.equal(payload.ran_ticks, 1);
  assert.equal(payload.mission.runner, 'drill');
  assert.equal(payload.ticks[0].verifier_passed, true);
  assert.equal(fs.existsSync(path.join(root, '.atris/state/drill-runner-touch.txt')), true);
}));
