'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const computer = require('../commands/computer');

const NAMES = ['ATRIS_NONINTERACTIVE', 'ATRIS_NO_INTERACTIVE'];

function onTerminal(t) {
  for (const stream of [process.stdin, process.stdout]) {
    const before = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true, writable: true });
    t.after(() => {
      if (before) Object.defineProperty(stream, 'isTTY', before);
      else delete stream.isTTY;
    });
  }
  for (const name of NAMES) {
    const before = process.env[name];
    delete process.env[name];
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
  }
}

test('the computer command prompts on a real terminal when neither name is set', t => {
  onTerminal(t);
  assert.equal(computer.useInteractiveCloudUi(), true);
  assert.equal(computer.useInteractiveTerminalUi(), true);
});

for (const name of NAMES) {
  test(`${name}=1 alone makes the computer command non-interactive`, t => {
    onTerminal(t);
    process.env[name] = '1';
    assert.equal(computer.useInteractiveCloudUi(), false);
    assert.equal(computer.useInteractiveTerminalUi(), false);
  });
}
