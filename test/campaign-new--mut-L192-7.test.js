'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { draftAndStart } = require('../lib/campaign-new');

test('confirmation refuses input when stdin stops being a terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-terminal-'));
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  const createInterface = readline.createInterface;
  const error = console.error;
  let reads = 0;
  const output = [];
  try {
    // The terminal is available when confirmation is selected, but stdin is
    // disconnected by the time the confirmation function checks it again.
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      get: () => ++reads === 1,
    });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    readline.createInterface = () => ({
      question: (_question, answer) => answer('yes'),
      close() {},
    });
    console.error = () => {};
    const code = await draftAndStart(['--id', 'terminal-check'], {
      asJson: false,
      judge: async () => ({ passed: false, exit: 1, summary: 'exit 1' }),
      fail: (message) => assert.fail(message),
      out: (human) => output.push(human),
    }, {
      root,
      goal: 'Check terminal confirmation',
      ask: async () => ({ engine: 'fixture', text: JSON.stringify({
        title: 'Terminal check', judge_script: 'exit 1', seats: [],
      }) }),
      start: async (_args, ctx) => { ctx.out('started'); return 0; },
    });
    assert.equal(code, 0);
    assert.deepEqual(output, [
      "not started.\nstart it:  atris campaign start 'Terminal check' --judge 'sh atris/campaigns/terminal-check/judge.sh' --budget 20 --id terminal-check --owner mission-lead\n(or run this again with --yes)",
    ]);
  } finally {
    console.error = error;
    readline.createInterface = createInterface;
    for (const [stream, descriptor] of [[process.stdin, stdinTTY], [process.stderr, stderrTTY]]) {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else delete stream.isTTY;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
