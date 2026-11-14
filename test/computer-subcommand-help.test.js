const test = require('node:test');
const assert = require('node:assert/strict');

// Fail immediately if help tries to read credentials or contact the cloud.
const auth = require('../utils/auth');
const api = require('../utils/api');
auth.loadCredentials = () => { throw new Error('unexpected login lookup'); };
api.apiRequestJson = () => { throw new Error('unexpected network call'); };
const { runComputer } = require('../commands/computer');

test('exec and chat help never start a cloud run', async () => {
  const originalLog = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  try {
    for (const subcommand of ['exec', 'chat']) {
      for (const flag of ['--help', '-h']) {
        output.length = 0;
        await runComputer([subcommand, 'task', flag]);
        assert.match(output.join('\n'), new RegExp(`Usage: atris computer ${subcommand}`));
      }
    }
  } finally {
    console.log = originalLog;
  }
});
