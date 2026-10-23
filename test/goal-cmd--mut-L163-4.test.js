'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/goal');

test('show omits the metrics section when there are no metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-goal-empty-metrics-'));
  const output = [];
  const originalLog = console.log;
  try {
    console.log = (...args) => output.push(args.join(' '));
    const status = run([], {
      cwd: dir,
      now: new Date('2020-01-15T12:00:00.000Z'),
    });
    assert.equal(status, 0);
    assert.equal(output.join('\n'), [
      '  goal      goal not set. set it: atris goal set "<sentence>"',
      '  today     no movement recorded today',
      '  next      atris goal set "<sentence>"',
    ].join('\n'));
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
