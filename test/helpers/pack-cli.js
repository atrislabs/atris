'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'atris.js');

function createPackCli(timeout) {
  return function runCli(args, { cwd, env = {} }) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: 'utf8',
      timeout,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...env },
    });
    if (result.error) throw result.error;
    return result;
  };
}

module.exports = { createPackCli };
