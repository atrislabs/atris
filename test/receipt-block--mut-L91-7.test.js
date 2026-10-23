const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPageSection } = require('../lib/receipt-block');

test('mission tick kind counts as one tick without a tick object', () => {
  assert.equal(
    renderPageSection({
      objective: 'Work completed',
      result: { kind: 'mission_tick' },
    }),
    '## mission receipt\n\nWork completed.\n\ndetails: 1 tick; status recorded',
  );
});
