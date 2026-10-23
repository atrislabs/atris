'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { benchCommand } = require('../commands/bench');

test('bench pair reports an invalid explicit repeat count before validating the margin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-repeats-'));
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const output = [];
  try {
    process.chdir(root);
    console.log = (line) => output.push(line);
    // Both values are invalid so dropping repeats still stops before any task runs.
    const exitCode = await benchCommand([
      'pair', '--here', '--json', '--pack=core-v1',
      '--candidate', root, '--current', root,
      '--repeats=0', '--min-win-margin=invalid',
    ]);
    assert.equal(exitCode, 2);
    assert.deepEqual(output, [JSON.stringify({
      schema: 'atris.bench.error.v1',
      error: 'repeats must be a positive integer',
    })]);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
