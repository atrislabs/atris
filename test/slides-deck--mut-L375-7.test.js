const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeck } = require('../lib/slides-deck');

test('timeline step label is inserted when no heading or description supplies it', () => {
  const label = 'Approve release';
  const { requests } = buildDeck({
    slides: [{ type: 'timeline', steps: [{ label }] }],
  });

  assert.ok(requests.some((request) => request.insertText?.text === label),
    'the timeline must display its step label');
});
