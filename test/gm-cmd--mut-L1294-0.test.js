'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');

test('the interactive v key reports an empty replay and returns to the board', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-replay-key-'));
  const savedEnv = { ...process.env };
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stdout = Object.getOwnPropertyDescriptor(process, 'stdout');
  const input = new PassThrough();
  const writes = [];
  const output = new Writable({
    write(chunk, encoding, done) {
      writes.push(chunk.toString());
      done();
    },
  });
  input.isTTY = true;
  input.setRawMode = () => {};
  output.isTTY = true;
  output.columns = 120;

  try {
    // All persistent state belongs to this test, even with an empty environment.
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_TEST_STATE_DIR = root;
    process.env.ATRIS_TASKS_DB = path.join(root, 'absent-tasks.db');
    // Local civil time makes the exact replay label independent of timezone.
    t.mock.method(Date, 'now', () => new Date(2020, 0, 2, 18).getTime());
    Object.defineProperty(process, 'stdin', { configurable: true, value: input });
    Object.defineProperty(process, 'stdout', { configurable: true, value: output });

    const { gmCommand } = require('../commands/gm');
    const running = gmCommand('--workspace', root);
    // gmCommand has installed its listener and is waiting for the first key.
    // Queue quit as well so both implementations finish without a deadline.
    input.emit('keypress', 'v', { name: 'v' });
    input.emit('keypress', 'q', { name: 'q' });
    await running;
  } finally {
    Object.defineProperty(process, 'stdin', stdin);
    Object.defineProperty(process, 'stdout', stdout);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    input.destroy();
    output.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.deepEqual(
    writes.filter(text => text.startsWith('\nnothing happened since ')),
    ['\nnothing happened since 6:00 am\n'],
  );
});
