const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPageSection } = require('../lib/receipt-block');

test('a multi-step receipt shows its recorded tick count when no file count exists', () => {
  const section = renderPageSection({
    objective: 'Check account access',
    result: { tick_count: 3 },
  });

  assert.match(section, /\b3 ticks\b/);
});
