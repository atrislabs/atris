'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('bare loop home does not suggest correcting a stray start flag', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-home-hint-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  try {
    const { routeLoop, renderLoopHome } = require('../commands/loop-front');
    const output = renderLoopHome(routeLoop([]), []);
    assert.doesNotMatch(output, /did you mean/i,
      'opening the loop home without flags must not show a flag correction');
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
