'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../bin/atris.js');

function proveShortJob(steer = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-short-note-'));
  try {
    fs.mkdirSync(path.join(root, 'atris/team/demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris/team/demo/MEMBER.md'), '---\nname: demo\nrole: Builder\n---\n');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const runner = path.join(bin, 'claude');
    fs.writeFileSync(runner, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--output-format --permission-mode --resume --session-id --include-partial-messages'); process.exit(0); }
const prompt = args[args.indexOf('-p') + 1];
const first = !fs.existsSync('prompts.jsonl');
fs.appendFileSync('prompts.jsonl', JSON.stringify(prompt) + '\\n');
if (first && process.env.SHORT_JOB_STEER === '1') {
  for (const note of ['use the smaller change', 'keep the existing check']) {
    const sent = spawnSync(process.execPath, [process.env.SHORT_JOB_CLI, 'member', 'steer', 'demo', note, '--json'], { encoding: 'utf8', env: process.env });
    if (sent.status !== 0 || JSON.parse(sent.stdout).mode !== 'steered_live') { console.error(sent.stderr || sent.stdout); process.exit(1); }
  }
}
const sessionIndex = args.indexOf('--session-id');
if (sessionIndex >= 0) console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: args[sessionIndex + 1] }));
console.log(JSON.stringify({ type: 'result', is_error: false, result: first ? 'finished the short job' : 'read the operator notes' }));
`);
    fs.chmodSync(runner, 0o755);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
      SHORT_JOB_CLI: cli, SHORT_JOB_STEER: steer ? '1' : '0' };
    for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_CALLER_RUNTIME', 'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_RUNNER_BIN', 'ATRIS_CLAUDE_BIN', 'ATRIS_RUNNER_PROFILE', 'ATRIS_DISPATCH_DEPTH']) delete env[key];
    const args = [cli, 'member', 'run', 'demo', 'finish a short job', '--runner', 'claude', '--max-ticks', '1', '--minutes', '1', '--verify', 'node -e "process.exit(0)"', '--json'];
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.started, true, result.stdout);
    const prompts = fs.readFileSync(path.join(root, 'prompts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(prompts.length, steer ? 2 : 1);
    if (steer) {
      assert.match(prompts[1], /operator: use the smaller change/);
      assert.match(prompts[1], /operator: keep the existing check/);
      assert.equal(payload.mission.pings.length, 2);
      assert.ok(payload.mission.pings.every(p => p.consumed_at));
    }
    assert.equal(payload.mission.verifier_result.passed, true);
    return `member run exited ${result.status}; prompts=${prompts.length}; unread=${(payload.mission.pings || []).filter(p => !p.consumed_at).length}; check=passed`;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--proof')) {
  console.log(proveShortJob());
} else {
  test('notes sent through member steer reach a short job before it stops', () => proveShortJob());
  test('a short job with no note still runs only once', () => proveShortJob(false));
}
