const test = require('node:test');
const assert = require('node:assert/strict');
const { isMassDeletePlan } = require('../commands/push');

test('deleting ten files with ten survivors does not require mass-delete confirmation', () => {
  const plan = {
    deletedPaths: Array.from({ length: 10 }, (_, i) => `/wiki/retired-${i}.md`),
    filesToPush: [
      { path: '/wiki/replacement.md', content: 'Updated guide' },
    ],
    unchangedCount: 9,
  };

  assert.equal(isMassDeletePlan(plan), false,
    'equal deletion and survivor counts must remain an ordinary delete plan');
});
