'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { autopilotFront, writeState } = require('../commands/autopilot-front');

test('a refused term signal is not reported as a stopped autopilot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autopilot-front-mut-'));
  const previous = process.cwd();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000000)'], {
    stdio: 'ignore',
  });
  child.unref();
  const origKill = process.kill;
  const origLog = console.log;
  const logs = [];
  const termSignals = [];
  try {
    process.chdir(dir);
    writeState(dir, {
      pid: child.pid,
      started_at: '2020-01-01T00:00:00.000Z',
      legs: 1,
      current_leg: 'sleeper',
    });
    process.kill = function (pid, signal) {
      if (signal === 'SIGTERM') {
        termSignals.push(pid);
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      }
      return origKill.call(process, pid, signal);
    };
    console.log = (...parts) => {
      logs.push(parts.map(String).join(' '));
    };
    const code = await autopilotFront(['stop']);
    assert.equal(code, 0);
    assert.deepEqual(termSignals, [child.pid]);
    assert.deepEqual(logs, [
      'No live autopilot process; stop marker written so the next start clears it.',
    ]);
  } finally {
    process.kill = origKill;
    console.log = origLog;
    try { process.chdir(previous); } catch { /* already gone */ }
    try { origKill.call(process, child.pid, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
