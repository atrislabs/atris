'use strict';

// splitArgs reads a value flag as taking the next word. When the value flag is
// the last word of the launch there is no next word, so it must stand alone:
// its value is true, and the reading is unsure because the flag is not a switch.

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitArgs } = require('../lib/engine-processes');

test('a value flag that is the last word of a claude launch stands alone', () => {
  assert.deepEqual(splitArgs('claude', ['-p', '--model']), {
    command: [],
    flags: [['-p', true], ['--model', true]],
    prompt: [],
    dashed: false,
    unsure: true,
    tail: [],
  });
});

test('a value flag that is the last word after a codex subcommand stands alone', () => {
  assert.deepEqual(splitArgs('codex', ['exec', '--model']), {
    command: ['exec'],
    flags: [['--model', true]],
    prompt: [],
    dashed: false,
    unsure: true,
    tail: [],
  });
});
