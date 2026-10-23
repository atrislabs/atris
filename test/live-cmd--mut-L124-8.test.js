const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectSnapshot } = require('../commands/live');

test('live snapshots exclude .DS_Store files at every depth', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-live-ignore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, '.DS_Store'), 'finder metadata');
  fs.writeFileSync(path.join(root, 'notes', '.DS_Store'), 'nested finder metadata');

  assert.deepStrictEqual(collectSnapshot(root), new Map());
});
