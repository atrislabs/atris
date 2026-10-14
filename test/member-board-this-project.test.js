const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { readBoard, teamHere } = require('../lib/member-board');

const cliPath = path.join(path.resolve(__dirname, '..'), 'bin', 'atris.js');
const recent = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();

// One progress folder shared by two projects: builder and validator belong
// here, payments-infra belongs to some other repo on the same computer.
function setup() {
  const progress = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-progress-'));
  const lines = {
    builder: [`${recent(60)} m-1 started: build the thing`, `${recent(10)} m-1 editing lib/a.js`],
    validator: [`${recent(50)} m-2 started: check the thing`, `${recent(20)} m-2 reading lib/a.js`],
    'payments-infra': [`${recent(40)} m-9 started: another repo's job`, `${recent(5)} m-9 editing pay.js`],
  };
  for (const [name, rows] of Object.entries(lines)) {
    fs.writeFileSync(path.join(progress, `${name}.log`), rows.map((l) => `${l}\n`).join(''));
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-project-'));
  for (const name of ['builder', 'validator', '_template']) {
    fs.mkdirSync(path.join(project, 'atris', 'team', name), { recursive: true });
  }
  fs.writeFileSync(path.join(project, 'atris', 'team', 'START_HERE.md'), 'not a member\n');
  return { progress, project, env: { ...process.env, ATRIS_PROGRESS_DIR: progress } };
}

const board = (args, { project, env }) =>
  spawnSync(process.execPath, [cliPath, 'member', 'board', ...args], { cwd: project, env, encoding: 'utf8' });

test('team here is the member folders under atris/team, null outside a project', () => {
  const { project } = setup();
  assert.deepEqual(teamHere(project).sort(), ['builder', 'validator']);
  assert.equal(teamHere(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-none-'))), null);
});

test('readBoard with only drops logs from other projects', () => {
  const { progress } = setup();
  const names = readBoard({ dir: progress, only: ['builder', 'validator'] }).map((r) => r.member).sort();
  assert.deepEqual(names, ['builder', 'validator']);
  assert.equal(readBoard({ dir: progress }).length, 3);
});

test('member board in a project shows only that project\'s members', () => {
  const ctx = setup();
  const res = board([], ctx);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /builder/);
  assert.match(res.stdout, /validator/);
  assert.doesNotMatch(res.stdout, /payments-infra/);

  const json = board(['--json'], ctx);
  assert.equal(json.status, 0, json.stderr);
  const names = JSON.parse(json.stdout).members.map((r) => r.member).sort();
  assert.deepEqual(names, ['builder', 'validator']);
});

test('member board outside a project still shows every member', () => {
  const ctx = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-outside-'));
  const res = board(['--json'], { ...ctx, project: outside });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).members.length, 3);
});

test('follow stream in a project skips other projects\' new lines', async () => {
  const ctx = setup();
  const child = spawn(process.execPath, [cliPath, 'member', 'board', '--json', '--follow'], { cwd: ctx.project, env: ctx.env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const waitForOutput = async (check) => {
    const deadline = Date.now() + 5000;
    while (!check() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(check(), `expected board output before timeout: ${out}`);
  };
  try {
    await waitForOutput(() => out.includes('\n'));
    fs.appendFileSync(path.join(ctx.progress, 'payments-infra.log'), `${recent(0)} m-9 editing other.js\n`);
    fs.appendFileSync(path.join(ctx.progress, 'builder.log'), `${recent(0)} m-1 editing mine.js\n`);
    await waitForOutput(() => out.split('\n').slice(0, -1).some((line) => line.includes('mine.js')));
  } finally {
    child.kill('SIGINT');
  }
  const events = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events[0].members.map((r) => r.member).sort(), ['builder', 'validator']);
  assert.ok(events.some((e) => e.member === 'builder' && e.text === 'editing mine.js'));
  assert.ok(!events.some((e) => e.member === 'payments-infra'));
});
