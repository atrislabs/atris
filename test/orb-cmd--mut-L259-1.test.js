'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const readline = require('node:readline');

test('an exited running job becomes ready and its result can be opened', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-completion-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const ttyDescriptors = [process.stdin, process.stdout].map((stream) =>
    Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  process.env.HOME = home;
  process.chdir(home);
  [process.stdin, process.stdout].forEach((stream) => {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
  });
  t.after(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    [process.stdin, process.stdout].forEach((stream, index) => {
      if (ttyDescriptors[index]) Object.defineProperty(stream, 'isTTY', ttyDescriptors[index]);
      else delete stream.isTTY;
    });
  });

  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(home, 'now.md'), '# Now\n');
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', () => {});
  t.mock.method(readline, 'clearLine', () => {});
  t.mock.method(readline, 'cursorTo', () => {});

  const terminal = new EventEmitter();
  let announcePrompt;
  const prompted = new Promise((resolve) => { announcePrompt = resolve; });
  terminal.setPrompt = () => {};
  terminal.prompt = () => announcePrompt();
  terminal.pause = () => {};
  terminal.resume = () => {};
  terminal.close = () => terminal.emit('close');
  t.mock.method(readline, 'createInterface', () => terminal);

  const child = new EventEmitter();
  child.unref = () => {};
  t.mock.method(childProcess, 'spawn', (_command, _args, options) => {
    fs.writeSync(options.stdio[1], 'completion result from the worker\n');
    return child;
  });

  const { runOrb } = require('../commands/orb');
  const running = runOrb([]);
  await prompted;
  const enter = terminal.listeners('line')[0];
  try {
    await enter('summarize the release');
    child.emit('exit', 0);
    assert.ok(logs.some((line) => /ready: summarize the release/.test(line)),
      'successful completion should notify the user that the job is ready');
    await enter('o');
    assert.ok(logs.some((line) => line.includes('completion result from the worker')),
      'opening the completed job should show its saved result');
  } finally {
    await enter('q');
    assert.equal(await running, 0);
  }
});
