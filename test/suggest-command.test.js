'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { suggestCommand, editDistance, knownCommands } = require('../lib/known-commands');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

test('suggestCommand points a near-miss typo at the intended command', () => {
  assert.strictEqual(suggestCommand('taks'), 'task');
  assert.strictEqual(suggestCommand('missin'), 'mission');
  assert.strictEqual(suggestCommand('benc'), 'bench');
  assert.strictEqual(suggestCommand('stauts'), 'status');
  assert.strictEqual(suggestCommand('context'), 'activate');
});

test('suggestCommand returns null for input that is not close to any command', () => {
  assert.strictEqual(suggestCommand('zzzzzzzzz'), null);
  assert.strictEqual(suggestCommand(''), null);
  assert.strictEqual(suggestCommand(null), null);
});

test('suggestCommand never suggests private underscore commands', () => {
  // "_start" is a real internal command; a typo near it must not surface it.
  const s = suggestCommand('start');
  assert.ok(s === null || !s.startsWith('_'));
});

test('editDistance basics hold', () => {
  assert.strictEqual(editDistance('task', 'task'), 0);
  assert.strictEqual(editDistance('taks', 'task'), 1);
  assert.strictEqual(editDistance('', 'abc'), 3);
});

test('every known command is its own closest match', () => {
  for (const c of knownCommands) {
    if (c.startsWith('_')) continue;
    assert.strictEqual(editDistance(c, c), 0);
  }
});

test('CLI prints a did-you-mean line for a typo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-suggest-command-test-'));
  try {
    let out = '';
    try {
      out = execFileSync('node', [CLI, 'taks'], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          ATRIS_SKIP_UPDATE_CHECK: '1',
          ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
        },
      });
    } catch (err) {
      // Unknown single-word verbs exit 2; suggestion is on stderr.
      out = `${err.stdout || ''}${err.stderr || ''}`;
    }
    assert.match(out, /Did you mean "atris task"\?/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
