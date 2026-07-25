const test = require('node:test');
const assert = require('node:assert');
const { wikiHealthSentence } = require('../commands/activate');

test('says nothing when there is no wiki', () => {
  assert.strictEqual(wikiHealthSentence(null), null);
});

test('says nothing when the wiki is healthy', () => {
  assert.strictEqual(wikiHealthSentence({ bullets: ['- 26 pages compiled'] }), null);
});

test('surfaces one plain sentence when pages are stale, quoting no paths', () => {
  const line = wikiHealthSentence({ bullets: ['- 3 stale pages: atris/wiki/systems/atris-cli.md'] });
  assert.ok(line && /wiki/.test(line) && /loop wiki/.test(line));
  assert.ok(!line.includes('.md'), 'must not leak paths to the operator');
});

test('orphan pages also count as needing attention', () => {
  const line = wikiHealthSentence({ bullets: ['- 1 orphan page'] });
  assert.ok(line && /loop wiki/.test(line));
});
