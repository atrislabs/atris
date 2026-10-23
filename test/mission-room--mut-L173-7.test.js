'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMissionRoom } = require('../lib/mission-room');

test('omits the approval verb when naming an approved budget mission', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-name-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const room = buildMissionRoom('get the budget approved', { root });
    assert.doesNotMatch(room.name, /\bapproved\b/i);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
