const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginCommand } = require('../commands/plugin');

test('building without skills warns that the plugin will be empty', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-empty-build-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  process.env.HOME = root;
  process.chdir(root);
  fs.mkdirSync(path.join(root, 'atris', 'skills'), { recursive: true });

  const lines = [];
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => lines.push(args.join(' ')));
  }
  t.mock.method(process, 'exit', (code) => {
    throw new Error(`unexpected exit: ${code}`);
  });

  pluginCommand('build');

  assert.ok(lines.some((line) => /no skills found/i.test(line)
    && /plugin will be empty/i.test(line)),
  'an empty build should warn the user that the plugin will be empty');
});
