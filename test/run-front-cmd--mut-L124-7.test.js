const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
const { runMissionFront } = require('../commands/run-front');

test('runMissionFront forwards an explicit cadence to the mission launch', async (t) => {
  const launches = [];
  // Stop at the process boundary: run the real argument builder, but never
  // start a mission, write state, contact a service, or invoke an engine.
  t.mock.method(childProcess, 'spawnSync', (executable, args) => {
    launches.push({ executable, args });
    return {
      status: 1,
      stdout: JSON.stringify({ ok: false, error: 'launch intentionally stopped' }),
      stderr: '',
    };
  });
  const output = [];
  t.mock.method(console, 'log', (line) => output.push(line));

  const status = await runMissionFront([
    'Check cadence forwarding', '--owner', 'test-owner', '--cadence', '17m',
  ]);

  assert.deepEqual(launches, [{
    executable: process.execPath,
    args: [
      path.join(__dirname, '..', 'bin', 'atris.js'),
      'mission', 'run', 'Check cadence forwarding',
      '--runner', 'atris2', '--owner', 'test-owner', '--json',
      '--cadence', '17m',
    ],
  }]);
  assert.equal(status, 1);
  assert.deepEqual(output, [
    'Atris mission started\nGoal: ?\nMission: ? - ? - atris2\n' +
      'Atris mission pursued\nAchieved: no\nBlocked: launch intentionally stopped',
  ]);
});
