const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  missionInspectFieldValues,
  missionAckInspectValue,
  missionPingsInspectValue,
  parseFieldList,
  validateFields,
  MISSION_INSPECT_FIELDS,
  TASK_INSPECT_FIELDS,
} = require('../lib/inspect-fields');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-inspect-fields-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function appendMissionState(dir, mission) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify({
    schema: 'atris.mission.v1',
    owner: 'mission-lead',
    cadence: 'manual',
    lane: 'workspace',
    task_ids: [],
    human_asks: [],
    next_action: 'next move',
    ...mission,
  })}\n`, 'utf8');
}

test('parseFieldList and validateFields accept known mission/task fields', () => {
  assert.deepEqual(parseFieldList(' status, runner ,ack'), ['status', 'runner', 'ack']);
  assert.equal(validateFields(['status'], MISSION_INSPECT_FIELDS, 'mission'), null);
  assert.match(
    validateFields(['bogus'], MISSION_INSPECT_FIELDS, 'mission'),
    /Unknown mission inspect field: bogus/,
  );
  assert.equal(validateFields(['review'], TASK_INSPECT_FIELDS, 'task'), null);
});

test('mission inspect field helpers expose status, runner, ack, and ping counts', () => {
  const mission = {
    status: 'running',
    runner: 'codex_goal',
    model: 'gpt-test',
    native_goal_ack: {
      runtime: 'codex',
      status: 'active',
      objective: 'ship inspect',
      acknowledged_at: '2026-07-02T12:00:00.000Z',
    },
    pings: [
      { text: 'hello', consumed_at: null },
      { text: 'done', consumed_at: '2026-07-02T11:00:00.000Z' },
    ],
  };
  const values = missionInspectFieldValues(mission, ['status', 'runner', 'ack', 'pings']);
  assert.equal(values.status, 'running');
  assert.equal(values.runner, 'codex_goal (gpt-test)');
  assert.equal(missionAckInspectValue(mission).acknowledged, true);
  assert.deepEqual(missionPingsInspectValue(mission), { total: 2, pending: 1 });
  assert.equal(values.pings.pending, 1);
});

test('mission inspect CLI answers status, runner, ack, and pings without parsing full status', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'mission-inspect-cli',
      slug: 'inspect-cli',
      objective: 'Inspect fields work',
      status: 'planning',
      runner: 'claude',
      pings: [{ at: '2026-07-02T10:00:00.000Z', from: 'operator', text: 'go' }],
    });

    const status = runCli(['mission', 'inspect', 'mission-inspect-cli', '--fields', 'status'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(status.stdout.trim(), 'planning');

    const runner = runCli(['mission', 'inspect', 'mission-inspect-cli', '--fields', 'runner'], { cwd: dir });
    assert.equal(runner.status, 0, runner.stderr || runner.stdout);
    assert.equal(runner.stdout.trim(), 'claude');

    const ack = runCli(['mission', 'inspect', 'mission-inspect-cli', '--fields', 'ack'], { cwd: dir });
    assert.equal(ack.status, 0, ack.stderr || ack.stdout);
    assert.equal(ack.stdout.trim(), 'unacknowledged');

    const pings = runCli(['mission', 'inspect', 'mission-inspect-cli', '--fields', 'pings'], { cwd: dir });
    assert.equal(pings.status, 0, pings.stderr || pings.stdout);
    assert.equal(pings.stdout.trim(), '1');

    const combined = runCli([
      'mission',
      'inspect',
      'mission-inspect-cli',
      '--fields',
      'status,runner,ack,pings',
      '--json',
    ], { cwd: dir });
    assert.equal(combined.status, 0, combined.stderr || combined.stdout);
    const payload = JSON.parse(combined.stdout);
    assert.equal(payload.action, 'mission_inspect');
    assert.equal(payload.fields.status, 'planning');
    assert.equal(payload.fields.runner, 'claude');
    assert.equal(payload.fields.ack.acknowledged, false);
    assert.deepEqual(payload.fields.pings, { total: 1, pending: 1 });
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission inspect reports acknowledged native goal ack state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'mission-inspect-ack',
      slug: 'inspect-ack',
      objective: 'Ack inspect',
      status: 'running',
      runner: 'codex_goal',
      native_goal_ack: {
        runtime: 'codex',
        status: 'active',
        objective: 'Ack inspect',
        acknowledged_at: '2026-07-02T12:34:56.000Z',
      },
    });

    const ack = runCli(['mission', 'inspect', 'mission-inspect-ack', '--fields', 'ack', '--json'], { cwd: dir });
    assert.equal(ack.status, 0, ack.stderr || ack.stdout);
    const payload = JSON.parse(ack.stdout);
    assert.equal(payload.fields.ack.acknowledged, true);
    assert.equal(payload.fields.ack.status, 'active');
    assert.match(payload.fields.ack.acknowledged_at, /2026-07-02T12:34:56/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task inspect CLI returns review metadata without parsing show output', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const add = runCli(['task', 'add', 'Inspect review metadata', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const ref = JSON.parse(add.stdout).task.display_id;

    const ready = runCli([
      'task',
      'ready',
      ref,
      '--proof',
      'node --test test/inspect-fields.test.js passed',
      '--result',
      'Reviewers can inspect pending proof metadata directly so review checks save time and reduce approval risk.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr || ready.stdout);

    const inspect = runCli(['task', 'inspect', ref, '--fields', 'review', '--json'], { cwd: dir, env });
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
    const payload = JSON.parse(inspect.stdout);
    assert.equal(payload.action, 'task_inspect');
    assert.equal(payload.fields.review.approval_status, 'pending');
    assert.match(payload.fields.review.proof, /inspect-fields\.test\.js passed/);

    const text = runCli(['task', 'inspect', ref, '--fields', 'review'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr || text.stdout);
    assert.match(text.stdout, /"approval_status":"pending"/);
    assert.match(text.stdout, /inspect-fields\.test\.js passed/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission and task help document inspect commands', () => {
  const missionHelp = runCli(['mission', 'help'], { cwd: repoRoot });
  assert.equal(missionHelp.status, 0, missionHelp.stderr || missionHelp.stdout);
  assert.match(missionHelp.stdout, /atris mission inspect <id> --fields status,runner,ack,pings/);

  const taskHelp = runCli(['task', 'help'], { cwd: repoRoot });
  assert.equal(taskHelp.status, 0, taskHelp.stderr || taskHelp.stdout);
  assert.match(taskHelp.stdout, /atris task inspect <id> --fields review,status,title/);
});

test('inspectMission rejects unknown fields and missing id', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    appendMissionState(dir, {
      id: 'mission-inspect-errors',
      slug: 'inspect-errors',
      objective: 'Error paths',
      status: 'planning',
      runner: 'manual',
    });

    const unknown = runCli(['mission', 'inspect', 'mission-inspect-errors', '--fields', 'bogus'], { cwd: dir });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown mission inspect field/);

    const missing = runCli(['mission', 'inspect', '--fields', 'status'], { cwd: dir });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Usage: atris mission inspect/);
  } finally {
    cleanupTempDir(dir);
  }
});
