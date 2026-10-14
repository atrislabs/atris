'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemberUp, IDLE_EXIT } = require('../lib/member-up');
const { memberUpSpawn } = require('../commands/member');
const { scrubAgentEnv } = require('./helpers/agent-env');

const task = (id, title) => ({ id, title, metadata: { verify: 'node --test test/x.test.js' } });

function window() {
  const lines = [];
  let picked = null;
  let claim, exit;
  let clock = Date.now();
  const up = createMemberUp({
    listMembers: () => [{ name: 'executor' }],
    pickTask: () => picked,
    now: () => clock,
    print: (line) => lines.push(line),
    spawn: (_name, onExit, onClaim) => { exit = onExit; claim = onClaim; },
  });
  up.check();
  picked = task('preview', 'previewed job');
  clock += 60000;
  up.check();
  return { up, lines, claim: (...args) => claim(...args), exit: (...args) => exit(...args) };
}

test('wake and start wait for the claimed task and announce its actual title once', () => {
  const win = window();
  assert.deepEqual(win.lines, ['executor is idle, no task with a check']);
  assert.deepEqual(win.up.running(), ['executor'], 'pending launch still reserves capacity');
  assert.deepEqual(win.up.idle(), ['executor'], 'launch alone does not wake the member');
  win.claim(task('actual', 'actual job\nfrom the list'));
  win.claim(task('actual', 'duplicate'));
  assert.deepEqual(win.lines, [
    'executor is idle, no task with a check',
    'executor woke up for: actual job from the list',
    'executor started on: actual job from the list',
  ]);
  assert.deepEqual(win.up.idle(), []);
});

test('losing the claim race never announces a wake or start, including a late confirmation', () => {
  const win = window();
  win.exit(IDLE_EXIT);
  win.claim(task('late', 'late job'));
  assert.ok(!win.lines.some((line) => /woke up|started on/.test(line)));
  assert.deepEqual(win.up.running(), []);
  assert.deepEqual(win.up.idle(), ['executor']);
});

test('failed launch never announces a wake or start', () => {
  const lines = [];
  const up = createMemberUp({
    listMembers: () => [{ name: 'executor' }],
    pickTask: () => task('one', 'job'),
    now: () => Date.now(),
    print: (line) => lines.push(line),
    spawn: () => { throw new Error('launch refused'); },
  });
  up.check();
  assert.deepEqual(lines, ['executor failed to start: launch refused']);
  assert.deepEqual(up.running(), []);
});

// Run the production spawner and actual CLI against a real isolated task DB.
// Stop a successful child as soon as it confirms its claim, before any engine
// work is needed. No model or network service is part of this regression.
for (const replacement of [false, true]) {
  test(`real CLI ${replacement ? 'confirms the replacement task' : 'loses the previewed task and stays idle'}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wake-claim-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const member = path.join(root, 'atris', 'team', 'executor');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: executor\nrole: Builder\n---\n# executor\n');
    const saved = { ...process.env };
    const env = {
      ...scrubAgentEnv(), HOME: home, ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
      ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_PROGRESS_DIR: path.join(root, 'progress'),
      ATRIS_CALLER_RUNTIME: 'terminal',
    };
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    const taskDb = require('../lib/task-db');
    taskDb.close();
    const db = taskDb.open(env.ATRIS_TASKS_DB);
    const workspaceRoot = taskDb.workspaceRoot(root);
    const preview = taskDb.addTask(db, { title: 'previewed job', workspaceRoot, metadata: { verify: 'node --test test/x.test.js' } }).id;
    taskDb.claimTask(db, { id: preview, claimedBy: 'another-member' });
    const actual = replacement ? taskDb.addTask(db, { title: 'replacement job', workspaceRoot, metadata: { verify: 'node --test test/x.test.js' } }).id : null;
    let child;
    let confirmations = 0;
    const lines = [];
    let finish;
    const ended = new Promise((resolve) => { finish = resolve; });
    const timer = setTimeout(() => { child?.kill('SIGTERM'); finish({ timeout: true }); }, 15000);
    try {
      let ready = false;
      let clock = Date.now();
      const up = createMemberUp({
        listMembers: () => [{ name: 'executor' }],
        pickTask: () => ready ? task(preview, 'previewed job') : null,
        now: () => clock,
        print: (line) => lines.push(line),
        spawn: (name, onExit, onClaim) => {
          child = memberUpSpawn(root, name, (code, result) => { onExit(code, result); finish({ code }); }, (claimed) => {
            confirmations += 1;
            const row = taskDb.getTask(db, claimed.id);
            assert.equal(row.status, 'claimed');
            assert.equal(row.claimed_by, name);
            assert.equal(claimed.id, actual);
            onClaim(claimed);
            child.kill('SIGTERM');
          });
          return child;
        },
      });
      up.check();
      ready = true;
      clock += 60000;
      up.check();
      assert.deepEqual(lines, ['executor is idle, no task with a check'], 'no announcement at spawn time');
      const result = await ended;
      assert.ok(!result.timeout, 'CLI did not finish');
      assert.equal(confirmations, replacement ? 1 : 0);
      if (replacement) {
        assert.equal(lines[1], 'executor woke up for: replacement job');
        assert.equal(lines[2], 'executor started on: replacement job');
        assert.ok(!lines.some((line) => /previewed job/.test(line)));
      } else {
        assert.equal(result.code, IDLE_EXIT);
        assert.deepEqual(lines, ['executor is idle, no task with a check', 'executor is idle, no task with a check']);
      }
      const output = fs.readFileSync(path.join(root, '.atris', 'state', 'member-up', 'executor.log'), 'utf8');
      t.diagnostic(`command: node bin/atris.js member go executor --needs-check --json; exit: ${result.code}; window: ${lines.join(' | ')}; child output: ${output.trim().slice(0, 400)}`);
    } finally {
      clearTimeout(timer);
      child?.kill('SIGTERM');
      taskDb.close();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
