'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRuntimeMissionLoop } = require('../lib/mission-runtime-loop');

test('a command timeout signals its process group', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-interrupt-'));
  const savedHome = process.env.HOME;
  const savedKill = process.kill;
  const targets = [];
  process.env.HOME = root;
  process.kill = function (pid, signal) {
    targets.push(pid);
    return savedKill.call(process, pid, signal);
  };
  try {
    const cliPath = path.join(root, 'cli.js');
    fs.writeFileSync(cliPath, "console.log(JSON.stringify({ ok: true, mission: { id: 'm-1', status: 'active' } }));\n");
    // Advance the command timer after the synchronous launch has finished.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await runRuntimeMissionLoop(
      { objective: 'Repair the parser', maxWallSeconds: 60, noRoomPreflight: true },
      { cliPath, cwd: root, onProgress() {
        queueMicrotask(() => t.mock.timers.tick(1_000_000_000));
      } },
    );
    assert.equal(targets.some(pid => pid < 0), true);
  } finally {
    process.kill = savedKill;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
