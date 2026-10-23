const test = require('node:test');
const assert = require('node:assert/strict');
const { renderEmailLine } = require('../lib/receipt-block');

test('a receipt with no result still renders its objective', () => {
  const line = renderEmailLine({
    objective: 'Invite checks protect signups',
    result: null,
  });

  assert.match(line, /Invite checks protect signups/);
});
