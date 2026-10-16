'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./agent-env');

const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'atris.js');

function createDogfoodCli(defaultTimeout) {
  return function runCli(args, { cwd, env, timeout = defaultTimeout } = {}) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: 'utf8',
      timeout,
      env: {
        ...scrubAgentEnv(),
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_NONINTERACTIVE: '1',
        ...(env || {}),
      },
    });
    if (result.error && result.error.code === 'ETIMEDOUT') {
      assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
    }
    if (result.error) throw result.error;
    return result;
  };
}

module.exports = { createDogfoodCli };
