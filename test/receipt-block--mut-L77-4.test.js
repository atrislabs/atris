const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPageSection } = require('../lib/receipt-block');

test('zero changed count falls through to tick count', () => {
  const section = renderPageSection({
    result: {
      worktree: { new_since_baseline_count: 0 },
      tick_count: 2,
    },
  });
  assert.match(section, /2 ticks/);
  assert.doesNotMatch(section, /changed file/);
});
