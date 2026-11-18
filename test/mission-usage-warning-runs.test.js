'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
// A multi-round run needs more than the shared helper's 20 seconds on a busy machine.
function runCli(args, { cwd, env }) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 180000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_INTERACTIVE: '1', ...env } });
  if (r.error) throw r.error;
  return r;
}

// Seen live 2026-11-17: three three-hour member runs paused after 25 minutes with
// rate-limit-exceeded-wall, because Claude sent "allowed_warning" at 75% of the
// weekly window. A warning still runs; only a closed window is a wall.
test('a usage warning from Claude does not pause a timed run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-usage-warning-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const env = { HOME: dir, ATRIS_TASKS_DB: path.join(dir, 'tasks.db') };
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir, env }).status, 0);
    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'claude'), [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
      "echo '{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed_warning\",\"resetsAt\":4102444800,\"rateLimitType\":\"seven_day\",\"utilization\":0.75}}'",
      "echo '{\"type\":\"result\",\"is_error\":false,\"result\":\"did work\"}'",
      'exit 0', '',
    ].join('\n'), { mode: 0o755 });
    env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ''}`;
    const start = runCli(['mission', 'start', '--no-verify', 'timed run survives a usage warning', '--owner', 'mission-lead', '--runner', 'claude', '--cadence', 'manual', '--json'], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const id = JSON.parse(start.stdout).mission.id;
    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', id, '--minutes', '10', '--no-verify', '--json'], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.notEqual(payload.pause_reason, 'rate-limit-exceeded-wall');
    assert.ok(payload.ran_ticks > 1, `ran ${payload.ran_ticks} rounds`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
