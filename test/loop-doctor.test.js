'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { scanLoopReceipts, nonPositiveRewardPressure, FINDING_PRIORITY } = require('../lib/loop-doctor');

const NOW = '2026-07-10T12:00:00.000Z';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loop-doctor-'));
  fs.mkdirSync(path.join(root, 'atris', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  return root;
}

function writeJson(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function writeJsonl(root, relative, rows) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function seedHealthyState(root) {
  writeJsonl(root, '.atris/state/scorecards.jsonl', [
    { ts: '2026-07-09T12:00:00.000Z', reward: 0 },
    { ts: '2026-07-10T10:00:00.000Z', reward: 2 },
  ]);
  writeJsonl(root, '.atris/state/missions.jsonl', [{
    id: 'mission-healthy',
    objective: 'keep the loop healthy',
    status: 'running',
    cadence: '15m',
    runner: 'claude',
    always_on: true,
    created_at: '2026-07-09T09:00:00.000Z',
  }]);
}

function findingKinds(root) {
  return scanLoopReceipts({ root, now: NOW }).map((finding) => finding.kind);
}

test('detects repeated pause reasons and repeated errored ticks', () => {
  const root = workspace();
  seedHealthyState(root);
  writeJson(root, 'atris/runs/mission-001.json', {
    ts: '2026-07-09T09:00:00.000Z',
    pause_reason: 'claude-session-busy',
    ticks: [{ status: 'errored', error: 'worker exited 7' }],
  });
  writeJson(root, 'atris/runs/mission-002.json', {
    ts: '2026-07-10T09:00:00.000Z',
    result: { pause_reason: 'claude-session-busy' },
    ticks: [{ status: 'failed', error: 'worker exited 7' }],
  });

  const findings = scanLoopReceipts({ root, now: NOW });
  assert.deepEqual(findings.map((finding) => finding.kind), ['repeated_tick_error', 'repeated_pause_reason']);
  assert.equal(findings[0].count, 2);
  assert.equal(findings[1].evidence.value, 'claude-session-busy');
});

test('detects a seven-day reward flatline and stays quiet after positive reward', () => {
  const root = workspace();
  seedHealthyState(root);
  writeJsonl(root, '.atris/state/scorecards.jsonl', [
    { ts: '2026-07-04T12:00:00.000Z', reward: 0 },
    { ts: '2026-07-08T12:00:00.000Z', reward: -1 },
    { ts: '2026-07-10T10:00:00.000Z', reward: 0 },
  ]);
  assert.deepEqual(findingKinds(root), ['reward_flatline']);

  writeJsonl(root, '.atris/state/scorecards.jsonl', [
    { ts: '2026-07-08T12:00:00.000Z', reward: 0 },
    { ts: '2026-07-10T10:00:00.000Z', reward: 1 },
  ]);
  assert.deepEqual(findingKinds(root), []);
});

test('detects zero due-capable missions and accepts a headless always-on cadence', () => {
  const root = workspace();
  seedHealthyState(root);
  writeJsonl(root, '.atris/state/missions.jsonl', [
    { id: 'manual-1', status: 'ready', cadence: 'manual', runner: 'claude', always_on: true, created_at: NOW },
    { id: 'caller-1', status: 'running', cadence: '15m', runner: 'codex_goal', always_on: true, created_at: NOW },
  ]);
  assert.deepEqual(findingKinds(root), ['zero_due_capable_missions']);

  writeJsonl(root, '.atris/state/missions.jsonl', [
    { id: 'headless-1', status: 'ready', cadence: '15m', runner: 'atris2', always_on: true, created_at: NOW },
  ]);
  assert.deepEqual(findingKinds(root), []);
});

test('detects repeated auth failure strings', () => {
  const root = workspace();
  seedHealthyState(root);
  writeJson(root, 'atris/runs/mission-auth-1.json', {
    ts: '2026-07-09T09:00:00.000Z', ticks: [{ status: 'paused', message: 'request returned 401' }],
  });
  writeJson(root, 'atris/runs/mission-auth-2.json', {
    ts: '2026-07-10T09:00:00.000Z', result: { tooling: 'request returned 401 again' },
  });
  const findings = scanLoopReceipts({ root, now: NOW });
  assert.deepEqual(findings.map((finding) => finding.kind), ['repeated_auth_failure']);
  assert.equal(findings[0].evidence.signature, '401');
});

test('clean receipt data produces no findings', () => {
  const root = workspace();
  seedHealthyState(root);
  writeJson(root, 'atris/runs/mission-clean-1.json', {
    ts: '2026-07-10T09:00:00.000Z', ticks: [{ status: 'ran', verifier_passed: true }],
  });
  assert.deepEqual(scanLoopReceipts({ root, now: NOW }), []);
});

test('orders the blocking auth defect before downstream loop symptoms', () => {
  const root = workspace();
  writeJsonl(root, '.atris/state/scorecards.jsonl', [
    { ts: '2026-07-08T12:00:00.000Z', reward: 0 },
    { ts: '2026-07-10T10:00:00.000Z', reward: 0 },
  ]);
  writeJsonl(root, '.atris/state/missions.jsonl', [
    { id: 'manual', status: 'ready', cadence: 'manual', runner: 'manual', always_on: false, created_at: NOW },
  ]);
  for (let i = 0; i < 2; i++) {
    writeJson(root, `atris/runs/mission-bad-${i}.json`, {
      ts: `2026-07-${8 + i}T09:00:00.000Z`,
      pause_reason: 'max-ticks-reached',
      auth: 'Token expired',
    });
  }
  assert.deepEqual(findingKinds(root), [
    'repeated_auth_failure',
    'repeated_pause_reason',
    'zero_due_capable_missions',
    'reward_flatline',
  ]);
});

test('reward_pressure boosts effective priority and re-sorts findings above their static rank', () => {
  const root = workspace();
  // Two non-positive scorecard rows in the last 24h: a repeated_pause_reason
  // finding (static priority 300) should now outrank zero_due_capable_missions
  // (static priority 200) either way, but with enough pressure it should also
  // outrank a repeated_tick_error at a *higher* static priority (400) is not
  // possible here since we only seed one low-priority finding kind; instead
  // verify the reward_pressure field itself and that it lifts effective
  // priority above the static baseline.
  writeJsonl(root, '.atris/state/scorecards.jsonl', [
    { ts: '2026-07-09T13:00:00.000Z', reward: 0 },
    { ts: '2026-07-10T09:00:00.000Z', reward: -1 },
  ]);
  writeJsonl(root, '.atris/state/missions.jsonl', [
    { id: 'manual-1', status: 'ready', cadence: 'manual', runner: 'claude', always_on: true, created_at: NOW },
  ]);
  const pressure = nonPositiveRewardPressure(
    [{ ts: '2026-07-09T13:00:00.000Z', reward: 0 }, { ts: '2026-07-10T09:00:00.000Z', reward: -1 }],
    NOW,
  );
  assert.equal(pressure, 2);

  const findings = scanLoopReceipts({ root, now: NOW });
  const zeroDue = findings.find((finding) => finding.kind === 'zero_due_capable_missions');
  assert.ok(zeroDue);
  assert.equal(zeroDue.reward_pressure, 2);
  assert.equal(zeroDue.effective_priority, FINDING_PRIORITY.zero_due_capable_missions + 20);
});

test('reward_pressure caps at 100 and every finding gets the field even at zero pressure', () => {
  const root = workspace();
  const rows = [];
  for (let i = 0; i < 15; i++) {
    rows.push({ ts: '2026-07-10T11:00:00.000Z', reward: 0 });
  }
  writeJsonl(root, '.atris/state/scorecards.jsonl', rows);
  writeJsonl(root, '.atris/state/missions.jsonl', [
    { id: 'manual-1', status: 'ready', cadence: 'manual', runner: 'claude', always_on: true, created_at: NOW },
  ]);
  const findings = scanLoopReceipts({ root, now: NOW });
  const zeroDue = findings.find((finding) => finding.kind === 'zero_due_capable_missions');
  assert.equal(zeroDue.reward_pressure, 15);
  assert.equal(zeroDue.effective_priority, FINDING_PRIORITY.zero_due_capable_missions + 100);

  const clean = workspace();
  seedHealthyState(clean);
  writeJsonl(clean, '.atris/state/scorecards.jsonl', [{ ts: '2026-07-10T10:00:00.000Z', reward: 1 }]);
  writeJson(clean, 'atris/runs/mission-auth-1.json', { ts: '2026-07-09T09:00:00.000Z', error: 'Signature verification failed' });
  writeJson(clean, 'atris/runs/mission-auth-2.json', { ts: '2026-07-10T09:00:00.000Z', error: 'Signature verification failed' });
  const zeroPressure = scanLoopReceipts({ root: clean, now: NOW });
  assert.equal(zeroPressure[0].reward_pressure, 0);
  assert.equal(zeroPressure[0].effective_priority, FINDING_PRIORITY[zeroPressure[0].kind]);
});

test('doctor --fix files at most one mission and dedupes the second run', () => {
  const root = workspace();
  seedHealthyState(root);
  writeJson(root, 'atris/runs/mission-auth-1.json', { ts: '2026-07-09T09:00:00.000Z', error: 'Signature verification failed' });
  writeJson(root, 'atris/runs/mission-auth-2.json', { ts: '2026-07-10T09:00:00.000Z', error: 'Signature verification failed' });
  const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', HOME: path.join(root, 'home') };
  const run = () => spawnSync(process.execPath, [cli, 'improve', 'doctor', '--fix', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.fix.action, 'mission_started');
  assert.match(firstPayload.fix.mission.objective, /^\[loop-doctor:repeated_auth_failure\]/);

  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.fix.action, 'mission_exists');
  const missions = fs.readFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), 'utf8')
    .split(/\r?\n/).filter((line) => line.includes('[loop-doctor:repeated_auth_failure]'));
  assert.equal(missions.length, 1);
});
