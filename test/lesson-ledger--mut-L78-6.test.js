const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendLedgerEntry, readLedger } = require('../lib/lesson-ledger');

test('a limit larger than the history preserves every entry', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-history-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const slug of ['first', 'second', 'third']) {
    appendLedgerEntry(dir, { action: 'add', slug, ts: '2024-01-15T12:00:00.000Z' });
  }
  assert.equal(readLedger(dir, { limit: 5 }).length, 3);
});
