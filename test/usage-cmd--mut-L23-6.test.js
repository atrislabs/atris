'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderUsage } = require('../commands/usage');

test('flat usage counters preserve the request count when usage is numeric', () => {
  const output = renderUsage({ usage: 7, requests: 42 });

  assert.match(output, /\brequests:\s*42\b/);
});
