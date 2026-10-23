const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotsDiffer } = require('../commands/business-sync');

test('snapshot comparison distinguishes unchanged files from an added file', () => {
  const before = new Map([['notes.md', '12:1000']]);
  const unchanged = new Map(before);
  const added = new Map([...before, ['new.md', '8:2000']]);

  assert.deepStrictEqual(
    [snapshotsDiffer(before, unchanged), snapshotsDiffer(before, added)],
    [false, true]
  );
});
