'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decideCommand } = require('../commands/decide');

const HELP_LINES = [
  'Usage:',
  '  atris decide',
  '  atris decide <n> y|n|yes|no [--note "<text>"]',
  '  atris decide --json',
  '  atris decide <n> y --json',
];

function useEmptyWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-decide-cmd-test-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  t.after(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root;
  process.chdir(root);
  return root;
}

function captureRun(args) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts) => stdout.push(parts.join(' '));
  console.error = (...parts) => stderr.push(parts.join(' '));
  try {
    decideCommand(args);
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
}

test('--help and help print the usage block without reading decisions', (t) => {
  useEmptyWorkspace(t);
  for (const args of [['--help'], ['-h'], ['help']]) {
    const result = captureRun(args);
    assert.deepStrictEqual(result.stdout, HELP_LINES, JSON.stringify(args));
    assert.deepStrictEqual(result.stderr, []);
    assert.equal(result.exitCode, undefined);
  }
});

test('an empty workspace reports nothing waiting, as text and as json', (t) => {
  useEmptyWorkspace(t);

  const text = captureRun([]);
  assert.deepStrictEqual(text.stdout, ['nothing is waiting for a decision.']);
  assert.deepStrictEqual(text.stderr, []);
  assert.equal(text.exitCode, undefined);

  const json = captureRun(['--json']);
  assert.equal(json.stdout.length, 1);
  assert.deepStrictEqual(JSON.parse(json.stdout[0]), {
    ok: true,
    action: 'decide_list',
    count: 0,
    decisions: [],
  });
  assert.equal(json.exitCode, undefined);
});

test('bad numbers, answers, and argument shapes fail with exit code 2', (t) => {
  useEmptyWorkspace(t);
  const cases = [
    [['1', 'maybe'], 'answer must be y, n, yes, or no'],
    [['0', 'y'], 'decision number must be a positive integer'],
    [['1.5', 'y'], 'decision number must be a positive integer'],
    [['abc', 'n'], 'decision number must be a positive integer'],
    [['1'], 'usage: atris decide <n> y|n|yes|no [--note "<text>"]'],
    [['--note'], '--note requires text'],
    [['1', 'y', '--note'], '--note requires text'],
  ];
  for (const [args, message] of cases) {
    const result = captureRun(args);
    assert.deepStrictEqual(result.stderr, [message], JSON.stringify(args));
    assert.deepStrictEqual(result.stdout, [], JSON.stringify(args));
    assert.equal(result.exitCode, 2, JSON.stringify(args));
  }
});

test('--json turns argument errors into one json error object', (t) => {
  useEmptyWorkspace(t);
  const result = captureRun(['0', 'y', '--json']);
  assert.deepStrictEqual(result.stderr, []);
  assert.equal(result.stdout.length, 1);
  assert.deepStrictEqual(JSON.parse(result.stdout[0]), {
    ok: false,
    action: 'decide_error',
    error: 'decision number must be a positive integer',
  });
  assert.equal(result.exitCode, 2);
});

test('answering a number when nothing is open exits 1 and prints nothing to stdout', (t) => {
  const root = useEmptyWorkspace(t);
  const result = captureRun(['1', 'y']);
  assert.deepStrictEqual(result.stderr, ['decision 1 is not open']);
  assert.deepStrictEqual(result.stdout, []);
  assert.equal(result.exitCode, 1);
  assert.equal(fs.existsSync(path.join(root, '.atris')), false);
});

test('--note=<text> is accepted in the inline form and still reaches the open-check', (t) => {
  useEmptyWorkspace(t);
  const result = captureRun(['3', 'n', '--note=not this one']);
  assert.deepStrictEqual(result.stderr, ['decision 3 is not open']);
  assert.equal(result.exitCode, 1);
});

test('--json with an unopened decision reports decide_error with exit 1', (t) => {
  useEmptyWorkspace(t);
  const result = captureRun(['1', 'yes', '--json']);
  assert.deepStrictEqual(result.stderr, []);
  assert.deepStrictEqual(JSON.parse(result.stdout[0]), {
    ok: false,
    action: 'decide_error',
    error: 'decision 1 is not open',
  });
  assert.equal(result.exitCode, 1);
});
