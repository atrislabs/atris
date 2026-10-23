const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const theme = require('../commands/theme');

test('theme create rejects an unknown font personality with the exact diagnostic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-invalid-font-'));
  const previousCwd = process.cwd();
  const previousError = console.error;
  const previousLog = console.log;
  const errors = [];
  const output = [];
  try {
    process.chdir(dir);
    console.error = (...args) => errors.push(args);
    console.log = (...args) => output.push(args);

    const code = await theme.run(['create', 'brand', '--fonts', 'unknown-font', '--yes']);

    assert.deepEqual(errors, [[
      '  unknown font personality "unknown-font". try: editorial-serif, clean-sans, mono-forward',
    ]]);
    assert.equal(code, 2);
    assert.deepEqual(output, []);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    console.error = previousError;
    console.log = previousLog;
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
