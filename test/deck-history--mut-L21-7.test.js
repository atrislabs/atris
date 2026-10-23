const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordBuild, readHistory } = require('../lib/deck-history');

test('recordBuild preserves the exact supplied timestamp in its return value and ledger', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-history-explicit-at-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, 'history.jsonl');
  const at = '2001-02-03T04:05:06+07:00';

  const entry = recordBuild({ spec: {}, presentationId: 'example', at }, ledger);

  assert.equal(entry.at, at);
  assert.equal(readHistory(ledger)[0].at, at);
});
