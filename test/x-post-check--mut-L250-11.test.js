'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAnswer } = require('../lib/x-post-check');

test('unquoted reordered post words without a handle still identify the cited post', () => {
  const checks = matchAnswer('Today founders build useful agents together', [{
    id: '1972000000000000001',
    ok: true,
    post: {
      id: '1972000000000000001',
      handle: 'builder',
      text: 'Founders build useful agents together today',
    },
  }]);
  assert.equal(checks[0]?.id, '1972000000000000001');
});
