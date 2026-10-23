'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchAnswer } = require('../lib/x-post-check');

test('a post the answer repeats word for word counts even when the author is never named', () => {
  const results = [{
    id: '9',
    ok: true,
    post: { id: '9', handle: 'swyx', text: 'The agent engineer is the new full stack engineer and nobody is ready for it' },
  }];
  const checks = matchAnswer('the agent engineer is the new full stack engineer and nobody is ready for it', results);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'checked');
});
