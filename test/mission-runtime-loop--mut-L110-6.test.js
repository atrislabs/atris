'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRuntimeMissionLoop } = require('../lib/mission-runtime-loop');

test('a command error without JSON is a failed mission start', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-command-error-'));
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const cliPath = path.join(root, 'cli.js');
    fs.writeFileSync(cliPath, "console.error('Unable to open mission storage: permission denied'); process.exitCode = 1;\n");
    const result = await runRuntimeMissionLoop(
      { objective: 'Repair the parser', owner: 'mission-lead', noRun: true, noRoomPreflight: true },
      { cliPath, cwd: root },
    );
    assert.equal(result.ok, false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
