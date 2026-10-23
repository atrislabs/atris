const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck } = require('../lib/slides-deck');

test('metricgrid preserves the metric label in its inserted text', () => {
  const { requests } = buildDeck({
    theme: 'paper',
    brand: { name: 'Metrics' },
    slides: [{
      type: 'metricgrid',
      metrics: [{ value: '42', label: 'Active customers' }],
    }],
  });

  const texts = requests
    .filter((request) => request.insertText)
    .map((request) => request.insertText.text);

  assert.deepEqual(texts, ['Metrics', '42', 'Active customers']);
});
