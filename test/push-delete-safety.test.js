const test = require('node:test');
const assert = require('node:assert/strict');

const { isMassDeletePlan, parsePushTimeoutSec } = require('../commands/push');

test('mass delete safety allows small explicit deletes', () => {
  assert.equal(isMassDeletePlan({
    deletedPaths: ['/wiki/old.md'],
    filesToPush: [],
    unchangedCount: 20,
  }), false);
});

test('mass delete safety blocks local-folder-wipe-shaped plans', () => {
  assert.equal(isMassDeletePlan({
    deletedPaths: Array.from({ length: 12 }, (_, i) => `/wiki/page-${i}.md`),
    filesToPush: [],
    unchangedCount: 0,
  }), true);
});

test('mass delete safety blocks large cleanup even with surviving files', () => {
  assert.equal(isMassDeletePlan({
    deletedPaths: Array.from({ length: 25 }, (_, i) => `/wiki/page-${i}.md`),
    filesToPush: [{ path: '/wiki/new.md', content: '' }],
    unchangedCount: 40,
  }), true);
});

test('push timeout parser supports equals and space forms', () => {
  assert.equal(parsePushTimeoutSec(['node', 'atris', 'push', 'example-co', '--timeout=240']), 240);
  assert.equal(parsePushTimeoutSec(['node', 'atris', 'push', 'example-co', '--timeout', '180']), 180);
});

test('push timeout parser clamps unsafe values', () => {
  assert.equal(parsePushTimeoutSec(['node', 'atris', 'push', 'example-co', '--timeout=1']), 5);
  assert.equal(parsePushTimeoutSec(['node', 'atris', 'push', 'example-co', '--timeout=999']), 300);
  assert.equal(parsePushTimeoutSec(['node', 'atris', 'push', 'example-co', '--timeout=bad'], 120), 120);
});
