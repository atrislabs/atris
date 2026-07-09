'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSimpleFlags, runPlainInterview } = require('../commands/interview');

test('parseSimpleFlags reads separated and inline values', () => {
  const parsed = parseSimpleFlags(['--name', 'test dj', '--want=more gigs', 'extra'], ['--name', '--want']);
  assert.deepEqual(parsed.values, {
    '--name': 'test dj',
    '--want': 'more gigs',
  });
  assert.deepEqual(parsed.positionals, ['extra']);
});

test('runPlainInterview returns flag answers without prompting', async () => {
  const result = await runPlainInterview({
    args: ['--name', 'test dj', '--want', 'more gigs'],
    fields: [
      { key: 'name', flag: '--name', question: 'who are you?\n> ' },
      { key: 'want', flag: '--want', question: 'what do you want?\n> ' },
    ],
    input: { isTTY: false },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answers, {
    name: 'test dj',
    want: 'more gigs',
  });
});
