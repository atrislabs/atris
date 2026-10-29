'use strict';

// Founder goal (2026-10-13): "tell it to wake up and it would do stuff."
// A member run or wake started from a plain terminal must execute a bounded
// work step on the roster's build engine, not wait on a codex native goal
// that no session will ever start. Inside a real codex session the native
// goal path stays. A change on a protected surface stops with one review ask.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
const CALLER_ENV = ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_CALLER_RUNTIME',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE'];

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

// A workspace with one builder member, a machine roster whose build lead is
// claude opus 5.5, and a fake claude that logs its argv and does the work
// the test asks for (ATRIS_TEST_WORK runs inside the tick's checkout).
function setup(t, { mission = 'Keep the demo service healthy for its users.' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-wakes-work-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  for (const dir of [root, home, bin]) fs.mkdirSync(dir, { recursive: true });
  const memberDir = path.join(root, 'atris', 'team', 'demo');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: demo\nrole: Builder\n---\n\n# demo\n');
  fs.writeFileSync(path.join(memberDir, 'MISSION.md'), `# Mission\n\n## North Star\n\n${mission}\n`);
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.email', 'test@atris.dev']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);

  fs.writeFileSync(path.join(home, 'roster.md'), '# roster\n\n## build\n- claude code, model: opus 5.5\n');
  const argsLog = path.join(base, 'claude-args.log');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages --model"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi',
    `printf '%s\\n' "$@" >> "${argsLog}"`,
    'echo "---" >> "' + argsLog + '"',
    'if [ -n "$ATRIS_TEST_WORK" ]; then sh -c "$ATRIS_TEST_WORK"; fi',
    'echo \'{"type":"result","is_error":false,"result":"read the member file and reported the baseline"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  return { base, root, home, bin, argsLog };
}

function runCli(ctx, args, env = {}) {
  const clean = scrubAgentEnv(process.env);
  for (const name of CALLER_ENV) delete clean[name];
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...clean,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      // The fixture roster pins opus 5.5; it runs only with the owner's yes.
      ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5',
      HOME: ctx.home,
      ATRIS_TASKS_DB: path.join(ctx.base, 'tasks.db'),
      ATRIS_MACHINE_ROSTER_PATH: path.join(ctx.home, 'roster.json'),
      ATRIS_MACHINE_ROSTER_MD_PATH: path.join(ctx.home, 'roster.md'),
      ATRIS_ROSTER_SESSIONS_DIR: path.join(ctx.home, 'roster-sessions'),
      PATH: `${ctx.bin}${path.delimiter}${process.env.PATH}`,
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function claudeCalls(ctx) {
  if (!fs.existsSync(ctx.argsLog)) return [];
  return fs.readFileSync(ctx.argsLog, 'utf8').split('---\n').filter((chunk) => chunk.trim());
}

test('plain-terminal member run executes a work step on the roster build engine', (t) => {
  const ctx = setup(t);
  const res = runCli(ctx, ['member', 'run', 'demo', 'report the baseline read-only', '--minutes', '5', '--no-verify', '--json']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true, res.stdout);
  assert.equal(payload.started, true);
  assert.equal(payload.caller_runtime, 'terminal');
  assert.equal(payload.mission.runner, 'auto');
  assert.equal(payload.work_step.ran, true);
  assert.equal(payload.work_step.engine, 'claude');
  assert.equal(payload.work_step.model, 'claude-opus-5-5');
  assert.ok(payload.work_step.receipt_path, 'the run leaves a receipt');
  assert.ok(fs.existsSync(path.resolve(payload.mission.worktree?.path || ctx.root, payload.work_step.receipt_path)));
  assert.equal(payload.codex_goal_state, undefined, 'no stale codex goal view on a run that already worked');
  const calls = claudeCalls(ctx);
  assert.equal(calls.length >= 1, true, 'claude ran the work step');
  assert.match(calls[0], /claude-opus-5-5/);
});

test('a plain-terminal member run on a stored codex_goal mission swaps in the roster engine', (t) => {
  const ctx = setup(t);
  const started = runCli(ctx, ['mission', 'start', 'report the baseline read-only', '--owner', 'demo',
    '--runner', 'codex_goal', '--no-verify', '--json']);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const mission = JSON.parse(started.stdout).mission;
  assert.equal(mission.runner, 'codex_goal');

  const res = runCli(ctx, ['member', 'run', 'demo', '--mission', mission.id, '--json']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true, res.stdout);
  assert.equal(payload.started, true);
  assert.deepEqual(payload.runner_swap && [payload.runner_swap.from, payload.runner_swap.to], ['codex_goal', 'auto']);
  assert.equal(payload.work_step.ran, true);
  assert.equal(payload.work_step.engine, 'claude');
  assert.notEqual(payload.requires_native_goal_start, true);
  assert.equal(claudeCalls(ctx).length >= 1, true);
});

test('inside a codex session member run keeps the native goal path', (t) => {
  const ctx = setup(t);
  const res = runCli(ctx, ['member', 'run', 'demo', 'report the baseline read-only', '--minutes', '5', '--no-verify', '--json'],
    { CODEX_THREAD_ID: 'thread-test-1' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.caller_runtime, 'codex');
  assert.equal(payload.mission.runner, 'codex_goal');
  assert.equal(payload.started, false);
  assert.equal(payload.ok, true);
  assert.equal(payload.waiting_on, 'native_goal_start');
  assert.equal(payload.requires_native_goal_start, true);
  assert.equal(payload.native_goal_action.tool, 'create_goal');
  assert.match(payload.next_command, /create_goal/);
  assert.equal(payload.runner_swap, null);
  assert.equal(claudeCalls(ctx).length, 0, 'no engine runs under a codex caller');
});

test('a change on a protected surface stops with one review ask and keeps the work', (t) => {
  const ctx = setup(t);
  const work = 'mkdir -p auth && printf "export const token = 1;\\n" > auth/session.js && git add auth/session.js';
  const res = runCli(ctx, ['member', 'run', 'demo', 'tidy the session helper', '--minutes', '5', '--no-verify', '--json'],
    { ATRIS_TEST_WORK: work });
  assert.notEqual(res.status, 0);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.needs_review, true, res.stdout);
  assert.match(payload.ask, /^demo staged a change that touches auth/);
  assert.equal(payload.ask.split('\n').length, 1);
  assert.equal(payload.error, payload.ask);
  assert.match(payload.next_command, /diff HEAD/);
  assert.match(payload.resume_command, /^atris mission run /);
  const kept = path.join(payload.review_path, 'auth', 'session.js');
  assert.ok(fs.existsSync(kept), 'the staged work stays in place for review');
});

test('plain-terminal member wake runs one bounded work step on the roster engine', (t) => {
  const ctx = setup(t);
  const res = runCli(ctx, ['member', 'wake', 'demo', '--minutes', '5', '--json']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.action, 'wake');
  assert.ok(payload.work_step, res.stdout);
  assert.equal(payload.work_step.ran, true, JSON.stringify(payload.work_step));
  assert.equal(payload.work_step.engine, 'claude');
  assert.equal(payload.work_step.model, 'claude-opus-5-5');
  assert.ok(payload.work_step.receipt_path);
  assert.equal(claudeCalls(ctx).length >= 1, true);
});

test('member wake --plan and a codex caller only plan', (t) => {
  const ctx = setup(t);
  const planned = runCli(ctx, ['member', 'wake', 'demo', '--plan', '--json']);
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  assert.equal(JSON.parse(planned.stdout).work_step, undefined);
  const codex = runCli(ctx, ['member', 'wake', 'demo', '--json'], { CODEX_THREAD_ID: 'thread-test-2' });
  assert.equal(codex.status, 0, codex.stderr || codex.stdout);
  assert.deepEqual(JSON.parse(codex.stdout).work_step, { ran: false, skipped: true, reason: 'codex session does the work itself' });
  assert.equal(claudeCalls(ctx).length, 0);
});
