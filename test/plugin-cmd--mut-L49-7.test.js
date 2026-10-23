const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pluginCommand } = require('../commands/plugin');

test('building preserves the name in an object-form package author', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-author-'));
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
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    version: '2.3.4', author: { name: 'Morgan Rivera', email: 'morgan@example.com' }
  }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(process, 'exit', code => { throw new Error(`command exited with ${code}`); });

  pluginCommand('build');

  assert.strictEqual(JSON.parse(execFileSync('/usr/bin/unzip', ['-p', path.join(root, 'atris-workspace.plugin'), '.claude-plugin/plugin.json'], { encoding: 'utf8' })).author.name, 'Morgan Rivera');
});
