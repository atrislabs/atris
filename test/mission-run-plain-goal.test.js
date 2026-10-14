'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../bin/atris.js');

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plain-goal-'));
  fs.mkdirSync(path.join(root, 'bin'));
  // The real CLI launches this worker process. Its artifact, rather than
  // its success message, is what the mission's verifier checks.
  const worker = path.join(root, 'bin/claude');
  fs.writeFileSync(worker, `#!${process.execPath}\n` + [
    "const fs = require('node:fs');",
    "if (process.argv.includes('--help')) { console.log('--output-format --permission-mode --resume --session-id --include-partial-messages'); process.exit(0); }",
    "fs.writeFileSync('result.txt', 'the work happened\\n');",
    "console.log(JSON.stringify({type:'result', is_error:false, result:'wrote the requested result'}));",
  ].join('\n'));
  fs.chmodSync(worker, 0o755);
  return root;
}

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_CALLER_RUNTIME: 'terminal',
      CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', ATRIS_RUNNER_PROFILE: '',
      ATRIS_MACHINE_ROSTER_MD_PATH: path.join(root, 'absent-roster.md'),
      PATH: `${path.join(root, 'bin')}${path.delimiter}/usr/bin:/bin`, ...env },
  });
}

const objective = 'write the requested result file';
const check = 'test -s result.txt';
const options = ['--owner', 'architect', '--no-preflight', '--max-ticks', '1',
  '--max-wall', '20', '--no-drain', '--verify', check, '--complete-on-pass', '--json'];

for (const runner of [null, 'claude']) {
  test(`plain objective executes and checks its artifact (${runner || 'default worker'})`, () => {
    const root = workspace();
    try {
      const result = run(root, ['mission', 'run', objective, ...options, ...(runner ? ['--runner', runner] : [])]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.action, 'mission_run');
      assert.equal(payload.mission.runner, 'claude');
      assert.equal(payload.mission.status, 'complete');
      assert.equal(payload.ran_ticks, 1);
      assert.equal(payload.ticks[0].verifier_passed, true);
      assert.equal(fs.readFileSync(path.join(root, 'result.txt'), 'utf8'), 'the work happened\n');
      assert.ok(fs.existsSync(path.join(root, payload.summary_receipt)));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const entry of [
  { name: 'explicit native goal', args: ['--runner', 'codex_goal'], env: {} },
  { name: 'live coding session', args: [], env: { ATRIS_CALLER_RUNTIME: 'codex' } },
  { name: 'explicit manual run', args: ['--runner', 'manual'], env: {} },
]) {
  test(`${entry.name} keeps the handoff without launching a second worker`, () => {
    const root = workspace();
    try {
      const result = run(root, ['mission', 'run', objective, ...options, ...entry.args], entry.env);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.action, 'mission_run_started');
      assert.equal(fs.existsSync(path.join(root, 'result.txt')), false);
      if (entry.name !== 'explicit manual run') {
        assert.equal(payload.mission.runner, 'codex_goal');
        assert.equal(payload.requires_native_goal_start, true);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
