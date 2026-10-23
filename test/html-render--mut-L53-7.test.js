const test = require('node:test');
const assert = require('node:assert/strict');
const { BLOCKS } = require('../lib/html-render');

test('title panel preserves a supplied row value', () => {
  const html = BLOCKS.title({
    headline: 'Overview',
    panel: {
      rows: [{ title: 'Review queue', sub: 'Completed', value: '73%' }],
    },
  }, {});

  assert.match(html, /73%/);
});
