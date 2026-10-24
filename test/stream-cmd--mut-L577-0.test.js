'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a live refresh replaces the cached work assignment', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-assignment-refresh-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const signals = ['SIGINT', 'SIGTERM'];
  const listeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
  process.env.HOME = root;
  process.chdir(root);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome !== undefined) process.env.HOME = previousHome;
    for (const [stream, descriptor] of [[process.stdin, inputTTY], [process.stdout, outputTTY]]) {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else delete stream.isTTY;
    }
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.get(signal).includes(listener)) process.removeListener(signal, listener);
      }
    }
  });
  const { streamCommand, collectSnapshot } = require('../commands/stream');
  let refresh;
  t.mock.method(global, 'setInterval', (callback) => {
    refresh = callback;
    return { unref() {} };
  });
  t.mock.method(console, 'log', () => {});
  let assignment = 'prepare release';
  const deps = {
    now: () => Date.parse('2026-07-06T12:00:00Z'),
    listWorktrees: () => [],
    watch: () => ({ close() {} }),
    runGit(cwd, args) {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${root}\n` };
      if (args[0] === 'config') {
        return { status: 0, stdout: `branch.release.atris-owner builder\nbranch.release.atris-task ${assignment}\n` };
      }
      return { status: 1, stdout: '' };
    },
  };
  streamCommand([], deps);
  const snapshot = () => collectSnapshot({ root, deps, skipLanding: true });
  assert.equal(snapshot().active.find(([owner]) => owner === 'builder')?.[1], assignment);
  assignment = 'check release';
  refresh();
  assert.equal(snapshot().active.find(([owner]) => owner === 'builder')?.[1], assignment);
});
