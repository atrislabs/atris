'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

test('interview without a subject opens an operator warm start', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-operator-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  fs.mkdirSync(path.join(home, 'atris'));
  const context = path.join(home, 'atris', 'now.md');
  fs.writeFileSync(context, 'The operator is preparing a workshop.\n');

  let prompt;
  t.mock.method(childProcess, 'spawn', (_command, args) => {
    prompt = args[0];
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'exit', (code) => {
    throw new Error(`unexpected exit: ${code}`);
  });

  try {
    process.env.HOME = home;
    process.chdir(home);
    const { interviewCommand } = require('../commands/interview');
    const result = await interviewCommand(['--yes']);

    assert.equal(result, 0);
    assert.match(prompt, /Mode: OPERATOR WARM START/);
    assert.ok(prompt.includes(context), 'operator context is included in the interview');
    assert.ok(output.some((line) => line.includes('you, from your logs')));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    t.mock.restoreAll();
  }
});
