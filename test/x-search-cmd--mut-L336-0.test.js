'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatXSearchResult } = require('../commands/x-search');

test('a boolean refund flag without a numeric refund amount is shown to the user', () => {
  const output = formatXSearchResult({
    credits_used: 0,
    credits_remaining: 50,
    refunded: true,
    data: { content: '', citations: [] },
  });

  assert.match(output, /credits refunded/i);
});
