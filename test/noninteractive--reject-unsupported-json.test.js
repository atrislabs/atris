'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { rejectUnsupportedJson } = require('../lib/noninteractive');

// process.exit would stop the runner. Record the code and keep going so the
// return value after the refusal can be checked too.
function callReject(commandName, args) {
  const logs = [];
  const errors = [];
  const exits = [];
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(' '));
  console.error = (...parts) => errors.push(parts.map((part) => String(part)).join(' '));
  process.exit = (code) => {
    exits.push(code);
  };
  try {
    const returned = args === undefined
      ? rejectUnsupportedJson(commandName)
      : rejectUnsupportedJson(commandName, args);
    return { returned, logs, errors, exits };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
  }
}

function refusal(commandName) {
  return JSON.stringify({
    ok: false,
    error: `${commandName} does not support --json`,
    command: commandName,
    usage: `atris ${commandName}`,
  }, null, 2);
}

describe('rejectUnsupportedJson', { concurrency: false }, () => {
  test('ordinary args are allowed and print nothing', () => {
    for (const args of [
      [],
      ['version'],
      ['--help'],
      ['-h'],
      ['list', '--status', 'open'],
      ['--yes', '-y'],
    ]) {
      const result = callReject('version', args);
      assert.strictEqual(result.returned, false);
      assert.deepStrictEqual(result.logs, []);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(result.exits, []);
    }
  });

  test('empty, non-array, and lookalike flags are not a json request', () => {
    const previousArgv = process.argv;
    try {
      process.argv = ['node', 'atris', 'version'];
      const fromArgv = callReject('version');
      assert.strictEqual(fromArgv.returned, false);
      assert.deepStrictEqual(fromArgv.logs, []);
      assert.deepStrictEqual(fromArgv.exits, []);

      // --json before the args slice is ignored, same as a missing flag.
      process.argv = ['node', '--json'];
      const hidden = callReject('version');
      assert.strictEqual(hidden.returned, false);
      assert.deepStrictEqual(hidden.exits, []);
    } finally {
      process.argv = previousArgv;
    }

    for (const args of [
      null,
      '--json',
      [],
      [''],
      ['--json=true'],
      ['--JSON'],
      ['--json '],
      ['json'],
      ['--yes', '--json=1'],
    ]) {
      const result = callReject('', args);
      assert.strictEqual(result.returned, false, JSON.stringify(args));
      assert.deepStrictEqual(result.logs, []);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(result.exits, []);
    }
  });

  test('--json prints a refusal and exits 2, including an empty command name', () => {
    const named = callReject('version', ['version', '--json', '--help']);
    assert.strictEqual(named.returned, true);
    assert.deepStrictEqual(named.exits, [2]);
    assert.deepStrictEqual(named.errors, []);
    assert.deepStrictEqual(named.logs, [refusal('version')]);

    const empty = callReject('', ['--json']);
    assert.strictEqual(empty.returned, true);
    assert.deepStrictEqual(empty.exits, [2]);
    assert.deepStrictEqual(empty.logs, [refusal('')]);
    assert.strictEqual(JSON.parse(empty.logs[0]).error, ' does not support --json');
    assert.strictEqual(JSON.parse(empty.logs[0]).usage, 'atris ');

    const previousArgv = process.argv;
    try {
      process.argv = ['node', 'atris', 'wiki', '--json'];
      const fromArgv = callReject('wiki');
      assert.strictEqual(fromArgv.returned, true);
      assert.deepStrictEqual(fromArgv.exits, [2]);
      assert.deepStrictEqual(fromArgv.logs, [refusal('wiki')]);
    } finally {
      process.argv = previousArgv;
    }
  });
});
