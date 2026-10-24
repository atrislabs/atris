'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMissionRoom } = require('../lib/mission-room');

test('a runway request without proof keeps its own mission topic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runway-topic-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const room = buildMissionRoom('reduce runway', {
      root,
      at: new Date('2026-10-23T12:00:00.000Z'),
    });
    assert.equal(/cash/i.test(room.name), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
