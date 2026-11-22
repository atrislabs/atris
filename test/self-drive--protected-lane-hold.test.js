'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleMissionBlocker, isHumanBlockingReason } = require('../lib/self-drive');
const { classifyRecovery } = require('../commands/recover');

// A mission paused in a protected lane waits for a person. Self-drive used to
// file "get X moving again: protected lane security" and hand it to an agent.
test('a protected-lane pause files no blocker task and dispatches nothing', () => {
  for (const reason of ['protected-lane-security', 'protected-lane-billing', 'protected-lane-declared', 'protected-lane-review']) {
    const result = handleMissionBlocker({
      mission: { id: 'mission-replay', objective: 'As Replay Lead, find the saved earlier replay', status: 'paused' },
      stopReason: reason,
      workspaceRoot: process.cwd(),
    }, {
      taskDb: {
        open: () => { throw new Error('task db must not be opened for a human hold'); },
      },
      resolveEngineForRole: () => { throw new Error('no engine may be picked'); },
    });
    assert.deepEqual(result, { taskId: null, dispatched: false, engine: null, reason: 'human-blocking' }, reason);
  }
});

test('protected-lane reasons read as human-blocking everywhere, other reasons do not', () => {
  assert.equal(isHumanBlockingReason('protected-lane-security'), true);
  assert.equal(isHumanBlockingReason('auth-required'), true);
  assert.equal(isHumanBlockingReason('repeated-error:runner-failed'), false);
  assert.equal(isHumanBlockingReason('lane-security'), false);
  assert.equal(isHumanBlockingReason(undefined), false);
  assert.equal(classifyRecovery('protected-lane-security').human_blocking, true);
  assert.equal(classifyRecovery('protected-lane-security').apply, null);
});
