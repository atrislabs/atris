const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotsDiffer } = require('../commands/live');

test('snapshots with an added file differ', () => {
  const before = new Map([['existing.txt', '4:1000']]);
  const after = new Map([
    ['existing.txt', '4:1000'],
    ['added.txt', '3:1000'],
  ]);

  assert.strictEqual(snapshotsDiffer(before, after), true);
});
