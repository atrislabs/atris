'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('zero hours falls back to the default spoken duration', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spoken-hours-zero-'));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const { spokenHours } = require('../commands/spaceship');
    assert.equal(spokenHours('0'), '4 hours');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
