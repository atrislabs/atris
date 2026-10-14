'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const cli = path.resolve(__dirname, '../bin/atris.js');

for (const [command, expected] of [
  ['taks', ['task']],
  ['context', ['activate', 'status']],
  ['zzzzzzzzzzzz', []],
]) {
  test(`JSON error suggests corrections for ${command} without creating work`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-command-correction-'));
    try {
      const result = spawnSync(process.execPath, [cli, command, 'list', '--json'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 10000,
        env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_INTERACTIVE: '1', ATRIS_NONINTERACTIVE: '1' },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 2, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.equal(body.ok, false);
      assert.equal(body.command, command);
      assert.equal(body.error, `unknown command: ${command}`);
      assert.equal(body.usage, 'atris help');
      assert.deepEqual(body.suggestions, expected);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
      assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
