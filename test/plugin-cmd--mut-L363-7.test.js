const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginCommand } = require('../commands/plugin');

test('publish fails when repository path does not exist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-repo-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;

  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  process.env.HOME = root;
  process.chdir(root);

  fs.mkdirSync(path.join(root, 'atris', 'skills'), { recursive: true });

  t.mock.method(console, 'log', () => {});

  const errLines = [];
  t.mock.method(console, 'error', (...args) => errLines.push(args.join(' ')));

  const exitCodes = [];
  const exitSignal = new Error('intercepted exit');
  t.mock.method(process, 'exit', (code) => {
    exitCodes.push(code);
    throw exitSignal;
  });

  const missingDir = path.join(root, 'missing-repo');

  assert.throws(
    () => pluginCommand('publish', `--repo=${missingDir}`),
    (err) => err === exitSignal
  );

  assert.strictEqual(exitCodes[0], 1);
  assert.match(errLines.join('\n'), /Marketplace repo not found/);
});
