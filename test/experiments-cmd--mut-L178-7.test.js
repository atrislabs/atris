const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('keep reports the measurement stderr when no score is printed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-measure-error-'));
  const cwd = process.cwd();
  const previous = { HOME: process.env.HOME, ATRIS_EXPERIMENTS_PYTHON: process.env.ATRIS_EXPERIMENTS_PYTHON };
  t.after(() => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root;
  // Node accepts --version and can run this JavaScript fixture with a .py suffix.
  // This exercises the real child process without requiring Python to be installed.
  process.env.ATRIS_EXPERIMENTS_PYTHON = process.execPath;
  const pack = path.join(root, 'atris', 'experiments', 'broken-measure');
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, 'measure.py'), "process.stderr.write('diagnostic context\\nmeasurement input missing\\n');\n");
  process.chdir(root);

  const { experimentsCommand } = require('../commands/experiments');
  const errors = [];
  const output = [];
  const exited = new Error('intercepted process exit');
  t.mock.method(console, 'error', (...args) => errors.push(args));
  t.mock.method(console, 'log', (...args) => output.push(args));
  t.mock.method(process, 'exit', (code) => {
    assert.equal(code, 1);
    throw exited;
  });

  assert.throws(() => experimentsCommand('keep', 'broken-measure'), (error) => error === exited);
  assert.deepEqual(errors, [['revert broken-measure: measurement input missing. refuse keep.']]);
  assert.deepEqual(output, [['next: atris experiments revert broken-measure']]);
});
