'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'atris.js');

// Compact mission --json keeps tick payloads to ids + next_command.
// Tests that read mission/tick/verifier fields need the full dump.
function withMissionFullJson(args) {
  if (!Array.isArray(args) || args[0] !== 'mission') return args;
  if (!args.includes('--json') || args.includes('--full')) return args;
  if (args[1] !== 'tick') return args;
  return [...args, '--full'];
}

function jsonErrorDetail(payload) {
  return payload && (payload.detail || payload.error);
}

function runMissionCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function runMissionGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

module.exports = {
  withMissionFullJson,
  jsonErrorDetail,
  runMissionCli,
  runMissionGit,
};
