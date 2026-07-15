'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  listMissions,
  markMissionReviewReady,
  startMission,
} = require('../commands/mission');

function withTempRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-one-lap-mission-ready-'));
  const previous = process.cwd();
  fs.mkdirSync(path.join(root, 'atris', 'runs'), { recursive: true });
  process.chdir(root);
  try { return run(root); } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function validReceipt(missionId, taskId = 'CLI-TEST') {
  const verifier = { command: 'node --test', passed: true, status: 0, output: 'pass 1' };
  return {
    schema: 'atris.dispatch_receipt.v1',
    review_only: true,
    tasks: [taskId],
    ready: [{
      task: taskId,
      engine: 'codex',
      review_recorded: true,
      verifier_result: verifier,
    }],
    context: { source: 'one_lap', mission_id: missionId },
    result: {
      kind: 'dispatch_review_ready',
      passed: true,
      verifier_result: verifier,
      master_boundary_enforced: true,
      master_unchanged: true,
      validator_result: {
        engine: 'claude',
        executor_engine: 'codex',
        independent: true,
        passed: true,
        worktree_unchanged: true,
      },
    },
  };
}

test('mission Review gate rejects arbitrary receipts and frozen-verifier replacement', () => withTempRoot((root) => {
  const started = startMission([
    'test one-lap mission',
    '--owner', 'mission-lead',
    '--runner', 'codex',
    '--verify', 'node --test',
    '--json',
  ], { silent: true });
  const mission = started.mission;
  const receiptPath = path.join(root, 'atris', 'runs', 'dispatch-test.json');
  fs.writeFileSync(receiptPath, JSON.stringify({
    schema: 'anything.at.all',
    result: { passed: true, verifier_result: { command: 'node --test', passed: true } },
  }));
  assert.throws(() => markMissionReviewReady(mission.id, {
    verifier: 'node --test',
    receiptPath,
    taskId: 'CLI-TEST',
  }, root), /does not belong to this one-lap mission and task/);

  const receipt = validReceipt(mission.id);
  receipt.result.verifier_result.command = 'git diff --check';
  receipt.ready[0].verifier_result.command = 'git diff --check';
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.throws(() => markMissionReviewReady(mission.id, {
    verifier: 'git diff --check',
    receiptPath,
    taskId: 'CLI-TEST',
  }, root), /frozen mission verifier/);
  assert.equal(listMissions(root).find((row) => row.id === mission.id).status, 'planning');
}));

test('mission Review gate accepts only the matching fully proven one-lap receipt', () => withTempRoot((root) => {
  const started = startMission([
    'valid one-lap mission',
    '--owner', 'mission-lead',
    '--runner', 'codex',
    '--verify', 'node --test',
    '--json',
  ], { silent: true });
  const receiptPath = path.join(root, 'atris', 'runs', 'dispatch-valid.json');
  fs.writeFileSync(receiptPath, JSON.stringify(validReceipt(started.mission.id)));
  const ready = markMissionReviewReady(started.mission.id, {
    verifier: 'node --test',
    receiptPath,
    taskId: 'CLI-TEST',
    worktree: '/tmp/isolated',
  }, root);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.verifier, 'node --test');
  assert.equal(ready.receipt_path, 'atris/runs/dispatch-valid.json');
}));
