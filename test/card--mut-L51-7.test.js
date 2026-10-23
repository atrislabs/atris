const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCard } = require('../lib/card');

test('a supplied release version is visible on the card', () => {
  const card = buildCard({ headline: 'Release ready', version: 'v7.3.1' });
  assert.ok(card.html.includes('v7.3.1'), 'the rendered card shows the supplied version');
});
