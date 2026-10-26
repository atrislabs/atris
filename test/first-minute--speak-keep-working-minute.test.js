const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { speakKeepWorkingMinute } = require('../lib/first-minute');

const FIRST_USE = 'atris "help me choose the first useful step for this project"';
const WHATS_NEXT = 'atris "what\'s next?"';
const OLD_MS = Date.UTC(2020, 0, 1);
const LATER_MS = Date.UTC(2020, 0, 2);

const savedEnv = { ...process.env };
let base;

test.before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'speak-keep-working-'));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.ATRIS_OPERATOR = 'sam';
  process.env.ATRIS_TASKS_DB = path.join(base, 'no-such-dir', 'tasks.db');
});

test.after(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(base, { recursive: true, force: true });
});

let roomCount = 0;

// A fresh folder named "bakery" so the spoken folder name is stable.
function makeRoom() {
  roomCount += 1;
  const root = path.join(base, `room-${roomCount}`, 'bakery');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function writeTasks(root, tasks) {
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.projection.json'), JSON.stringify({ tasks }), 'utf8');
}

function speak(options) {
  const lines = [];
  const code = speakKeepWorkingMinute({ ...options, log: (line) => lines.push(line) });
  return { code, lines };
}

test('empty folder points at the first useful step', () => {
  const root = makeRoom();
  const { code, lines } = speak({ root });
  assert.strictEqual(code, 0);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], '');
  assert.strictEqual(lines[1], `hey sam, bakery is set up.\n\nnext: ${FIRST_USE}`);
});

test('folder that does not exist still answers instead of throwing', () => {
  const root = path.join(base, 'never-made', 'bakery');
  const { code, lines } = speak({ root });
  assert.strictEqual(code, 0);
  assert.strictEqual(lines[0], '');
  assert.match(lines[1], /^hey sam, bakery is set up\./);
  assert.ok(lines[1].endsWith(`next: ${FIRST_USE}`));
  assert.strictEqual(fs.existsSync(root), false);
});

test('empty folder in json mode prints one started record with no task', () => {
  const root = makeRoom();
  const { code, lines } = speak({ root, asJson: true });
  assert.strictEqual(code, 0);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), {
    schema: 'atris.one_lap.v1',
    ok: true,
    status: 'started',
    reason: 'bakery is set up',
    next_action: FIRST_USE,
    task: null,
  });
});

test('open task is offered to claim under the operator name', () => {
  const root = makeRoom();
  writeTasks(root, [
    { display_id: 'T-1', title: 'Write the menu.', status: 'open', updated_at: 10 },
  ]);
  const { code, lines } = speak({ root });
  assert.strictEqual(code, 0);
  assert.strictEqual(
    lines[1],
    'hey sam, "write the menu" is ready to claim.\n\nnext: atris task claim T-1 --as sam',
  );
});

test('json mode carries the task id and title and a reason without the greeting', () => {
  const root = makeRoom();
  writeTasks(root, [
    { display_id: 'T-1', title: 'Write the menu.', status: 'open', updated_at: 10 },
  ]);
  const { code, lines } = speak({ root, asJson: true });
  assert.strictEqual(code, 0);
  const out = JSON.parse(lines[0]);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.status, 'started');
  assert.strictEqual(out.reason, '"write the menu" is ready to claim');
  assert.strictEqual(out.next_action, 'atris task claim T-1 --as sam');
  assert.deepStrictEqual(out.task, { display_id: 'T-1', title: 'Write the menu.' });
});

test('newest open task wins when two are waiting', () => {
  const root = makeRoom();
  writeTasks(root, [
    { display_id: 'T-1', title: 'Old chore', status: 'open', updated_at: 10 },
    { display_id: 'T-2', title: 'Fresh chore', status: 'open', updated_at: 20 },
  ]);
  const { lines } = speak({ root });
  assert.match(lines[1], /"fresh chore" is ready to claim\./);
  assert.ok(lines[1].endsWith('next: atris task claim T-2 --as sam'));
});

test('claimed task gets the ready-with-verify command', () => {
  const root = makeRoom();
  writeTasks(root, [
    { display_id: 'T-3', title: 'Bake bread', status: 'claimed', updated_at: 10 },
  ]);
  const { code, lines } = speak({ root });
  assert.strictEqual(code, 0);
  assert.strictEqual(
    lines[1],
    'hey sam, "bake bread" is already yours.\n\nnext: atris "add a test for the claimed task"',
  );
});

test('claimed work beats an open task, and a certified review beats claimed work', () => {
  const root = makeRoom();
  writeTasks(root, [
    { display_id: 'T-4', title: 'Open one', status: 'open', updated_at: 30 },
    { display_id: 'T-5', title: 'Claimed one', status: 'claimed', updated_at: 20 },
  ]);
  assert.ok(speak({ root }).lines[1].endsWith('next: atris "add a test for the claimed task"'));

  writeTasks(root, [
    { display_id: 'T-4', title: 'Open one', status: 'open', updated_at: 30 },
    { display_id: 'T-5', title: 'Claimed one', status: 'claimed', updated_at: 20 },
    {
      display_id: 'T-6',
      title: 'Checked one',
      status: 'review',
      updated_at: 10,
      metadata: { agent_certified: true },
    },
  ]);
  const { lines } = speak({ root });
  assert.strictEqual(
    lines[1],
    'hey sam, something finished. waiting on you.\n\nnext: atris task accept T-6',
  );
});

test('latest recap in atris/reports is named under the win line', () => {
  const root = makeRoom();
  writeTasks(root, [
    { display_id: 'T-1', title: 'Write the menu', status: 'open', updated_at: 10 },
  ]);
  const reports = path.join(root, 'atris', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, 'week-recap.md'), '# Weekly recap\n\nbody\n', 'utf8');
  const { lines } = speak({ root });
  assert.strictEqual(
    lines[1],
    'hey sam, "write the menu" is ready to claim.\nlast recap: Weekly recap.\n\nnext: atris task claim T-1 --as sam',
  );
});

test('starter task with files written since it was claimed says atris done', () => {
  const root = makeRoom();
  writeTasks(root, [
    {
      display_id: 'T-7',
      title: 'A page for the bakery.',
      status: 'claimed',
      claimed_at: OLD_MS,
      updated_at: OLD_MS,
      metadata: { source: 'context_gatherer' },
    },
  ]);
  const page = path.join(root, 'index.html');
  const notes = path.join(root, 'notes.txt');
  fs.writeFileSync(page, '<h1>hi</h1>', 'utf8');
  fs.writeFileSync(notes, 'hi', 'utf8');
  fs.utimesSync(page, LATER_MS / 1000, LATER_MS / 1000);
  fs.utimesSync(notes, LATER_MS / 1000, LATER_MS / 1000);

  const { code, lines } = speak({ root });
  assert.strictEqual(code, 0);
  assert.strictEqual(
    lines[1],
    'hey sam, A page for the bakery has new work: index.html, notes.txt.\n\nnext: atris done',
  );

  const json = speak({ root, asJson: true });
  const out = JSON.parse(json.lines[0]);
  assert.strictEqual(out.next_action, 'atris done');
  assert.strictEqual(out.reason, 'A page for the bakery has new work: index.html, notes.txt');
  assert.deepStrictEqual(out.task, { display_id: 'T-7', title: 'A page for the bakery.' });
});

test('shipped starter task asks what is next and reports no task in json', () => {
  const root = makeRoom();
  writeTasks(root, [
    {
      display_id: 'T-8',
      title: 'A page for the bakery.',
      status: 'done',
      updated_at: 10,
      metadata: { source: 'context_gatherer' },
    },
  ]);
  const { code, lines } = speak({ root });
  assert.strictEqual(code, 0);
  assert.strictEqual(
    lines[1],
    `hey sam, you already shipped A page for the bakery.\n\nnext: ${WHATS_NEXT}`,
  );

  const out = JSON.parse(speak({ root, asJson: true }).lines[0]);
  assert.strictEqual(out.next_action, WHATS_NEXT);
  assert.strictEqual(out.task, null);
});

test('broken task file is ignored and the folder reads as empty', () => {
  const root = makeRoom();
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.projection.json'), '{ not json', 'utf8');
  const { code, lines } = speak({ root });
  assert.strictEqual(code, 0);
  assert.strictEqual(lines[1], `hey sam, bakery is set up.\n\nnext: ${FIRST_USE}`);
});

test('looking writes nothing into the folder', () => {
  const root = makeRoom();
  speak({ root });
  speak({ root, asJson: true });
  assert.deepStrictEqual(fs.readdirSync(root), []);
  assert.strictEqual(fs.existsSync(process.env.ATRIS_TASKS_DB), false);
});

test('prints through console.log when no log function is given', () => {
  const root = makeRoom();
  const seen = [];
  const original = console.log;
  console.log = (line) => seen.push(line);
  let code;
  try {
    code = speakKeepWorkingMinute({ root });
  } finally {
    console.log = original;
  }
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(seen, ['', `hey sam, bakery is set up.\n\nnext: ${FIRST_USE}`]);
});
