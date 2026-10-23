'use strict';

// Live 2026-10-22: the builder finished mission #266 and ran
// `atris member handoff builder validator "..."` (and the same to linguist).
// The handoff was written down and the phone said "validator has it", but no
// validator or linguist run ever started. A handoff to a member who is not
// running now wakes that member on the handed-off step through the member
// runtime (member run, detached), inside the team's limit on members working
// at once. When it cannot, the handoff says why and records it, so nothing
// claims the member has the work.
//
// Same evening: `atris member inbox validator` is not a command, but it was
// read as a two-word job and started a mission called "inbox validator".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
const STEP = '[bet-2026-10-22-6f292584] Try it on 20 popular public repos and fix what breaks';
const CALLER_ENV = ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_CALLER_RUNTIME',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE'];

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function writeMember(root, name, role) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\n---\n\n# ${name}\n`);
}

// builder and validator on a git repo; a machine roster that names claude for
// every job unless `roster: false`; a fake claude that logs each call.
function setup(t, { roster = true, extraMembers = [] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-handoff-wakes-'));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  for (const dir of [root, home, bin]) fs.mkdirSync(dir, { recursive: true });
  writeMember(root, 'builder', 'Builder');
  writeMember(root, 'validator', 'Validator');
  for (const name of extraMembers) writeMember(root, name, 'Builder');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.email', 'test@atris.dev']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  if (roster) {
    fs.writeFileSync(path.join(home, 'roster.md'), [
      '# roster', '',
      '## build', '- claude code, model: opus 5.5', '',
      '## review', '- claude code, model: opus 5.5', '',
      '## search', '- claude code, model: opus 5.5', '',
    ].join('\n'));
  }
  const callLog = path.join(base, 'claude-calls.log');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages --model"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi',
    `printf '%s\\n---\\n' "$*" >> "${callLog}"`,
    'echo \'{"type":"result","is_error":false,"result":"tried the page on the repos"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const ctx = { base, root, home, bin, callLog, pids: [] };
  t.after(() => {
    for (const pid of ctx.pids) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    try {
      const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout || '';
      for (const line of list.split('\n')) {
        const dir = line.startsWith('worktree ') ? line.slice('worktree '.length) : '';
        if (dir && fs.realpathSync(dir) !== fs.realpathSync(root)) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  });
  return ctx;
}

function runCli(ctx, args, env = {}) {
  const clean = scrubAgentEnv(process.env);
  for (const name of CALLER_ENV) delete clean[name];
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...clean,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
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

function handoffRows(ctx) {
  const file = path.join(ctx.root, '.atris', 'state', 'member-handoffs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function missionRows(ctx, root = ctx.root) {
  const file = path.join(root, '.atris', 'state', 'missions.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function writeRunningMission(ctx, owner, n) {
  const file = path.join(ctx.root, '.atris', 'state', 'missions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  fs.appendFileSync(file, `${JSON.stringify({
    schema: 'atris.mission.v1',
    id: `mission-2026-10-22-live-${owner}-${n}`,
    objective: `${owner} keeps working`,
    owner,
    status: 'running',
    runner: 'claude',
    created_at: now,
    updated_at: now,
    last_tick_at: now,
  })}\n`);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pid, ms = 60000) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  return !alive(pid);
}

test('a handoff to a member who is not running wakes that member on the handed-off step', async (t) => {
  const ctx = setup(t);
  const res = runCli(ctx, ['member', 'handoff', 'builder', 'validator', STEP, '--json'], { ATRIS_HANDOFF_WAKE: '1' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  const wake = payload.handoff.wake;
  assert.ok(wake, res.stdout);
  if (wake.pid) ctx.pids.push(wake.pid);
  assert.equal(wake.status, 'started', JSON.stringify(wake));
  assert.ok(wake.mission_id, 'the woken run is a real mission');
  assert.match(wake.text, /^validator is working on it now/);

  // The woken run is validator's own mission, in its own worktree, on the
  // handed-off step.
  assert.ok(wake.worktree && fs.existsSync(wake.worktree), 'the run has its own worktree');
  assert.equal(wake.engine, 'claude');
  const mission = missionRows(ctx, wake.worktree).filter((row) => row.id === wake.mission_id).pop();
  assert.ok(mission, 'the mission is on file');
  assert.equal(mission.owner, 'validator');
  assert.ok(mission.objective.includes(STEP), mission.objective);

  // The handoff on file carries the same outcome, so the phone reads the truth.
  const row = handoffRows(ctx).pop();
  assert.equal(row.to, 'validator');
  assert.equal(row.wake.status, 'started');
  assert.equal(row.wake.mission_id, wake.mission_id);

  // The detached run really works: the engine is called on validator's step.
  assert.ok(wake.pid, 'the detached driver pid is recorded');
  assert.ok(await waitGone(wake.pid), 'the woken run finishes');
  const calls = fs.existsSync(ctx.callLog) ? fs.readFileSync(ctx.callLog, 'utf8') : '';
  assert.match(calls, /Try it on 20 popular public repos/);
});

test('a handoff at the limit of members working at once starts nobody and says so', (t) => {
  const others = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const ctx = setup(t, { extraMembers: others });
  // builder (the member handing off) plus five more are working: six, the limit.
  writeRunningMission(ctx, 'builder', 0);
  others.forEach((name, i) => writeRunningMission(ctx, name, i + 1));
  const before = missionRows(ctx).length;

  const res = runCli(ctx, ['member', 'handoff', 'builder', 'validator', STEP, '--json'], { ATRIS_HANDOFF_WAKE: '1' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const wake = JSON.parse(res.stdout).handoff.wake;
  assert.equal(wake.status, 'not_started');
  assert.equal(wake.reason, 'at_limit');
  assert.match(wake.text, /validator did not start: 6 members are already working and the limit is 6/);
  assert.match(wake.text, /nobody is working on this step yet/);
  assert.equal(missionRows(ctx).length, before, 'no mission started');
  assert.equal(handoffRows(ctx).pop().wake.reason, 'at_limit');

  const text = runCli(ctx, ['member', 'handoff', 'builder', 'validator', 'check the page again'], { ATRIS_HANDOFF_WAKE: '1' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /validator did not start: 6 members are already working/);
  assert.match(text.stdout, /atris member wake validator/);
});

test('a handoff to a member with no engine starts nobody and says so', (t) => {
  const ctx = setup(t, { roster: false });
  const res = runCli(ctx, ['member', 'handoff', 'builder', 'validator', STEP, '--json'], { ATRIS_HANDOFF_WAKE: '1' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const wake = JSON.parse(res.stdout).handoff.wake;
  assert.equal(wake.status, 'not_started');
  assert.equal(wake.reason, 'no_engine');
  assert.match(wake.text, /validator did not start: the roster names no engine for validator/);
  assert.equal(missionRows(ctx).length, 0);
  assert.equal(handoffRows(ctx).pop().wake.reason, 'no_engine');
});

test('a handoff to a member already working starts no second run', (t) => {
  const ctx = setup(t);
  writeRunningMission(ctx, 'validator', 1);
  const res = runCli(ctx, ['member', 'handoff', 'builder', 'validator', STEP, '--json'], { ATRIS_HANDOFF_WAKE: '1' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const wake = JSON.parse(res.stdout).handoff.wake;
  assert.equal(wake.status, 'already_working');
  assert.equal(missionRows(ctx).length, 1, 'no second mission');
});

test('a handoff with --no-wake only records the handoff', (t) => {
  const ctx = setup(t);
  const res = runCli(ctx, ['member', 'handoff', 'builder', 'validator', STEP, '--no-wake', '--json'], { ATRIS_HANDOFF_WAKE: '1' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.handoff.summary, STEP, 'the flag is not part of the step');
  assert.equal(payload.handoff.wake.status, 'not_started');
  assert.equal(payload.handoff.wake.reason, 'not_asked');
  assert.equal(missionRows(ctx).length, 0);
});

test('the wake decision follows the team: asleep, a person, unknown', () => {
  const { wakeHandoffReceiver } = require('../lib/handoff-wake');
  const team = [
    { name: 'builder', live: true },
    { name: 'validator', live: false },
    { name: 'linguist', live: false, sleeping: true },
    { name: 'keshav', live: false, human: true },
  ];
  const started = [];
  const deps = {
    listMembers: () => team,
    awake: () => true,
    engine: () => ({ id: 'claude' }),
    start: (to, step) => { started.push([to, step]); return { ok: true, mission_id: 'm-1', pid: 1 }; },
    max: 6,
  };
  assert.equal(wakeHandoffReceiver({ to: 'linguist', summary: 's' }, deps).reason, 'asleep');
  assert.equal(wakeHandoffReceiver({ to: 'keshav', summary: 's' }, deps).reason, 'person');
  assert.equal(wakeHandoffReceiver({ to: 'ghost', summary: 's' }, deps).reason, 'not_on_team');
  assert.equal(wakeHandoffReceiver({ to: 'validator', summary: 's' }, { ...deps, awake: () => false }).reason, 'asleep');
  const failed = wakeHandoffReceiver({ to: 'validator', summary: 's' }, { ...deps, start: () => ({ ok: false, error: 'claude is not installed' }) });
  assert.deepEqual([failed.status, failed.reason], ['not_started', 'start_failed']);
  assert.match(failed.text, /validator did not start: claude is not installed/);
  assert.equal(started.length, 0);
  const ok = wakeHandoffReceiver({ to: 'validator', summary: 'the step' }, deps);
  assert.deepEqual([ok.status, ok.mission_id], ['started', 'm-1']);
  assert.deepEqual(started, [['validator', 'the step']]);
});

test('atris member inbox validator is not a command and starts nothing', (t) => {
  const ctx = setup(t);
  const res = runCli(ctx, ['member', 'inbox', 'validator']);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  assert.match(res.stdout, /No member or command named "inbox", so nothing started/);
  assert.equal(missionRows(ctx).length, 0, 'no mission called "inbox validator"');
  assert.equal(fs.existsSync(ctx.callLog), false, 'no engine ran');

  // A quoted prompt, or a longer job, still reaches the launcher.
  for (const args of [['inbox validator', '--dry-run', '--json'], ['check', 'validator', 'output', '--dry-run', '--json']]) {
    const job = runCli(ctx, ['member', ...args]);
    assert.doesNotMatch(job.stdout, /nothing started/, args.join(' '));
  }
});

// Coordinator ask 2026-10-22: the try page bet has later steps that merge,
// post and publish, held until the owner says yes. A member woken by a
// handoff from that mission must run under the same lock, or the lock is
// gone the moment work changes hands.
test('a member woken by a handoff runs under the handing-off mission yes-lock', async (t) => {
  const ctx = setup(t);
  const yesLock = require('../lib/yes-lock');
  const stateDir = path.join(ctx.home, '.atris', 'state');
  const ghRan = path.join(ctx.base, 'gh-ran.txt');
  const ghExit = path.join(ctx.base, 'gh-exit.txt');
  const handoffOut = path.join(ctx.base, 'handoff.json');
  // The real gh never runs while the step is locked.
  fs.writeFileSync(path.join(ctx.bin, 'gh'), `#!/bin/sh\necho "$*" >> "${ghRan}"\nexit 0\n`);
  fs.chmodSync(path.join(ctx.bin, 'gh'), 0o755);
  // builder's tick hands off; validator's tick tries to merge.
  fs.writeFileSync(path.join(ctx.bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages --model"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi',
    `printf '%s\\n---\\n' "$*" >> "${ctx.callLog}"`,
    'case "$*" in',
    `  *PARENTSTEP*) "${process.execPath}" "${cli}" member handoff builder validator "CHILDSTEP try it on 20 repos" --json > "${handoffOut}" ;;`,
    `  *CHILDSTEP*) gh pr merge 5 --squash; echo $? > "${ghExit}" ;;`,
    'esac',
    'echo \'{"type":"result","is_error":false,"result":"did my step"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(ctx.bin, 'claude'), 0o755);

  const seal = [{ step: 3, text: 'merge the try page', categories: ['merge'] }];
  const started = runCli(ctx, ['mission', 'start', 'launch try page PARENTSTEP', '--owner', 'builder', '--runner', 'claude',
    '--no-verify', '--yes-lock', JSON.stringify(seal), '--json']);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const parent = JSON.parse(started.stdout).mission;
  // what the phone's do it writes beside the ledger
  yesLock.writeYesLocks(stateDir, parent.id, { betId: 'bet-1', seal });

  const ran = runCli(ctx, ['mission', 'run', parent.id, '--max-ticks', '1', '--json'], { ATRIS_HANDOFF_WAKE: '1' });
  assert.ok(fs.existsSync(handoffOut), ran.stderr || ran.stdout);
  const wake = JSON.parse(fs.readFileSync(handoffOut, 'utf8')).handoff.wake;
  if (wake.pid) ctx.pids.push(wake.pid);
  assert.equal(wake.status, 'started', JSON.stringify(wake));
  assert.ok(await waitGone(wake.pid), 'the woken run finishes');

  assert.equal(fs.existsSync(ghExit), true, 'validator tried to merge');
  assert.equal(fs.readFileSync(ghExit, 'utf8').trim(), '77', 'the merge is held');
  assert.equal(fs.existsSync(ghRan), false, 'the real gh never ran');
  // The held step shows up on the parent job, where the owner's yes card lives.
  assert.deepEqual(yesLock.askedYesLocks(stateDir, parent.id).map((l) => l.step), [3]);
  assert.equal(wake.yes_lock_from, parent.id, 'the handoff names the lock the woken run is under');
});
