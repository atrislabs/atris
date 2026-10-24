require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('revert without a pack name shows usage', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-experiment-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const lines = [];
  const exit = new Error('command exit');
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  t.mock.method(process, 'exit', () => {
    throw exit;
  });
  const { experimentsCommand } = require('../commands/experiments');

  try {
    experimentsCommand('revert');
  } catch (error) {
    if (error !== exit) throw error;
  }

  assert.ok(lines.some((line) => /usage:.*experiments/i.test(line)));
});
