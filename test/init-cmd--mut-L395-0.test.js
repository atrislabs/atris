const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const [run] = Object.values(require('../commands/init'));

test('stops when parent directory is an existing workspace', () => {
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'test-workspace-')));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalError = console.error;
  const originalLog = console.log;

  const errors = [];
  let exitCode = null;

  try {
    process.env.HOME = tempDir;

    fs.mkdirSync(path.join(tempDir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.atris', 'business.json'), '{}');

    const deepDir = path.join(tempDir, 'a', 'b');
    fs.mkdirSync(deepDir, { recursive: true });
    process.chdir(deepDir);

    process.argv = ['node', 'atris'];

    console.error = (...args) => {
      errors.push(args.join(' '));
    };
    console.log = () => {};

    process.exit = (code) => {
      exitCode = code;
      throw new Error(`exit:${code}`);
    };

    try {
      run();
    } catch (err) {
      if (!err.message.startsWith('exit:')) {
        throw err;
      }
    }

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(errors.some(msg => msg.includes('already an atris workspace')), true);
  } finally {
    process.chdir(originalCwd);
    process.argv = originalArgv;
    process.exit = originalExit;
    console.error = originalError;
    console.log = originalLog;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
