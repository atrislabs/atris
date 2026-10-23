const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installCommand } = require('../commands/install');

test('install prints the exact files created in a fresh workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-install-output-'));
  const cwd = process.cwd();
  const originalLog = console.log;
  const OriginalDate = global.Date;
  const envKeys = ['HOME', 'ATRIS_HOME', 'ATRIS_TASKS_DB'];
  const savedEnv = envKeys.map((key) => [key, process.env[key]]);
  const output = [];
  try {
    process.chdir(root);
    process.env.HOME = root;
    process.env.ATRIS_HOME = path.join(root, '.atris-home');
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    // A local calendar constructor gives the same journal name in every timezone.
    global.Date = class extends OriginalDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(2024, 0, 15, 12, 0, 0);
      }
    };
    console.log = (...args) => output.push(args);
    assert.equal(installCommand([]), 0);
    assert.deepEqual(output, [
      ['atris/wiki/index.md'],
      ['atris/MAP.md'],
      ['atris/TODO.md'],
      ['atris/now.md'],
      ['atris/logs/2024/2024-01-15.md'],
      ['atris/team/'],
      ['atris/atris.md'],
    ]);
  } finally {
    console.log = originalLog;
    global.Date = OriginalDate;
    process.chdir(cwd);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
