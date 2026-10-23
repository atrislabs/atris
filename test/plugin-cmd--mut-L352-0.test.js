const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginCommand } = require('../commands/plugin');

test('publish uses the repository supplied as an equals flag', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-repo-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const lines = [];
  const destination = path.join(root, 'chosen-repository');
  t.after(() => {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });
  fs.mkdirSync(path.join(root, 'atris', 'skills'), { recursive: true });
  fs.mkdirSync(destination);
  process.chdir(root);
  process.env.HOME = root;
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const stopped = new Error('exit intercepted');
  t.mock.method(process, 'exit', () => { throw stopped; });
  try {
    pluginCommand('publish', `--repo=${destination}`);
  } catch (error) {
    if (error !== stopped) throw error;
  }
  assert.ok(fs.existsSync(path.join(destination, 'plugins', 'atris-workspace', 'README.md')));
});
