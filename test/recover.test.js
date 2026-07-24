'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { classifyRecovery } = require('../commands/recover');
const { reasonClass } = require('../lib/self-drive');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const PASSING_VERIFIER = `${process.execPath} -e "process.exit(0)"`;

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-recover-test-'));
  const git = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr || git.stdout);
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
  return dir;
}

function runCli(dir, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: dir,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function appendMission(dir, {
  id,
  status = 'paused',
  reason,
  verifier = '',
}) {
  const receiptPath = `atris/runs/mission-${id}.json`;
  const mission = {
    schema: 'atris.mission.v1',
    id,
    slug: id,
    objective: `recover ${id}`,
    owner: 'mission-lead',
    status,
    runner: 'manual',
    cadence: 'manual',
    verifier,
    always_on: false,
    task_ids: [],
    human_asks: [],
    stop_reason: reason,
    next_action: `recover from ${reason}`,
    receipt_path: receiptPath,
    created_at: '2026-07-24T05:00:00.000Z',
    updated_at: '2026-07-24T05:01:00.000Z',
  };
  fs.appendFileSync(
    path.join(dir, '.atris', 'state', 'missions.jsonl'),
    `${JSON.stringify(mission)}\n`,
  );
  fs.writeFileSync(path.join(dir, receiptPath), `${JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    at: mission.updated_at,
    mission_id: id,
    objective: mission.objective,
    owner: mission.owner,
    verifier,
    result: {
      kind: 'mission_run_summary',
      pause_reason: reason,
      landing: { next: mission.next_action },
    },
  }, null, 2)}\n`);
  return mission;
}

function latestMission(dir, id) {
  const rows = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .filter((row) => row.id === id);
  return rows.at(-1);
}

test('classification uses the shared reason normalizer for every catalog failure mode', () => {
  const cases = [
    ['max ticks reached', 'max-ticks-reached'],
    ['verifier_failed', 'verifier-failed'],
    ['repeated-error:claude-error', 'repeated-error:claude-error'],
    ['aborted', 'aborted'],
    ['aborted during claude', 'aborted-during-claude'],
    ['stuck repeating', 'stuck-repeating'],
    ['lock busy', 'lock-busy'],
    ['auth required', 'auth-required'],
    ['model unavailable', 'model-unavailable'],
    ['rate limit exceeded wall', 'rate-limit-exceeded-wall'],
  ];
  for (const [input, catalogEntry] of cases) {
    const classified = classifyRecovery(input);
    assert.equal(classified.reason, reasonClass(input));
    assert.equal(classified.catalog_entry, catalogEntry);
  }
});

test('report-only recover names the receipt and action without changing state', () => {
  const dir = makeWorkspace();
  try {
    const mission = appendMission(dir, {
      id: 'mission-report-max-ticks',
      reason: 'max-ticks-reached',
    });
    const before = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8');
    const result = runCli(dir, ['recover', mission.id, '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.report_only, true);
    assert.equal(payload.receipt_path, null);
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].catalog_entry, 'max-ticks-reached');
    assert.equal(payload.results[0].receipt_path, mission.receipt_path);
    assert.equal(payload.results[0].recovery_command, `atris recover ${mission.id} --apply`);
    assert.equal(
      fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8'),
      before,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply resumes a paused mission through mission tick and writes a recovery receipt', () => {
  const dir = makeWorkspace();
  try {
    const mission = appendMission(dir, {
      id: 'mission-resume-aborted',
      reason: 'aborted',
    });
    const result = runCli(dir, ['recover', mission.id, '--apply', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.results[0].outcome, 'recovered');
    assert.equal(latestMission(dir, mission.id).status, 'running');
    assert.ok(payload.receipt_path);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, payload.receipt_path), 'utf8'));
    assert.equal(receipt.schema, 'atris.recovery_receipt.v1');
    assert.equal(receipt.results[0].end_status, 'running');
    assert.match(receipt.results[0].mission_receipt, /^atris\/runs\/mission-/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply reruns a blocked verifier through mission tick --verify', () => {
  const dir = makeWorkspace();
  try {
    const mission = appendMission(dir, {
      id: 'mission-verifier-failed',
      status: 'blocked',
      reason: 'verifier-failed',
      verifier: PASSING_VERIFIER,
    });
    const result = runCli(dir, ['recover', mission.id, '--apply', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.results[0].outcome, 'recovered');
    const saved = latestMission(dir, mission.id);
    assert.equal(saved.status, 'ready');
    assert.equal(saved.verifier_result.passed, true);
    assert.ok(saved.receipt_path);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply leaves a verifier failure blocked when no verifier is configured', () => {
  const dir = makeWorkspace();
  try {
    const mission = appendMission(dir, {
      id: 'mission-missing-verifier',
      status: 'blocked',
      reason: 'verifier-failed',
    });
    const result = runCli(dir, ['recover', mission.id, '--apply', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.results[0].outcome, 'needs operator');
    assert.equal(payload.results[0].disposition, 'needs operator');
    assert.match(payload.results[0].happened, /no verifier command is configured/);
    assert.equal(latestMission(dir, mission.id).status, 'blocked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply clears a dead-pid tick lock but leaves the blocked mission for inspection', () => {
  const dir = makeWorkspace();
  try {
    const mission = appendMission(dir, {
      id: 'mission-stale-lock',
      status: 'blocked',
      reason: 'lock-busy',
    });
    const lockPath = path.join(dir, '.atris', 'state', `mission-${mission.id}.lock`);
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: 2147483647,
      mission_id: mission.id,
      started_at: '2026-07-24T05:00:00.000Z',
    })}\n`);
    const result = runCli(dir, ['recover', mission.id, '--apply', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    const lockResult = payload.results.find((row) => row.stale_lock);
    const missionResult = payload.results.find((row) => !row.stale_lock);
    assert.equal(lockResult.outcome, 'recovered');
    assert.equal(missionResult.outcome, 'not applied');
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(latestMission(dir, mission.id).status, 'blocked');
    assert.ok(payload.receipt_path);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply never changes human-blocking missions', () => {
  const dir = makeWorkspace();
  try {
    const reasons = ['auth-required', 'model-unavailable', 'rate-limit-exceeded-wall'];
    for (const reason of reasons) {
      appendMission(dir, { id: `mission-${reason}`, reason });
    }
    const result = runCli(dir, ['recover', '--apply', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    for (const reason of reasons) {
      const row = payload.results.find((item) => item.mission_id === `mission-${reason}`);
      assert.equal(row.outcome, 'needs operator');
      assert.equal(row.disposition, 'needs operator');
      const saved = latestMission(dir, row.mission_id);
      assert.equal(saved.status, 'paused');
      assert.equal(saved.stop_reason, reason);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
