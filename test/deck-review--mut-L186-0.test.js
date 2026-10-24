const test = require('node:test');
const assert = require('node:assert/strict');
const { lintSpec } = require('../lib/deck-review');

test('lintSpec reports the exact metrics dropped from an overflowing metric grid', () => {
  const metrics = Array.from({ length: 5 }, (_, i) => ({
    value: String(i + 1),
    label: `Metric ${i + 1}`,
  }));

  assert.deepStrictEqual(lintSpec({
    slides: [{ type: 'metricgrid', metrics }],
  }), [{
    severity: 'error',
    slide: 1,
    rule: 'content-truncated',
    message: '5 metrics but only 4 render; 1 will be dropped, split the slide',
  }]);
});
