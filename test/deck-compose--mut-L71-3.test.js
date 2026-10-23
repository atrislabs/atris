const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../lib/deck-compose');

test('a 120-character lead is retained as the bullet section subtitle', () => {
  const lead = 'A'.repeat(120);
  const section = classify('Next steps', [
    { kind: 'p', text: lead },
    { kind: 'ul', items: ['Review the proposal', 'Share the findings'] },
  ]);

  assert.strictEqual(section.sub, lead);
});
