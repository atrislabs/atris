const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginCommand } = require('../commands/plugin');

test('publish writes the current package version into the plugin manifest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-publish-version-'));
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
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.3.4' }));
  const repo = path.join(root, 'repository');
  fs.mkdirSync(path.join(repo, 'plugins', 'atris-workspace', '.claude-plugin'), { recursive: true });
  const manifest = path.join(repo, 'plugins', 'atris-workspace', '.claude-plugin', 'plugin.json');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'atris', version: '1.0.0' }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'exit', code => { throw new Error(`command exited with ${code}`); });
  pluginCommand('publish', '--repo=' + repo);
  assert.strictEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).version, '2.3.4');
});
