'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');

test('the club run key opens the member prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-club-key-'));
  const env = { ...process.env };
  const cwd = process.cwd();
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
  output.columns = 100;
  const nextTurn = () => new Promise(resolve => setImmediate(resolve));
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_HOME = path.join(root, '.atris');
    process.env.ATRIS_TASKS_DB = path.join(root, 'absent.db');
    process.chdir(root);
    Object.defineProperty(process, 'stdin', { configurable: true, value: input });
    Object.defineProperty(process, 'stdout', { configurable: true, value: output });
    const { gmCommand } = require('../commands/gm');
    const running = gmCommand('--workspace', root, '--no-seed');
    input.emit('keypress', 'r', { name: 'r' });
    await nextTurn();
    // An empty member cancels the action before any command can run.
    input.write('\n');
    await nextTurn();
    input.write('\n');
    await nextTurn();
    input.emit('keypress', 'q', { name: 'q' });
    await running;
    assert.equal(writes.some(text => /run which member\?/.test(text)), true);
  } finally {
    Object.defineProperty(process, 'stdin', stdin);
    Object.defineProperty(process, 'stdout', stdout);
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    input.destroy();
    output.destroy();
  }
});
