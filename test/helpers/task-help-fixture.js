'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./agent-env');

const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'atris.js');

function hasNodeSqlite() {
  try {
    require('node:sqlite');
    return true;
  } catch (_) {
    return false;
  }
}

function runCli(args, { cwd, env, timeout = 12000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      NODE_NO_WARNINGS: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function createTaskHelpFixture(prefix) {
  return {
    hasNodeSqlite,
    makeTempDir: (tempPrefix = prefix) => fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix)),
    cleanupTempDir: dir => fs.rmSync(dir, { recursive: true, force: true }),
    runCli,
  };
}

module.exports = { createTaskHelpFixture };
