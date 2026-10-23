const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('run uses the explicit backend folder before validating its contract', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-options-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const backend = process.env.ATRIS_BACKEND_ROOT;
  delete process.env.ATRIS_BACKEND_ROOT;
  t.after(() => {
    process.chdir(cwd);
    if (backend === undefined) delete process.env.ATRIS_BACKEND_ROOT;
    else process.env.ATRIS_BACKEND_ROOT = backend;
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });
  process.env.HOME = root;
  process.chdir(root);
  fs.mkdirSync(path.join(root, 'atris', 'experiments', 'endstate-baseline'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'experiments', 'endstate-baseline', 'loop.py'), 'print("sample")\n');
  const { experimentsCommand } = require('../commands/experiments');
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  t.mock.method(process, 'exit', () => { throw new Error('command exited'); });
  try { experimentsCommand('run', 'endstate-baseline', '--dry-run', '--backend', root); } catch (error) {
    if (error.message !== 'command exited') throw error;
  }
  assert.match(lines.join('\n'), /contract/i);
});
