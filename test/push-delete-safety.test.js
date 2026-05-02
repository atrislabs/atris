const test = require('node:test');
const assert = require('node:assert/strict');

const { isMassDeletePlan } = require('../commands/push');

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
