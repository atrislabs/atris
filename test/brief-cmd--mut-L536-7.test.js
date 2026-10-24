'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleBriefAnswer } = require('../commands/brief');

test('accepting a waiting item preserves command stdout when stderr is empty', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-accept-output-'));
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousCwd = process.cwd();
  fs.writeFileSync(path.join(home, 'atris'), '#!/bin/sh\nprintf "acceptance-receipt\\n"\n', { mode: 0o755 });
  try {
    process.env.HOME = home;
    process.env.PATH = home;
    process.chdir(home);
    const reply = handleBriefAnswer(home, {
      waiting: [{ id: 'CLI-5' }],
      moves: [],
    }, 'a 1');
    assert.strictEqual(reply.message, 'acceptance-receipt');
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
