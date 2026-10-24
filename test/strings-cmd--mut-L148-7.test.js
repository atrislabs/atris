const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan, loadRegistry } = require('../commands/strings');

test('scan saves the exact relative target directory in the registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strings-scan-root-'));
  const originalCwd = process.cwd();
  const originalLog = console.log;
  try {
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'view.js'), 'const label = "Save changes";\n');
    process.chdir(root);
    console.log = () => {};

    assert.equal(scan(['app', '--json']), 0);
    assert.equal(loadRegistry().root, 'app');
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
