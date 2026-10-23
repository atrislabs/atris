const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectSnapshot, snapshotsDiffer } = require('../commands/live');

test('same-size edits to an existing watched note trigger freshness work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-note-edit-'));
  const note = path.join(root, 'atris', 'notes.md');
  fs.mkdirSync(path.dirname(note));
  fs.writeFileSync(note, 'status: draft\n');
  fs.utimesSync(note, 1700000000, 1700000000);
  const before = collectSnapshot(root);

  fs.writeFileSync(note, 'status: ready\n');
  fs.utimesSync(note, 1700003600, 1700003600);
  const after = collectSnapshot(root);

  assert.equal(before.size, 1);
  assert.equal(after.size, before.size);
  assert.equal(snapshotsDiffer(before, new Map(before)), false);
  assert.equal(snapshotsDiffer(before, after), true,
    'editing an existing note without changing its size must request a refresh');
});
