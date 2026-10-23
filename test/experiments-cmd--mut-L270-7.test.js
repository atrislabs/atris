const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { experimentsCommand } = require('../commands/experiments');

test('revert preserves the reset process diagnostic', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reset-diagnostic-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const python = process.env.ATRIS_EXPERIMENTS_PYTHON;
  const lines = [];
  const exit = new Error('command exit');
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  t.mock.method(process, 'exit', () => { throw exit; });
  try {
    process.env.HOME = root;
    process.env.ATRIS_EXPERIMENTS_PYTHON = process.execPath;
    process.chdir(root);
    const pack = path.join(root, 'atris', 'experiments', 'broken-reset');
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, 'reset.py'),
      "console.error('baseline archive unavailable'); process.exitCode = 1;\n");
    try {
      experimentsCommand('revert', 'broken-reset');
    } catch (error) {
      if (error !== exit) throw error;
    }
    assert.match(lines.join('\n'), /baseline archive unavailable/);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (python === undefined) delete process.env.ATRIS_EXPERIMENTS_PYTHON;
    else process.env.ATRIS_EXPERIMENTS_PYTHON = python;
  }
});
