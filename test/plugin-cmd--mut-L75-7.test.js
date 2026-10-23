const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginCommand } = require('../commands/plugin');

test('publish writes a setup guide that installs the CLI only when missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mut-l75-'));
  const projectDir = path.join(root, 'project');
  const marketDir = path.join(root, 'market');
  fs.mkdirSync(path.join(projectDir, 'atris', 'skills'), { recursive: true });
  fs.mkdirSync(marketDir, { recursive: true });

  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root;
  process.chdir(projectDir);
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  pluginCommand('publish', '--repo=' + marketDir);

  const setupPath = path.join(marketDir, 'plugins', 'atris-workspace', 'commands', 'atris-setup.md');
  const guardLine = fs.readFileSync(setupPath, 'utf8')
    .split('\n')
    .find((line) => line.includes('command -v'));
  assert.ok(guardLine, 'setup guide should contain the CLI presence check');
  assert.match(guardLine, /\|\| npm install -g/);
});
