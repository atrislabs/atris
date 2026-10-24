'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a benchmark dry run refuses a workspace without its contract', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-contract-required-'));
  const previousHome = process.env.HOME;
  const previousBackend = process.env.ATRIS_BACKEND_ROOT;
  process.env.ATRIS_BACKEND_ROOT = root;
  const previousCwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  t.after(() => {
    process.chdir(previousCwd);
    if (previousBackend === undefined) delete process.env.ATRIS_BACKEND_ROOT;
    else process.env.ATRIS_BACKEND_ROOT = previousBackend;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const { experimentsCommand } = require('../commands/experiments');
  const pack = path.join(root, 'atris', 'experiments', 'endstate-baseline');
  fs.mkdirSync(path.dirname(pack), { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'atris', 'experiments', 'endstate-baseline'), pack, { recursive: true });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const exit = new Error('command exit');
  t.mock.method(process, 'exit', () => { throw exit; });
  try {
    await experimentsCommand('run', 'endstate-baseline', '--dry-run');
  } catch (error) {
    if (error !== exit) throw error;
  }
  assert.match(lines.join('\n'), /contract missing/i);
});
