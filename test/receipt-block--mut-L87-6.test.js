const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPageSection } = require('../lib/receipt-block');

test('zero ran ticks use the receipt fallback in page details', () => {
  assert.equal(
    renderPageSection({ objective: 'Work finished', result: { ran_ticks: 0 } }),
    '## mission receipt\n\nWork finished.\n\ndetails: 1 receipt; status recorded',
  );
});
