const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installCommand } = require('../commands/install');

test('workspace rejects an unknown subcommand with exact usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-install-invalid-'));
  const originalCwd = process.cwd();
  const originalError = console.error;
  const originalLog = console.log;
  const originalExit = process.exit;
  const errors = [];
  const output = [];
  const exitSignal = new Error('exit intercepted');
  let exitCode;
  try {
    // A complete workspace keeps the alternate branch free of installation writes.
    for (const rel of ['MAP.md', 'TODO.md', 'now.md', 'atris.md', 'wiki/index.md', 'logs/existing.md']) {
      const file = path.join(root, 'atris', rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
    fs.mkdirSync(path.join(root, 'atris', 'team'));
    process.chdir(root);
    console.error = (...args) => errors.push(args);
    console.log = (...args) => output.push(args);
    process.exit = (code) => {
      exitCode = code;
      throw exitSignal;
    };
    try {
      installCommand(['unknown'], { verb: 'workspace' });
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.deepEqual(errors, [['Usage: atris workspace install']]);
    assert.deepEqual(output, []);
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    console.log = originalLog;
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
