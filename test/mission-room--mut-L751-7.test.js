'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMissionRoom } = require('../lib/mission-room');

test('trusted run preserves the explicitly selected task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-selected-target-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const selectedTarget = { task_id: 'task-1', ref: 'CLI-758' };
    const room = buildMissionRoom('improve customer onboarding', { root, selectedTarget, trustedRun: true });
    assert.equal(room.trusted_execution.selected_target, selectedTarget);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
