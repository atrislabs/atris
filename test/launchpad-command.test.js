'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { launchpadCommand } = require('../commands/launchpad');

function captureHelp(args) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    return { code: launchpadCommand(args), output: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

test('launchpad --help describes usage and supported options successfully', () => {
  const result = captureHelp(['--help']);

  assert.strictEqual(result.code, 0);
  assert.match(result.output, /^Usage: atris launchpad \[--json\] \[--as <owner>\]/);
  assert.match(result.output, /--json\s+Print machine-readable launchpad state\./);
  assert.match(result.output, /--as <owner>\s+Pick next action for a specific agent\/member\./);
  assert.match(result.output, /--help, -h\s+Show this help\./);
});

test('launchpad help aliases and help combined with JSON return the same help', () => {
  const expected = captureHelp(['--help']);

  for (const args of [['-h'], ['help'], ['--json', '--help'], ['--as', 'tester', '-h']]) {
    const result = captureHelp(args);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.output, expected.output);
    assert.ok(result.output.startsWith('Usage: atris launchpad '));
  }
});
