const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('command fixtures ignore inherited runner commands', () => {
  const env = { ...process.env };
  // Run an independent test process, rather than inheriting the worker role.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-name-pattern=member run --minutes scales max-ticks',
    path.join(__dirname, 'commands.test.js'),
  ], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...env,
      ATRIS_RUNNER_COMMAND_TEMPLATE: 'node -e "process.exit(1)"',
      ATRIS_CLAUDE_COMMAND_TEMPLATE: 'node -e "process.exit(1)"',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pass 1/);
});
