'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAnswer } = require('../lib/x-post-check');

test('an unquoted tweet on the first block line keeps its inline annotation position', () => {
  const text = 'Launched our agent startup today, come try it out';
  const checks = matchAnswer(`1. Tweet: ${text}`, [{
    id: '123456',
    ok: true,
    post: { id: '123456', handle: 'foo', text },
  }]);
  assert.equal(checks[0]?.line, 0);
});
