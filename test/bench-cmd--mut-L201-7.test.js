'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { benchCommand } = require('../commands/bench');

test('bench results --last 1 prints only the newest saved result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-last-'));
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const output = [];
  try {
    const stateDir = path.join(dir, '.atris', 'state', 'bench');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'results.jsonl'),
      '{"id":"older"}\n{"id":"newer"}\n',
      'utf8',
    );
    process.chdir(dir);
    console.log = (...args) => output.push(args.join(' '));

    const exitCode = await benchCommand(['results', '--last', '1', '--json', '--here']);

    assert.equal(exitCode, 0);
    assert.deepEqual(output, [
      '{"schema":"atris.bench.results.v1","results":[{"id":"newer"}]}',
    ]);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
