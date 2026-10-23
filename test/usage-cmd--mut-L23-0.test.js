'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderUsage } = require('../commands/usage');

test('nested usage renders the request count as a field', () => {
  const output = renderUsage({ usage: { requests: 17 } });

  assert.match(output, /^\s*requests:\s*17\s*$/m);
});
