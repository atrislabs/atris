const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { speakFirstMinute } = require('../lib/first-minute');

function makeRoom() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-speak-fm-'));
  const home = path.join(base, 'home');
  const room = path.join(base, 'my-room');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(room, { recursive: true });
  return { base, home, room };
}

function captureLog() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)) };
}

// Speak reads process.env for the operator name and the saved account. Point
// HOME at a throwaway dir, clear ambient ATRIS_* vars, and fix the operator so
// the greeting is the same on any machine.
function withCleanEnv(home, fn) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.env.ATRIS_OPERATOR = 'dev';
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('fresh empty folder speaks empty and points at the first talk', (t) => {
  const { base, home, room } = makeRoom();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { lines, log } = captureLog();
  const code = withCleanEnv(home, () => speakFirstMinute({ root: room, fresh: true, log }));
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    '',
    'hey dev, my-room is empty.\n\nnext: atris "what do you want here?"',
  ]);
});

test('fresh folder names one visible file and points at do', (t) => {
  const { base, home, room } = makeRoom();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { lines, log } = captureLog();
  const code = withCleanEnv(home, () => speakFirstMinute({ root: room, fresh: true, files: ['notes.txt'], log }));
  assert.equal(code, 0);
  assert.equal(lines[0], '');
  assert.match(lines[1], /notes\.txt is already here\./);
  assert.match(lines[1], /next: atris do$/);
});

test('dotfiles and local store noise are not spoken as visible work', (t) => {
  const { base, home, room } = makeRoom();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { lines, log } = captureLog();
  const code = withCleanEnv(home, () => speakFirstMinute({
    root: room,
    fresh: true,
    files: ['.hidden', 'tasks.db', 'tasks.db-wal', 'notes.txt'],
    log,
  }));
  assert.equal(code, 0);
  assert.match(lines[1], /notes\.txt is already here\./);
  assert.doesNotMatch(lines[1], /\.hidden|tasks\.db/);
});

test('json mode on a fresh folder reports stuck and returns 2', (t) => {
  const { base, home, room } = makeRoom();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { lines, log } = captureLog();
  const code = withCleanEnv(home, () => speakFirstMinute({ root: room, fresh: true, asJson: true, log }));
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.schema, 'atris.one_lap.v1');
  assert.equal(payload.ok, false);
  assert.equal(payload.status, 'stuck');
  assert.equal(payload.reason, 'my-room is empty');
  assert.equal(payload.next_action, 'atris "what do you want here?"');
});

test('workspace with nothing live says set up and points at the first step', (t) => {
  const { base, home, room } = makeRoom();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { lines, log } = captureLog();
  const code = withCleanEnv(home, () => speakFirstMinute({ root: room, fresh: false, log }));
  assert.equal(code, 0);
  assert.match(lines[1], /hey dev, my-room is set up\./);
  assert.match(lines[1], /next: atris "help me choose the first useful step for this project"$/);
});

test('json flag is ignored when the folder is not fresh', (t) => {
  const { base, home, room } = makeRoom();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { lines, log } = captureLog();
  const code = withCleanEnv(home, () => speakFirstMinute({ root: room, fresh: false, asJson: true, log }));
  assert.equal(code, 0);
  assert.equal(lines[0], '');
  assert.match(lines[1], /my-room is set up\./);
});
