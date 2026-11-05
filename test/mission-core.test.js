'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const missionCore = require('../lib/mission-core');
const missionCmd = require('../commands/mission');

test('lib/mission-core exports shared constants, slug/id helpers, and route validators', () => {
  assert.ok(missionCore.VALID_STATUSES.has('running'));
  assert.ok(missionCore.TERMINAL_STATUSES.has('complete'));
  assert.equal(missionCore.slugify('Cut 1,500+ Lines From Commands!'), 'cut-1-500-lines-from-commands');
  assert.match(missionCore.missionId('Ship modular helpers'), /^mission-\d{4}-\d{2}-\d{2}-ship-modular-helpers-[0-9a-f]{8}$/);

  const validProposal = {
    legs: [
      {
        id: 'leg-1',
        objective: 'Extract task helpers',
        verifier: 'node --test test/task-core.test.js',
        stop_condition: 'tests pass',
        files: ['lib/task-core.js'],
      },
    ],
  };
  assert.equal(missionCore.validateMissionRouteProposal(validProposal), null);
  assert.equal(missionCore.validateMissionRouteProposal({ legs: [] }).code, 'missing_legs');
});

test('lib/mission-core runner selection, verifier lint, and flag helpers work deterministically', () => {
  assert.deepEqual(missionCore.resolveMissionRunnerSelection('auto'), {
    requested: 'auto',
    runner: 'auto',
    engine: null,
    kind: 'auto',
  });
  assert.equal(missionCore.lintMissionVerifier('node --test test/mission-core.test.js'), null);
  assert.match(missionCore.lintMissionVerifier('test 5 -ge 3'), /shell substitution expanded/);
  assert.deepEqual(
    missionCore.stripKnownFlags(['--json', 'mission-123', '--owner', 'builder'], ['--owner'], ['--json']),
    ['mission-123'],
  );
});

test('lib/mission-core member log and handoff helpers write bounded workspace files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-core-'));
  try {
    const navigatorDir = path.join(tmp, 'atris', 'team', 'navigator');
    const executorDir = path.join(tmp, 'atris', 'team', 'executor');
    fs.mkdirSync(navigatorDir, { recursive: true });
    fs.mkdirSync(executorDir, { recursive: true });
    fs.writeFileSync(path.join(navigatorDir, 'MEMBER.md'), '# Navigator\n', 'utf8');
    fs.writeFileSync(path.join(executorDir, 'MEMBER.md'), '# Executor\n', 'utf8');

    const logPath = missionCore.appendMemberLog('navigator', 'tick passed', { mission: 'M1' }, tmp);
    assert.ok(logPath && fs.existsSync(logPath));
    assert.match(fs.readFileSync(logPath, 'utf8'), /tick passed/);

    const handoff = missionCore.recordMemberHandoff('navigator', 'executor', 'Ready to build slice', tmp);
    assert.ok(handoff && handoff.id);
    assert.equal(handoff.to, 'executor');
    const closed = missionCore.closeMemberHandoffsForReceiver('executor', tmp);
    assert.equal(closed, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('commands/mission.js re-exports compatible public surface alongside lib/mission-core.js', () => {
  assert.equal(missionCmd.resolveMissionRunnerSelection, missionCore.resolveMissionRunnerSelection);
  assert.equal(missionCmd.resolveMissionTickRunner, missionCore.resolveMissionTickRunner);
  assert.equal(missionCmd.resolveMissionTickRunnerModel, missionCore.resolveMissionTickRunnerModel);
  assert.equal(missionCmd.crystallizeMemberSkillLesson, missionCore.crystallizeMemberSkillLesson);
  assert.equal(missionCmd.recordMemberHandoff, missionCore.recordMemberHandoff);
  assert.equal(missionCmd.businessIdForAtris2Mission, missionCore.businessIdForAtris2Mission);
  assert.equal(typeof missionCmd.missionCommand, 'function');
});
