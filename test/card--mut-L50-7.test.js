const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCard } = require('../lib/card');

test('a provided brand is the mark text', () => {
  const card = buildCard({ headline: 'Ship faster', brand: 'Zephyr' });
  const mark = card.html.match(/<span class="mark">([^<]*)<\/span>/);
  assert.ok(mark, 'card renders a mark');
  assert.equal(mark[1], 'Zephyr');
});
