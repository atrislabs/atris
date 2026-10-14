'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../bin/atris.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plain-goal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const member = path.join(root, 'atris/team/mission-lead');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'MEMBER.md'), '# Mission Lead\n');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const worker = path.join(bin, 'claude');
  fs.writeFileSync(worker, `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo '--output-format --permission-mode --resume --session-id --include-partial-messages'
  exit 0
fi
printf 'work completed\\n' >> result.txt
echo '{"type":"result","is_error":false,"result":"wrote result.txt"}'
`);
  fs.chmodSync(worker, 0o755);
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_CALLER_RUNTIME: 'terminal',
    ATRIS_RUNNER_BIN: worker, ATRIS_CLAUDE_BIN: worker, PATH: `${bin}:${process.env.PATH}`,
    ATRIS_TASKS_DB: path.join(root, 'tasks.db') };
  for (const key of ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_COMMAND', 'ATRIS_CLAUDE_COMMAND', 'ATRIS_RUNNER_MODEL', 'ATRIS_CLAUDE_MODEL']) delete env[key];
  return { root, run(extra = [], environment = {}) {
    return spawnSync(process.execPath, [cli, 'mission', 'run', 'write the local result file',
      '--owner', 'mission-lead', '--verify', `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'work completed\\n')"`,
      '--max-ticks', '1', '--max-wall', '30', '--complete-on-pass', '--json', ...extra],
    { cwd: root, env: { ...env, ...environment }, encoding: 'utf8', timeout: 20000 });
  } };
}

test('plain shell mission run executes work once and checks the artifact', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, 'mission_run');
  assert.equal(payload.mission.runner, 'claude');
  assert.equal(payload.ran_ticks, 1);
  assert.equal(payload.mission.status, 'complete');
  assert.equal(fs.readFileSync(path.join(f.root, 'result.txt'), 'utf8'), 'work completed\n');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, payload.summary_receipt), 'utf8'));
  assert.equal(receipt.result.ticks[0].verifier_passed, true);
});

test('live Codex caller preserves the native goal handoff', (t) => {
  const f = fixture(t);
  const result = f.run([], { ATRIS_CALLER_RUNTIME: 'codex' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, 'mission_run_started');
  assert.equal(payload.mission.runner, 'codex_goal');
  assert.equal(payload.requires_native_goal_start, true);
  assert.equal(fs.existsSync(path.join(f.root, 'result.txt')), false);
});

test('explicit manual and native runners preserve their handoff', (t) => {
  for (const runner of ['manual', 'codex_goal', 'atris2']) {
    const f = fixture(t);
    const result = f.run(['--runner', runner]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, 'mission_run_started');
    assert.equal(payload.mission.runner, runner);
    assert.equal(fs.existsSync(path.join(f.root, 'result.txt')), false);
  }
});

test('explicit executable runner does work even when called from Codex', (t) => {
  const f = fixture(t);
  const result = f.run(['--runner', 'claude'], { ATRIS_CALLER_RUNTIME: 'codex' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, 'mission_run');
  assert.equal(payload.ran_ticks, 1);
  assert.equal(payload.mission.status, 'complete');
});
