#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-landing-'));

function run(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tempRoot,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

try {
  fs.mkdirSync(path.join(tempRoot, 'atris'), { recursive: true });
  const runStartOutput = run([
    'mission',
    'run',
    'operator start takeoff mission',
    '--owner',
    'mission-lead',
    '--runner',
    'codex_goal',
    '--verify',
    'node -e "process.exit(0)"',
  ]);
  assert.match(runStartOutput, /^Takeoff:/m);
  assert.match(runStartOutput, /Goal: operator start takeoff mission/);
  assert.match(runStartOutput, /Done when: verifier passes and visible goal lands\./);
  assert.match(runStartOutput, /Proof: Mission state saved in \.atris\/state\/missions\.jsonl\./);
  assert.match(runStartOutput, /Check: Verifier configured: node -e "process\.exit\(0\)"/);
  assert.match(runStartOutput, /Next: Start the visible goal, then continue this mission\./);
  assert.doesNotMatch(runStartOutput, /^(Started mission|Owner|Runner|Atris goal|Codex goal):/m);
  assert.doesNotMatch(runStartOutput, /^Landing:/m);

  const runSummaryStart = JSON.parse(run([
    'mission',
    'start',
    'operator run summary mission',
    '--owner',
    'mission-lead',
    '--runner',
    'codex_goal',
    '--verify',
    'node -e "process.exit(0)"',
    '--json',
  ]));
  run([
    'mission',
    'goal',
    'ack',
    runSummaryStart.mission.id,
    '--runtime',
    'codex',
    '--status',
    'active',
    '--objective',
    runSummaryStart.mission.objective,
    '--json',
  ]);
  const runSummaryOutput = run(['mission', 'run', runSummaryStart.mission.id, '--max-ticks', '1']);
  assert.match(runSummaryOutput, /^Landing:/m);
  assert.match(runSummaryOutput, /Changed: operator run summary mission is ready for review\./);
  assert.match(runSummaryOutput, /How I checked: Verifier passed: node -e "process\.exit\(0\)"/);
  assert.match(runSummaryOutput, /Proof: Summary receipt saved at atris\/runs\/mission-/);
  assert.match(runSummaryOutput, /Next: Review the proof, then complete the mission\./);
  assert.doesNotMatch(runSummaryOutput, /^(Ran mission|  objective|  ran_ticks|  final state|  session|  summary receipt):/m);

  const start = JSON.parse(run([
    'mission',
    'start',
    'operator landing mission',
    '--owner',
    'mission-lead',
    '--verify',
    'node -e "process.exit(0)"',
    '--json',
  ]));
  const tickOutput = run(['mission', 'tick', start.mission.id, '--verify']);
  assert.match(tickOutput, /^Landing:/m);
  assert.match(tickOutput, /Changed: operator landing mission is ready for review\./);
  assert.match(tickOutput, /How I checked: Verifier passed: node -e "process\.exit\(0\)"/);
  assert.match(tickOutput, /Proof: Receipt saved at atris\/runs\/mission-/);
  assert.match(tickOutput, /Next: Review the proof, then complete the mission\./);
  assert.doesNotMatch(tickOutput, /AgentXP:/);
  assert.doesNotMatch(tickOutput, /queue AgentXP/i);

  const receiptPath = tickOutput.match(/Proof: Receipt saved at ([^.\n]+\.json)\./)?.[1];
  assert.ok(receiptPath, tickOutput);

  const output = run(['mission', 'complete', start.mission.id, '--proof', receiptPath]);

  assert.match(output, /^Landing:/m);
  assert.match(output, /Changed: operator landing mission is complete\./);
  assert.match(output, /How I checked: I checked the passing verifier receipt/);
  assert.match(output, /What I tested: Verifier passed: node -e "process\.exit\(0\)"/);
  assert.match(output, /Proof: Proof saved at atris\/runs\/mission-/);
  assert.match(output, /Next: Pick the next customer-facing move\./);
  assert.doesNotMatch(output, /AgentXP:/);
  assert.doesNotMatch(output, /queue AgentXP/i);

  console.log('MISSION LANDING PROOF');
  console.log(runStartOutput.trim());
  console.log('---');
  console.log(runSummaryOutput.trim());
  console.log('---');
  console.log(tickOutput.trim());
  console.log('---');
  console.log(output.trim());
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
