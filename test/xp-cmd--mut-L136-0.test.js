'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('renders an earned contribution marker in the calendar', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-xp-calendar-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const originalWrite = process.stdout.write;
  let output = '';
  try {
    process.env.HOME = home;
    process.chdir(home);
    const { render } = require('../commands/xp');
    process.stdout.write = (chunk, encoding, callback) => {
      output += String(chunk);
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return true;
    };
    render({
      schema: 'atris.career_xp_projection.v1',
      total_xp: 7,
      contribution_graph: {
        window_days: 1,
        total_xp: 7,
        active_days: 1,
        days: [{ date: '2020-02-03', xp: 7, total_xp: 7, intensity: 4 }],
      },
    });
    assert.match(output, /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s*#/m);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
