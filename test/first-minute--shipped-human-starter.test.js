const test = require('node:test');
const assert = require('node:assert');

const { shippedHumanStarter } = require('../lib/first-minute');

const starter = (extra = {}) => ({
  title: 'build a landing page',
  status: 'done',
  metadata: { source: 'context_gatherer' },
  ...extra,
});

test('shippedHumanStarter returns the done human starter task', () => {
  const done = starter({ title: 'ship the onboarding want', updated_at: 1000 });
  const result = shippedHumanStarter([done]);
  assert.strictEqual(result, done);
});

test('shippedHumanStarter recognizes onboarding tag as a human starter', () => {
  const done = { title: 'tagged want', status: 'done', tag: 'onboarding', updated_at: 500 };
  assert.strictEqual(shippedHumanStarter([done]), done);
});

test('shippedHumanStarter returns the newest done starter when several shipped', () => {
  const older = starter({ title: 'first want', updated_at: 1000 });
  const newer = starter({ title: 'second want', updated_at: 3000 });
  const middle = starter({ title: 'middle want', created_at: 2000 });
  const result = shippedHumanStarter([older, newer, middle]);
  assert.strictEqual(result, newer);
});

test('shippedHumanStarter returns null when a starter is still actionable', () => {
  const done = starter({ title: 'shipped want', updated_at: 1000 });
  for (const status of ['open', 'claimed', 'review']) {
    const live = starter({ title: 'live want', status, updated_at: 2000 });
    assert.strictEqual(shippedHumanStarter([done, live]), null, `expected null with status ${status}`);
  }
});

test('shippedHumanStarter returns null for empty, non-array, and non-starter input', () => {
  assert.strictEqual(shippedHumanStarter([]), null);
  assert.strictEqual(shippedHumanStarter(null), null);
  assert.strictEqual(shippedHumanStarter(undefined), null);
  assert.strictEqual(shippedHumanStarter('not an array'), null);

  const seedDone = { title: 'Generate MAP.md', status: 'done', metadata: { source: 'init_seed' }, updated_at: 1000 };
  const plainDone = { title: 'ordinary task', status: 'done', updated_at: 2000 };
  assert.strictEqual(shippedHumanStarter([seedDone, plainDone]), null);
});
