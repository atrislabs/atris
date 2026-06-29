'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI_PATH = path.join(__dirname, '..', 'bin', 'atris.js');
const RUNNER_ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function runCli(args) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  for (const key of RUNNER_ENV_KEYS) delete env[key];
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
}

test('run and autopilot reject runner flags without values', () => {
  for (const command of ['run', 'autopilot']) {
    for (const flag of ['--runner-bin', '--runner-template', '--runner-model', '--runner-profile']) {
      const res = runCli([command, flag, '--dry-run']);
      const output = `${res.stdout || ''}\n${res.stderr || ''}`;
      assert.equal(res.status, 1, `${command} ${flag}: ${output}`);
      assert.match(output, new RegExp(`${flag} requires a value`));
      assert.doesNotMatch(output, /CLI not found|No atris\/ folder|atris\/ folder not found/);
      assert.doesNotMatch(output, /\n\s+at\s+/);
    }
  }
});

test('run rejects empty inline runner flag values', () => {
  const res = runCli(['run', '--runner-bin=']);
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  assert.equal(res.status, 1, output);
  assert.match(output, /--runner-bin requires a value/);
  assert.doesNotMatch(output, /\n\s+at\s+/);
});
