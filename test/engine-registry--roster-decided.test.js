const { test } = require('node:test');
const assert = require('node:assert');

const { rosterDecided, ROSTER_LAYERS } = require('../lib/engine-registry');

test('rosterDecided is true for each roster line source', () => {
  assert.strictEqual(rosterDecided('session'), true);
  assert.strictEqual(rosterDecided('project'), true);
  assert.strictEqual(rosterDecided('machine'), true);
});

test('rosterDecided agrees with every entry in ROSTER_LAYERS', () => {
  assert.deepStrictEqual([...ROSTER_LAYERS], ['session', 'project', 'machine']);
  for (const layer of ROSTER_LAYERS) {
    assert.strictEqual(rosterDecided(layer), true, `${layer} should count as decided`);
  }
});

test('rosterDecided is false for router, default, none, and unknown sources', () => {
  assert.strictEqual(rosterDecided('router'), false);
  assert.strictEqual(rosterDecided('default'), false);
  assert.strictEqual(rosterDecided('none'), false);
  assert.strictEqual(rosterDecided('roster'), false);
  assert.strictEqual(rosterDecided('something-else'), false);
});

test('rosterDecided is false for empty and missing input', () => {
  assert.strictEqual(rosterDecided(), false);
  assert.strictEqual(rosterDecided(undefined), false);
  assert.strictEqual(rosterDecided(null), false);
  assert.strictEqual(rosterDecided(''), false);
});

test('rosterDecided matches exactly: no case folding, trimming, or coercion', () => {
  assert.strictEqual(rosterDecided('Session'), false);
  assert.strictEqual(rosterDecided('PROJECT'), false);
  assert.strictEqual(rosterDecided(' machine'), false);
  assert.strictEqual(rosterDecided('machine '), false);
  assert.strictEqual(rosterDecided(['session']), false);
  assert.strictEqual(rosterDecided({ source: 'session' }), false);
  assert.strictEqual(rosterDecided(0), false);
});

test('rosterDecided handles a result shaped like a team resolution', () => {
  const rosterPick = { job: 'build', source: 'project', engine: 'codex' };
  const routerPick = { job: 'build', source: 'router', engine: 'codex' };
  assert.strictEqual(rosterDecided(rosterPick.source), true);
  assert.strictEqual(rosterDecided(routerPick.source), false);
});
