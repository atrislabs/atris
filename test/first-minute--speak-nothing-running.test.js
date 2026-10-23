'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { speakNothingRunning } = require('../lib/first-minute');

const NOTHING = 'hey ada, nothing is running.\n\nnext: atris "what do you want here?"';
const NOTHING_JSON = {
  schema: 'atris.one_lap.v1',
  ok: false,
  status: 'stuck',
  reason: 'nothing is running',
  next_action: 'atris "what do you want here?"',
};

function capture() {
  const lines = [];
  return {
    lines,
    log(line) {
      lines.push(line);
    },
  };
}

function withRoom(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-speak-nothing-'));
  const home = path.join(root, 'home');
  const room = path.join(root, 'room');
  fs.mkdirSync(home);
  fs.mkdirSync(room);

  const managed = new Set(['HOME', 'USER', 'LOGNAME']);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_') || key.startsWith('GIT_')) managed.add(key);
  }
  const saved = new Map();
  for (const key of managed) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.HOME = home;
  process.env.USER = 'ada';
  process.env.LOGNAME = 'ada';
  process.env.ATRIS_TEST_STATE_DIR = home;

  try {
    run(room);
  } finally {
    for (const key of managed) {
      if (saved.has(key)) process.env[key] = saved.get(key);
      else delete process.env[key];
    }
    delete process.env.ATRIS_TEST_STATE_DIR;
    if (saved.has('ATRIS_TEST_STATE_DIR')) {
      process.env.ATRIS_TEST_STATE_DIR = saved.get('ATRIS_TEST_STATE_DIR');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertNothingRunning(root, extra = {}) {
  const spoken = capture();
  const code = speakNothingRunning({ root, log: spoken.log, ...extra });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(spoken.lines, ['', NOTHING]);

  const json = capture();
  const jsonCode = speakNothingRunning({ root, asJson: true, log: json.log, ...extra });
  assert.strictEqual(jsonCode, 2);
  assert.deepStrictEqual(json.lines, [JSON.stringify(NOTHING_JSON, null, 2)]);
}

test('an empty folder says nothing is running', () => {
  withRoom((room) => {
    assertNothingRunning(room);
    assert.strictEqual(fs.existsSync(path.join(room, 'atris')), false);
    assert.strictEqual(fs.existsSync(path.join(room, '.atris')), false);
  });
});

test('a file already here is named, and a saved note stays open', () => {
  withRoom((room) => {
    fs.writeFileSync(path.join(room, 'notes.txt'), 'already writing\n', 'utf8');

    const spoken = capture();
    const code = speakNothingRunning({ root: room, log: spoken.log });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(spoken.lines, [
      '',
      'hey ada, notes.txt is already here.\n\nnext: atris do',
    ]);

    const json = capture();
    const jsonCode = speakNothingRunning({ root: room, asJson: true, log: json.log });
    assert.strictEqual(jsonCode, 2);
    assert.deepStrictEqual(json.lines, [JSON.stringify({
      schema: 'atris.one_lap.v1',
      ok: false,
      status: 'stuck',
      reason: 'notes.txt is already here',
      next_action: 'atris do',
    }, null, 2)]);
    assert.strictEqual(fs.existsSync(path.join(room, 'atris')), false);
  });

  withRoom((room) => {
    fs.writeFileSync(path.join(room, '.atris-later'), 'buy milk\nnot this line\n', 'utf8');

    const spoken = capture();
    const code = speakNothingRunning({ root: room, log: spoken.log });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(spoken.lines, [
      '',
      'hey ada, buy milk is still open.\n\nnext: atris do',
    ]);

    const many = capture();
    const manyCode = speakNothingRunning({
      root: room,
      files: ['nested/c.txt', 'a.txt', 'b.txt'],
      log: many.log,
    });
    assert.strictEqual(manyCode, 0);
    assert.deepStrictEqual(many.lines, [
      '',
      'hey ada, buy milk is still open.\n\nnext: atris',
    ]);
  });

  withRoom((room) => {
    const spoken = capture();
    const code = speakNothingRunning({
      root: room,
      files: ['nested/c.txt', 'a.txt', 'b.txt'],
      log: spoken.log,
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(spoken.lines, [
      '',
      'hey ada, this folder already has work.\n\nnext: atris do',
    ]);
  });
});

test('a missing folder, a blank note, and hidden names still say nothing is running', () => {
  withRoom((room) => {
    assertNothingRunning(path.join(room, 'no-such-folder'));
    assertNothingRunning('');

    const notDir = path.join(room, 'not-a-directory');
    fs.writeFileSync(notDir, 'plain file\n', 'utf8');
    assertNothingRunning(notDir);
  });

  withRoom((room) => {
    fs.writeFileSync(path.join(room, '.atris-later'), '!!!\n', 'utf8');
    fs.writeFileSync(path.join(room, '.secret'), 'hidden\n', 'utf8');
    fs.writeFileSync(path.join(room, 'tasks.db'), 'db\n', 'utf8');
    fs.writeFileSync(path.join(room, 'tasks.db-wal'), 'wal\n', 'utf8');
    fs.mkdirSync(path.join(room, 'empty-dir'));
    fs.writeFileSync(path.join(room, 'notes.txt'), 'on disk\n', 'utf8');

    assertNothingRunning(room, { files: ['.secret', 'tasks.db', ''] });
  });
});
