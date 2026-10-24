'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const readline = require('node:readline');

test('interactive review selection preserves its category in dispatch history', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-category-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.PATH = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris.md'), '# atris\n');
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [{ display_id: 'TEST-1', title: 'Check the proof', status: 'review' }],
    }));
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const output = [];
    t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
    t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
    t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit ${code}`); });
    const writes = [];
    const appendFile = fs.promises.appendFile.bind(fs.promises);
    t.mock.method(fs.promises, 'appendFile', (...args) => {
      const write = appendFile(...args);
      writes.push(write);
      return write;
    });
    let child;
    // Stand in for the external process before the command captures spawn.
    t.mock.method(childProcess, 'spawn', () => {
      child = new EventEmitter();
      child.pid = 12345;
      child.unref = () => {};
      return child;
    });
    t.mock.method(readline, 'createInterface', () => {
      const terminal = new EventEmitter();
      const lines = ['1', 'q'];
      terminal.setPrompt = terminal.pause = terminal.resume = () => {};
      terminal.prompt = () => {
        queueMicrotask(() => {
          const line = lines.shift();
          if (!line) return;
          if (line === 'q') {
            terminal.emit('line', line);
            child.emit('exit', 0);
          } else terminal.emit('line', line);
        });
      };
      terminal.close = () => terminal.emit('close');
      return terminal;
    });
    const { runOrb } = require('../commands/orb');
    await runOrb([]);
    await Promise.all(writes);
    const history = fs.readFileSync(path.join(root, '.atris', 'state', 'orb-runs', 'index.jsonl'), 'utf8');
    const completed = history.trim().split('\n').map(JSON.parse).find((row) => row.status === 'ready');
    assert.strictEqual(completed.kind, 'review');
  } finally {
    t.mock.restoreAll();
    if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY);
    else delete process.stdin.isTTY;
    if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY);
    else delete process.stdout.isTTY;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
