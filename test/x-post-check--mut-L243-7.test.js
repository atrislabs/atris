'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAnswer } = require('../lib/x-post-check');

test('matches sixty percent word overlap without an exact opening phrase', () => {
  // No quotes or handle can provide an alternate match. The reversed words
  // must be counted by the answer window to reach the three-of-five threshold.
  const post = {
    handle: 'example',
    text: 'alpha beta gamma delta epsilon',
    createdAt: null,
  };

  assert.deepEqual(matchAnswer('gamma beta alpha', [
    { id: '12345', ok: true, post },
  ]), [{
    status: 'checked',
    handle: 'example',
    id: '12345',
    url: 'https://x.com/example/status/12345',
    text: 'alpha beta gamma delta epsilon',
    posted_at: null,
    line: null,
  }]);
});
