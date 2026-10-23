const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cmd = require('../commands/theme');

test('create --mood paper prints the resolved light mode in the preview', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-'));
  const prevCwd = process.cwd();
  const origLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    process.chdir(dir);
    const code = await cmd.run(['create', 'mut', '--mood', 'paper']);
    assert.equal(code, 0);
  } finally {
    console.log = origLog;
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const preview = lines.find((l) => l.includes('·'));
  assert.ok(preview);
  assert.match(preview, /paper light/);
});
