'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMissionRoom, writeMissionRoomReceipt } = require('../lib/mission-room');

test('receipt memory preserves clarified truth over the original request', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clarified-truth-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const at = new Date('2026-01-15T12:00:00.000Z');
    const room = buildMissionRoom('Improve customer onboarding.', { root, at });
    room.truth_snapshot = 'Customers abandon signup at the billing step.';

    writeMissionRoomReceipt(room, { root, at });

    const memory = fs.readFileSync(path.join(root, 'atris', 'thinking.md'), 'utf8');
    assert.ok(memory.includes(room.truth_snapshot));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
