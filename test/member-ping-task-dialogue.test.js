const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ping-dialogue-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function baseEnv(dir) {
  return { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
}

function claimedTaskId(dir, env, title, owner) {
  const added = runCli(['task', 'add', title, '--json'], { cwd: dir, env });
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const taskId = JSON.parse(added.stdout).task_id;
  const claimed = runCli(['task', 'claim', taskId, '--as', owner, '--json'], { cwd: dir, env });
  assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
  return taskId;
}

function taskDialogue(dir, env, taskId) {
  const shown = runCli(['task', 'show', taskId, '--json'], { cwd: dir, env });
  assert.equal(shown.status, 0, shown.stderr || shown.stdout);
  return JSON.parse(shown.stdout).messages || [];
}

test('member ping reaches the claimed task dialogue when no mission is ticking', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const env = baseEnv(dir);
    assert.equal(runCli(['member', 'create', 'growth'], { cwd: dir, env }).status, 0);
    const taskId = claimedTaskId(dir, env, 'ship the pricing page', 'growth');

    const ping = runCli(['member', 'ping', 'growth', 'lead with the annual plan', '--from', 'keshav'], { cwd: dir, env });
    assert.equal(ping.status, 0, ping.stderr || ping.stdout);
    assert.match(ping.stdout, /dialogue/);
    assert.doesNotMatch(ping.stdout, /unread/);

    const messages = taskDialogue(dir, env, taskId);
    const delivered = messages.find((m) => /lead with the annual plan/.test(m.content || ''));
    assert.ok(delivered, `ping missing from task dialogue: ${JSON.stringify(messages)}`);
    assert.equal(delivered.actor, 'keshav');
    // --from must name the sender, not leak into the message text
    assert.doesNotMatch(delivered.content, /keshav/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member ping delivers on both lanes: live mission and claimed task dialogue', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const env = baseEnv(dir);
    assert.equal(runCli(['member', 'create', 'growth'], { cwd: dir, env }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      "echo '{\"type\":\"result\",\"is_error\":false,\"result\":\"did work\"}'",
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const missionEnv = { ...env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'always-on growth loop',
      '--owner', 'growth',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--json',
    ], { cwd: dir, env: missionEnv });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const taskId = claimedTaskId(dir, env, 'ship the pricing page', 'growth');

    const ping = runCli(['member', 'ping', 'growth', 'lead with the annual plan', '--json'], { cwd: dir, env: missionEnv });
    assert.equal(ping.status, 0, ping.stderr || ping.stdout);
    const payload = JSON.parse(ping.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.mission_id, mission.id);
    assert.equal(payload.pending_pings, 1);
    assert.equal(payload.task_id, taskId);

    // mission lane: the persisted mission record carries the unconsumed ping
    const records = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((m) => m.id === mission.id);
    const latest = records[records.length - 1];
    assert.ok((latest.pings || []).some((p) => p.text === 'lead with the annual plan' && !p.consumed_at));

    // task lane: the claimed task dialogue carries the same note
    const messages = taskDialogue(dir, env, taskId);
    assert.ok(messages.some((m) => /lead with the annual plan/.test(m.content || '')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('member ping still errors when the member has no mission and no claimed task', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const env = baseEnv(dir);
    assert.equal(runCli(['member', 'create', 'growth'], { cwd: dir, env }).status, 0);

    const ping = runCli(['member', 'ping', 'growth', 'anyone home'], { cwd: dir, env });
    assert.equal(ping.status, 1);
    assert.match(ping.stderr, /no live mission or claimed task/);
  } finally {
    cleanupTempDir(dir);
  }
});
