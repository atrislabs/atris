'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { roundLimitEnding } = require('../commands/mission');
const source = fs.readFileSync(path.join(__dirname, '../commands/mission.js'), 'utf8');
const start = source.indexOf('function completeMissionRunPhase(context) {');
const completion = source.slice(start, source.indexOf('\nasync function runMission(args)', start));

// Execute the actual completion function, replacing only external storage,
// rendering and goal-controller boundaries. No mission/model jobs are launched.
function complete({ status = 'running', ticks = 2, elapsed = 120, budget = 600 } = {}) {
  const capture = { saves: 0, receipts: [], events: [], released: 0 };
  const namespace = {
    Date, process, roundLimitEnding,
    saveMission() { capture.saves++; throw Error('completion must not mutate mission state'); },
    appendEvent(type) { capture.events.push(type); },
    printJsonOrText(json, lines) { capture.json = json; capture.lines = lines; },
    releaseMissionLock() { capture.released++; },
    writeReceipt(mission, result) { capture.receipts.push({ mission, result }); return 'fixture-receipt.json'; },
    worktreeReceipt: () => ({}), gitWorktreeSnapshot: () => ({}),
    missionRunChangedText: () => 'fixture change', missionRunTimelineCommand: () => 'timeline',
    missionRunExportCommand: () => 'export', missionRunPrunePreviewCommand: () => 'prune',
    missionRunCreatedNextLine: () => 'keep working for remaining promised time',
    missionHumanReasonText: () => '', refreshAtrisGoalController: () => null,
    refreshCodexGoalController: () => null,
    missionRunSummaryLines: () => ['Landing:', '  Next: keep working for remaining promised time'],
  };
  vm.createContext(namespace);
  vm.runInContext(completion, namespace);
  const mission = { id: 'fixture-mission', status, budget_contract: { requested_seconds: budget } };
  namespace.completeMissionRunPhase({ mission, cwd: '/unused-fixture', asJson: true,
    runtimeView: value => value, frozen: {}, effectiveMaxTicks: 2,
    startedAt: Date.now() - elapsed * 1000, pauseReason: null,
    ticks: Array.from({ length: ticks }, () => ({ status: 'ran' })), ranTicks: ticks });
  return capture;
}

test('round-limit receipt records invocation ending without changing resumable mission state', () => {
  const got = complete();
  const { mission, result } = got.receipts[0];
  assert.equal(got.saves, 0);
  assert.equal(mission.status, 'running');
  assert.equal(got.json.mission.status, 'running');
  assert.equal(result.run_exit_reason, 'max-ticks-reached');
  assert.equal(result.early_stop.rounds, 2);
  assert.equal(result.early_stop.minutes_left, 8);
  assert.equal(result.early_stop, got.json.early_stop);
  assert.match(result.landing.next, /invocation ended.*state is unchanged/);
  assert.ok(got.lines.includes(`  Next: ${result.landing.next}`));
  assert.ok(got.lines.includes(`  ${result.early_stop.line}`));
  assert.equal(got.lines.some(line => line.includes('keep working for remaining')), false);
  assert.deepEqual(got.events, ['mission_run_round_limit']);
  assert.equal(got.released, 1);
});

test('completed and non-early invocations retain existing next action and state', () => {
  for (const options of [{ status: 'complete' }, { ticks: 1 }, { elapsed: 580 }]) {
    const got = complete(options);
    const receipt = got.receipts[0].result;
    assert.equal(receipt.early_stop, null);
    assert.equal(got.json.early_stop, null);
    assert.equal(got.saves, 0);
    assert.equal(got.json.mission.status, options.status || 'running');
    assert.equal(receipt.landing.next, 'keep working for remaining promised time');
    assert.deepEqual(got.lines, ['Landing:', '  Next: keep working for remaining promised time']);
    assert.deepEqual(got.events, []);
  }
});
