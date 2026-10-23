'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { benchCommand } = require('../commands/bench');

test('bench help flags print help outside the CLI repo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-help-'));
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const expected = [
    'Usage: atris bench run [--pack <id>] [--engine <name>] [--model <id>] [--task <id> ...] [--label baseline|candidate] [--experiment <id>] [--update-baseline] [--json]',
    'Usage: atris bench pair --candidate <dir|git-ref> [--pack <id>] [--engine <name>] [--model <id>] [--task <id> ...] [--min-win-margin <n>] [--repeats <n>] [--current <dir>] [--json]',
    'Usage: atris bench results [--last N] [--json]',
    'Usage: atris bench tasks [--pack <id>] [--json]',
    'Usage: atris bench packs [--json]',
    'Usage: atris bench report [--pack agents-v1] [--json]',
    'packs: core-v1, agents-v1, harness-v1',
    '',
    'Bench runs product gates and only belongs in the atris CLI repo.',
    'Pass --here to allow running outside that repo.',
  ];
  try {
    process.chdir(root);
    for (const flag of ['--help', '-h']) {
      const stdout = [];
      const stderr = [];
      console.log = (...args) => stdout.push(args);
      console.error = (...args) => stderr.push(args);
      const exitCode = await benchCommand([flag]);
      assert.deepEqual(stdout, expected.map((line) => [line]), flag);
      assert.deepEqual(stderr, [], flag);
      assert.equal(exitCode, 0, flag);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
