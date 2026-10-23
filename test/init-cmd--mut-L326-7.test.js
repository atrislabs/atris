const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initAtris } = require('../commands/init');

test('minimal init honors the explicit adapter opt-in', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-adapters-'));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalLog = console.log;
  try {
    process.chdir(root);
    process.argv = [process.execPath, 'atris', 'init', '--minimal', '--with-adapters', '--yes', '--no-commit', '--force'];
    console.log = () => {};

    initAtris();

    // This adapter is deterministic and requires neither git configuration nor a clock.
    assert.equal(
      fs.readFileSync(path.join(root, '.devin', 'config.local.json'), 'utf8'),
      '{\n  "permissions": {\n    "allow": [\n      "Exec(atris)"\n    ]\n  }\n}\n'
    );
  } finally {
    console.log = originalLog;
    process.argv = originalArgv;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
