'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/goal');

test('setting a goal reports the matching saved wish rather than an unrelated wish', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-goal-match-'));
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    fs.mkdirSync(path.join(dir, 'atris'));
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    // Both comparisons find an existing wish, keeping this test out of wish creation.
    fs.writeFileSync(path.join(state, 'wishes.jsonl'), [
      { id: 'wish-match', n: 1, text: 'Ship The Thing', status: 'captured_no_mission' },
      { id: 'wish-other', n: 2, text: 'Repair another thing', status: 'captured_no_mission' },
    ].map((wish) => JSON.stringify(wish)).join('\n') + '\n');

    console.log = (...args) => stdout.push(args.join(' '));
    console.error = (...args) => stderr.push(args.join(' '));
    const status = run(['set', 'ship the thing'], {
      cwd: dir,
      now: new Date('2024-06-15T12:00:00.000Z'),
    });

    assert.equal(status, 0);
    assert.deepEqual(stderr, []);
    assert.deepEqual(stdout, [
      'goal set.',
      'wish already filed: wish-match',
      'next      atris wish again wish-match "ship the thing"',
    ]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
