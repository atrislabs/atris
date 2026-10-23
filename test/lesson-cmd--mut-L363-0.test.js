const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lesson = require('../commands/lesson');

test('ledger prints the empty ledger message instead of help', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-command-'));
  const previousCwd = process.cwd();
  const output = [];
  const exitSignal = new Error('command exited');
  t.mock.method(console, 'log', (...args) => output.push(args));
  t.mock.method(process, 'exit', () => { throw exitSignal; });

  try {
    fs.mkdirSync(path.join(root, 'atris'));
    process.chdir(root);
    try {
      lesson('ledger');
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.deepEqual(output, [
      ['ledger is empty (no lesson mutations recorded yet)'],
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
