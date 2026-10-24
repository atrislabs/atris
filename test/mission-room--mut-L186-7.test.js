'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMissionRoom } = require('../lib/mission-room');

test('revenue takes precedence over an ordinary topic in the proposed mission', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-topic-priority-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const room = buildMissionRoom('orchard revenue', { root });
    assert.equal(room.name.split(' ')[0], 'Revenue');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
