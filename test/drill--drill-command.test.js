'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { drillCommand } = require('../commands/drill');

const helpLines = [
  'Usage: atris drill [--json] [--keep]',
  '',
  'Runs a no-LLM end-to-end drill in a throwaway sandbox repo.',
];

async function captureHelp(args) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(' '));
  try {
    const code = await drillCommand(args);
    return { code, lines };
  } finally {
    console.log = originalLog;
  }
}

// Help returns before the clock, filesystem, git, or environment is read.
// Keep these direct calls sequential because output capture changes console.log.
test('drillCommand prints usage and succeeds for each help spelling', async () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    assert.deepStrictEqual(await captureHelp(args), { code: 0, lines: helpLines });
  }
});

test('drillCommand help takes precedence over JSON and sandbox retention flags', async () => {
  for (const args of [
    ['--json', '--keep', '--help'],
    ['help', '--json', '--keep'],
    ['--keep', '-h', '--json'],
  ]) {
    assert.deepStrictEqual(await captureHelp(args), { code: 0, lines: helpLines });
  }
});

test('drillCommand rejects null arguments before running a drill or printing output', async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values);
  try {
    await assert.rejects(() => drillCommand(null), TypeError);
    assert.deepStrictEqual(lines, []);
  } finally {
    console.log = originalLog;
  }
});
