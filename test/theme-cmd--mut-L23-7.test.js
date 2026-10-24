require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('create accepts -y before the theme name without treating it as the name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-yes-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const theme = require('../commands/theme');
    const code = await theme.run(['create', '-y', 'brand']);
    const file = path.join(dir, '.atris', 'theme.json');
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    assert.ok(saved.themes?.brand, 'the requested brand theme should be saved when -y precedes its name');
    assert.equal(code, 0);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
  }
});
