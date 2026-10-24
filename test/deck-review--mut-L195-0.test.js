const test = require('node:test');
const assert = require('node:assert/strict');
const { lintSpec } = require('../lib/deck-review');

test('a versus side with more items than the render limit is flagged truncated', () => {
  const findings = lintSpec({
    slides: [{ type: 'versus', left: { items: ['1', '2', '3', '4', '5', '6'] }, right: { items: ['a'] } }],
  });
  const f = findings.find((x) => x.rule === 'content-truncated');
  assert.ok(f && f.severity === 'error' && f.slide === 1);
});
