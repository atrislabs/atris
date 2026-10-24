const { test } = require('node:test');
const assert = require('node:assert');
const { hasActivity } = require('../lib/agent-today');

const quiet = { sessions: { claude: 0, codex: 0 }, commits: [] };

test('hasActivity is true when a person ran agent sessions', () => {
  assert.strictEqual(hasActivity({ sessions: { claude: 2, codex: 0 }, commits: [] }), true);
  assert.strictEqual(hasActivity({ sessions: { claude: 0, codex: 1 }, commits: [] }), true);
});

test('hasActivity is true when agents ran on their own', () => {
  assert.strictEqual(hasActivity({ sessions: { claude: 0, codex: 0 }, autoRuns: 1, commits: [] }), true);
});

test('hasActivity is true on commits alone, no sessions', () => {
  assert.strictEqual(hasActivity({ sessions: { claude: 0, codex: 0 }, commits: ['fix the thing'] }), true);
});

test('hasActivity is false for null, undefined, and a quiet day', () => {
  assert.strictEqual(hasActivity(null), false);
  assert.strictEqual(hasActivity(undefined), false);
  assert.strictEqual(hasActivity(quiet), false);
  assert.strictEqual(hasActivity({ ...quiet, autoRuns: 0, unsaved: 3 }), false);
});
