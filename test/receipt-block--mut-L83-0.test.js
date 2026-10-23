const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPageSection } = require('../lib/receipt-block');

test('receipt details preserve the count of multiple ticks when no changed files are recorded', () => {
  const section = renderPageSection({
    objective: 'Check saved progress',
    result: { kind: 'mission_tick', tick_count: 2 },
  });

  assert.match(section, /\b2 ticks\b/);
});
