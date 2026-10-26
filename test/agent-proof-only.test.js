const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createTaskHelpFixture } = require('./helpers/task-help-fixture');
const { spawnSync } = require('node:child_process');
const { DEFAULT_TASK_RESULT_SENTENCE, withTaskReadyResult } = require('./helpers/task-result');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const AGENT_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CURSOR_AGENT',
  'DEVIN_SESSION_ID',
];

const { makeTempDir: makeFixtureDir, cleanupTempDir } = createTaskHelpFixture('atris-agent-proof-test-');
const makeTempDir = () => makeFixtureDir();

function baseEnv() {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  for (const marker of AGENT_MARKERS) delete env[marker];
  delete env.ATRIS_AGENT_PROOF_ONLY;
  return env;
}

function runCli(args, { cwd, input, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...withTaskReadyResult(args)], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...baseEnv(), HOME: cwd, ...(env || {}) },
  });
  if (result.error) throw result.error;
  return result;
}

function setupReviewTask(dir) {
  const init = runCli(['init'], { cwd: dir, input: '\n' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const created = runCli(['task', 'new', 'Guard accept from agents', '--tag', 'test'], { cwd: dir });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const id = String(created.stdout).trim().split(/\s+/)[0];
  assert.ok(id, `expected task id in output: ${created.stdout}`);
  const claimed = runCli(['task', 'claim', id, '--as', 'executor'], { cwd: dir });
  assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
  const ready = runCli(
    ['task', 'ready', id, '--proof', 'Receipt saved at atris/runs/proof.json'],
    { cwd: dir },
  );
  assert.equal(ready.status, 0, ready.stderr || ready.stdout);
  return id;
}

test('task accept is blocked when an agent env marker is present', () => {
  const dir = makeTempDir();
  try {
    const id = setupReviewTask(dir);
    for (const marker of AGENT_MARKERS) {
      const res = runCli(['task', 'accept', id], { cwd: dir, env: { [marker]: '1' } });
      assert.notEqual(res.status, 0, `${marker}: accept should fail\n${res.stdout}`);
      assert.match(
        `${res.stdout}${res.stderr}`,
        /cannot accept tasks or award XP/i,
        `${marker}: expected proof-only block`,
      );
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('ATRIS_AGENT_PROOF_ONLY=0 overrides agent env detection for human accept', () => {
  const dir = makeTempDir();
  try {
    const id = setupReviewTask(dir);
    const res = runCli(['task', 'accept', id], {
      cwd: dir,
      env: { CLAUDECODE: '1', ATRIS_AGENT_PROOF_ONLY: '0' },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, new RegExp(DEFAULT_TASK_RESULT_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('explicit ATRIS_AGENT_PROOF_ONLY=1 still blocks accept without agent markers', () => {
  const dir = makeTempDir();
  try {
    const id = setupReviewTask(dir);
    const res = runCli(['task', 'accept', id], { cwd: dir, env: { ATRIS_AGENT_PROOF_ONLY: '1' } });
    assert.notEqual(res.status, 0, `accept should fail\n${res.stdout}`);
    assert.match(`${res.stdout}${res.stderr}`, /cannot accept tasks or award XP/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task sweep cannot accept from an agent session, even with a dry-run flag', () => {
  const dir = makeTempDir();
  try {
    const id = setupReviewTask(dir);
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'proof.json'), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'agent-sweep-proof',
      result: { verifier_result: { passed: true } },
    }));
    const before = runCli(['task', 'events', id, '--json'], { cwd: dir });
    assert.equal(before.status, 0, before.stderr);
    for (const agentEnv of [...AGENT_MARKERS.map(marker => ({ [marker]: '1' })), { ATRIS_AGENT_PROOF_ONLY: '1' }]) {
      for (const flags of [[], ['--dry-run']]) {
        const res = runCli(['task', 'sweep', '--auto-accept', ...flags, '--json'], { cwd: dir, env: agentEnv });
        assert.notEqual(res.status, 0, `sweep should fail: ${JSON.stringify(agentEnv)} ${res.stdout}`);
        assert.equal(JSON.parse(res.stdout).reason, 'agent_proof_only_human_accept_blocked');
        assert.match(`${res.stdout}${res.stderr}`, /cannot accept tasks or award XP/i);
      }
    }
    const after = runCli(['task', 'events', id, '--json'], { cwd: dir });
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(JSON.parse(after.stdout), JSON.parse(before.stdout));
    const shown = runCli(['task', 'show', id, '--json'], { cwd: dir });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).status, 'review');

    // The same receipt is actually eligible when the human override is set.
    const human = runCli(['task', 'sweep', '--auto-accept', '--json'], {
      cwd: dir, env: { CLAUDECODE: '1', ATRIS_AGENT_PROOF_ONLY: '0' },
    });
    assert.equal(human.status, 0, human.stderr);
    assert.equal(JSON.parse(human.stdout).accepted, 1, human.stdout);
  } finally {
    cleanupTempDir(dir);
  }
});
