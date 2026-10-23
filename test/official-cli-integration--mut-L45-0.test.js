const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficialCliCommand } = require('../lib/official-cli-integration');

test('auth reports a failed configured authentication check', () => {
  const command = createOfficialCliCommand({
    name: 'sample',
    binary: process.execPath,
    versionArgs: ['-e', 'process.exit(0)'],
    authArgs: ['-e', 'process.exit(1)'],
    installHint: 'install sample locally',
    loginHint: 'sample login',
    commands: [],
  });
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  let result;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  try {
    result = command(['auth']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepStrictEqual({ result, stdout, stderr }, {
    result: 1,
    stdout: [],
    stderr: ['auth: failed', 'login: sample login'],
  });
});
