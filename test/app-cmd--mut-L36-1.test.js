require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appCommand } = require('../commands/app');

test('app list finds workspace apps from a nested working folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-app-parent-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const lines = [];

  try {
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# workspace\n');
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };

    await appCommand('init', 'parent-workspace-app');
    const nested = path.join(root, 'src', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    lines.length = 0;

    await appCommand('list');

    assert.ok(
      lines.some((line) => line.includes('parent-workspace-app')),
      'listing from a nested folder should include the app in its parent workspace',
    );
  } finally {
    process.chdir(previousCwd);
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
