const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginCommand } = require('../commands/plugin');

test('publish with a repository option checks the repository instead of showing help', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-help-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  process.chdir(root);
  process.env.HOME = root;
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const exitSignal = new Error('exit intercepted');
  t.mock.method(process, 'exit', () => { throw exitSignal; });
  try {
    pluginCommand('publish', '--repo=' + path.join(root, 'missing'));
  } catch (error) {
    if (error !== exitSignal) throw error;
  }
  assert.doesNotMatch(lines.join('\n'), /Usage:/i);
});
