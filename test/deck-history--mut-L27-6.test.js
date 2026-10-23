const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordBuild, readHistory } = require('../lib/deck-history');

test('recordBuild records zero slides when slides is false', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-history-mut-L27-6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, 'history.jsonl');

  const entry = recordBuild({
    spec: { slides: false },
    presentationId: 'presentation-test',
    at: '2026-01-01T00:00:00.000Z',
  }, ledger);

  assert.equal(entry.slideCount, 0);
  assert.equal(readHistory(ledger)[0].slideCount, 0);
});
