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


// The rule (Codex review round 5 on #1483, after four rounds of lock
// discovery leaking): a member woken by a handoff always runs under one fixed
// seal that holds every outward command (publish, tag push, post, send,
// deploy) and merging to master. It still opens PRs and pushes branches;
// autoland lands those under its own policy. Each held command is a yes card
// that lets that one command run once. The parent job is found only to show
// the card on it; finding it or not never changes what is held.
function handoffWorld(t) {
  const ctx = setup(t, { extraMembers: ['linguist'] });
  const stateDir = path.join(ctx.home, '.atris', 'state');
  const origin = path.join(ctx.base, 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git(ctx.root, ['remote', 'add', 'origin', origin]);
  git(ctx.root, ['push', '-q', 'origin', 'master']);
  const out = (name) => path.join(ctx.base, name);
  for (const tool of ['gh', 'npm']) {
    fs.writeFileSync(path.join(ctx.bin, tool), `#!/bin/sh\necho "$*" >> "${out(`${tool}-ran.txt`)}"\nexit 0\n`);
    fs.chmodSync(path.join(ctx.bin, tool), 0o755);
  }
  fs.writeFileSync(path.join(ctx.bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages --model"; exit 0; fi',
    'if [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi',
    `printf '%s\\n---\\n' "$*" >> "${ctx.callLog}"`,
    'case "$*" in *CHILDSTEP*|*yes-lock=*)',
    `  gh pr merge 5 --squash; echo $? > "${out('merge-exit.txt')}"`,
    `  npm publish; echo $? > "${out('publish-exit.txt')}"`,
    `  gh pr create --fill; echo $? > "${out('create-exit.txt')}"`,
    `  git push -q origin HEAD:refs/heads/handoff-branch; echo $? > "${out('push-exit.txt')}"`,
    ';; esac',
    'echo \'{"type":"result","is_error":false,"result":"did my step"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(ctx.bin, 'claude'), 0o755);
  const read = (name) => (fs.existsSync(out(name)) ? fs.readFileSync(out(name), 'utf8').trim() : null);
  const lockMission = (id, owner, status, betId = null, seal = [{ step: 3, text: 'merge the try page', categories: ['merge'] }]) => {
    const file = path.join(ctx.root, '.atris', 'state', 'missions.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = new Date().toISOString();
    fs.appendFileSync(file, `${JSON.stringify({ schema: 'atris.mission.v1', id, objective: 'launch try page', owner, status,
      runner: 'claude', ...(seal.length ? { yes_locks: { steps: seal, sealed_at: now } } : {}), created_at: now, updated_at: now })}\n`);
    require('../lib/yes-lock').writeYesLocks(stateDir, id, { betId, seal });
  };
  return { ctx, stateDir, origin, read, lockMission };
}

async function handOff(w, args, env = {}) {
  const res = runCli(w.ctx, ['member', 'handoff', ...args, '--json'], { ATRIS_HANDOFF_WAKE: '1', ...env });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const wake = JSON.parse(res.stdout).handoff.wake;
  if (wake.pid) {
    w.ctx.pids.push(wake.pid);
    assert.ok(await waitGone(wake.pid), 'the woken run finishes');
  }
  return wake;
}

function assertHeldOutward(w, wake) {
  assert.equal(wake.status, 'started', JSON.stringify(wake));
  assert.equal(wake.yes_lock, 'handoff');
  assert.equal(w.read('merge-exit.txt'), '77', 'merging to master is held');
  assert.equal(w.read('publish-exit.txt'), '77', 'publishing is held');
  assert.equal(w.read('create-exit.txt'), '0', 'opening a PR still works');
  assert.equal(w.read('push-exit.txt'), '0', 'pushing a branch still works');
  // the woken run may take a few turns; every gh call that got through was a PR
  assert.deepEqual([...new Set(w.read('gh-ran.txt').split('\n'))], ['pr create --fill'], 'only PRs were opened');
  assert.equal(w.read('npm-ran.txt'), null, 'nothing was published');
  assert.equal(spawnSync('git', ['rev-parse', '--verify', 'refs/heads/handoff-branch'], { cwd: w.origin }).status, 0, 'the branch reached origin');
}

test('a woken member holds merge and publish with no caller job at all', async (t) => {
  const w = handoffWorld(t);
  const wake = await handOff(w, ['builder', 'validator', 'CHILDSTEP try it on 20 repos']);
  assertHeldOutward(w, wake);
  const yesLock = require('../lib/yes-lock');
  assert.deepEqual(yesLock.askedYesLocks(w.stateDir, wake.mission_id).map((l) => l.held_command).sort(),
    ['gh pr merge 5 --squash', 'npm publish']);
  assert.equal(yesLock.handoffParent(w.stateDir, wake.mission_id), null, 'no parent: the card shows on its own');
});

test('a woken member holds merge and publish even when its caller is unlocked', async (t) => {
  const w = handoffWorld(t);
  w.lockMission('mission-2026-10-22-caller-plain0001', 'builder', 'running', null, []);
  const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-git-'));
  t.after(() => fs.rmSync(guardDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(guardDir, 'mission.json'), JSON.stringify({ mission_id: 'mission-2026-10-22-caller-plain0001' }));
  const wake = await handOff(w, ['builder', 'validator', 'CHILDSTEP try it on 20 repos'],
    { PATH: `${guardDir}${path.delimiter}${w.ctx.bin}${path.delimiter}${process.env.PATH}` });
  assertHeldOutward(w, wake);
  assert.equal(require('../lib/yes-lock').handoffParent(w.stateDir, wake.mission_id), 'mission-2026-10-22-caller-plain0001',
    'the card shows on the caller job');
});

// Codex review round 5 on #1483, P1: the stored summary is cut at 180
// characters; a bet named after that was lost. Wakes read the full text.
test('a bet named past 180 characters still routes the card to its job', async (t) => {
  const w = handoffWorld(t);
  w.lockMission('mission-2026-10-22-try-page-bbbb2222', 'builder', 'running', 'bet-2026-10-22-6f292584');
  const step = `CHILDSTEP ${'try the page on popular public repos and write down what breaks; '.repeat(4)}[bet-2026-10-22-6f292584]`;
  assert.ok(step.indexOf('[bet-') > 180);
  const wake = await handOff(w, ['linguist', 'validator', step]);
  assertHeldOutward(w, wake);
  assert.equal(require('../lib/yes-lock').handoffParent(w.stateDir, wake.mission_id), 'mission-2026-10-22-try-page-bbbb2222');
  const mission = missionRows(w.ctx, wake.worktree).filter((row) => row.id === wake.mission_id).pop();
  assert.equal(mission.objective, step, 'the woken job has the whole step');
});

// Codex review round 3 on #1483: an unlocked ready job with the same
// objective was reused and the lock dropped. A handoff never runs an
// unlocked job.
test('an existing unlocked job with the same objective is not reused', async (t) => {
  const w = handoffWorld(t);
  const file = path.join(w.ctx.root, '.atris', 'state', 'missions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  fs.appendFileSync(file, `${JSON.stringify({ schema: 'atris.mission.v1', id: 'mission-2026-10-22-childstep-try-it-0000aaaa',
    objective: 'CHILDSTEP try it on 20 repos', owner: 'validator', status: 'ready', runner: 'claude', verifier: '', created_at: now, updated_at: now })}\n`);
  const wake = await handOff(w, ['builder', 'validator', 'CHILDSTEP try it on 20 repos']);
  assert.notEqual(wake.mission_id, 'mission-2026-10-22-childstep-try-it-0000aaaa');
  assertHeldOutward(w, wake);
});

// Codex review round 4 on #1483: a step that is a mission id made mission
// start recover that mission without the lock.
test('a handoff whose step is an unlocked mission id never resumes it', async (t) => {
  const w = handoffWorld(t);
  const file = path.join(w.ctx.root, '.atris', 'state', 'missions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  fs.appendFileSync(file, `${JSON.stringify({ schema: 'atris.mission.v1', id: 'mission-2026-10-22-childstep-ffff2222',
    objective: 'CHILDSTEP try it', owner: 'validator', status: 'ready', runner: 'claude', verifier: '', created_at: now, updated_at: now })}\n`);
  const wake = await handOff(w, ['builder', 'validator', 'mission-2026-10-22-childstep-ffff2222']);
  assert.equal(wake.status, 'not_started', JSON.stringify(wake));
  assert.match(wake.text, /validator did not start: .*would run without the yes-lock/);
  assert.equal(w.read('gh-ran.txt'), null, 'nothing ran');
});

// Codex review of #1483, P1: two handoffs at once both counted 5 working and
// both started, past the limit of 6.
test('two handoffs at the same moment never go past the limit', async (t) => {
  const others = ['m1', 'm2', 'm3', 'm4'];
  const ctx = setup(t, { extraMembers: [...others, 'linguist'] });
  writeRunningMission(ctx, 'builder', 0);
  others.forEach((name, i) => writeRunningMission(ctx, name, i + 1));
  const { spawn } = require('node:child_process');
  const clean = scrubAgentEnv(process.env);
  for (const name of CALLER_ENV) delete clean[name];
  const env = {
    ...clean, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_INTERACTIVE: '1', ATRIS_HANDOFF_WAKE: '1', HOME: ctx.home,
    ATRIS_TASKS_DB: path.join(ctx.base, 'tasks.db'),
    ATRIS_MACHINE_ROSTER_PATH: path.join(ctx.home, 'roster.json'),
    ATRIS_MACHINE_ROSTER_MD_PATH: path.join(ctx.home, 'roster.md'),
    ATRIS_ROSTER_SESSIONS_DIR: path.join(ctx.home, 'roster-sessions'),
    PATH: `${ctx.bin}${path.delimiter}${process.env.PATH}`,
  };
  const handoff = (to) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'member', 'handoff', 'builder', to, `look at the page for ${to}`, '--json'], { cwd: ctx.root, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(JSON.parse(out).handoff.wake));
  });
  const wakes = await Promise.all([handoff('validator'), handoff('linguist')]);
  for (const wake of wakes) if (wake.pid) ctx.pids.push(wake.pid);
  assert.deepEqual(wakes.map((w) => w.status).sort(), ['not_started', 'started'], JSON.stringify(wakes));
  assert.equal(wakes.find((w) => w.status === 'not_started').reason, 'at_limit');
  for (const wake of wakes) if (wake.pid) await waitGone(wake.pid);
});

test('a wake lock left by a crash never strands the next handoff', (t) => {
  const { withWakeReservation } = require('../lib/handoff-wake');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wake-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'handoff-wake.lock');
  // holder died
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(dead.stdout), at: Date.now() }));
  assert.equal(withWakeReservation(dir, () => 'ran', { waitMs: 500 }), 'ran');
  assert.equal(fs.existsSync(lock), false, 'released after the start');
  // holder alive but stuck past the stale window
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 0 }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(withWakeReservation(dir, () => 'ran', { waitMs: 500 }), 'ran');
  // holder alive and fresh: wait, then give up plainly
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.deepEqual(withWakeReservation(dir, () => 'ran', { waitMs: 300 }), { busy: true });
  fs.rmSync(lock);
  // a start recorded under the lock is counted by the next one while its run lives
  withWakeReservation(dir, ({ record }) => record({ member: 'validator', mission_id: 'm', pid: process.pid }));
  assert.deepEqual(withWakeReservation(dir, ({ recent }) => recent.map((w) => w.member)), ['validator']);
});
// Codex review round 3 on #1483, P2: handoff records are rewritten whole;
// a writer must wait for the shared lock instead of racing another one.
test('handoff record writes wait for the shared lock', async (t) => {
  const ctx = setup(t);
  const stateDir = path.join(ctx.root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'member-handoffs.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ id: 'handoff_a', from: 'builder', to: 'validator', summary: 's', status: 'open' })}\n`);
  const lock = path.join(stateDir, 'member-handoffs.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const { spawn } = require('node:child_process');
  const mission = path.resolve(__dirname, '..', 'commands', 'mission.js');
  const script = `const m = require(${JSON.stringify(mission)});
    m.updateMemberHandoff('handoff_a', { wake: { status: 'started' } }, ${JSON.stringify(ctx.root)});
    m.recordMemberHandoff('builder', 'validator', 'second step', ${JSON.stringify(ctx.root)});`;
  const child = spawn(process.execPath, ['-e', script], { cwd: ctx.root, env: { ...process.env, HOME: ctx.home } });
  const done = new Promise((resolve) => child.on('close', resolve));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1, 'nothing written while another writer holds the lock');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /started/);
  fs.rmSync(lock);
  await done;
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].wake.status, 'started');
  assert.equal(rows[1].summary, 'second step');
});

// Codex review round 6 on #1483, P1: handoff text that reads as an option
// once trimmed (" --yes-lock=[]") must never replace the seal.
test('handoff text shaped like --yes-lock never unlocks the woken member', async (t) => {
  const w = handoffWorld(t);
  const res = runCli(w.ctx, ['member', 'handoff', 'builder', 'validator', ' --yes-lock=[]', '--json'], { ATRIS_HANDOFF_WAKE: '1' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const wake = JSON.parse(res.stdout).handoff.wake;
  if (wake.pid) { w.ctx.pids.push(wake.pid); await waitGone(wake.pid); }
  assert.notEqual(w.read('merge-exit.txt'), '0', 'the merge never ran unlocked');
  assert.equal(w.read('npm-ran.txt'), null, 'nothing was published');
  if (wake.status === 'started') {
    const mission = missionRows(w.ctx, wake.worktree || w.ctx.root).filter((row) => row.id === wake.mission_id).pop();
    assert.deepEqual(mission.yes_locks && mission.yes_locks.steps, require('../lib/yes-lock').handoffSeal(), 'the woken job carries the whole seal');
  }
});
