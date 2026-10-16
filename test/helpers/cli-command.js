'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./agent-env');

const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'atris.js');

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

module.exports = { runCli };
