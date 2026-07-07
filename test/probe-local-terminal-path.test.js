const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

// Third occurrence of the same environment bug on 2026-07-07: cron/launchd
// PATHs lack node, so worker-sent `node ...` commands failed inside
// runLocalTerminal and blocked the linguist's always-on mission for days.
// The executor must find node even when the parent PATH does not carry it.

const { runLocalTerminal } = require('../commands/probe');

test('runLocalTerminal finds node without node on the parent PATH', async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    const result = await runLocalTerminal('node -e "process.stdout.write(process.version)"', os.tmpdir());
    assert.equal(result.exit_code, 0, result.stderr);
    assert.match(result.stdout, /^v\d+/);
  } finally {
    process.env.PATH = savedPath;
  }
});
