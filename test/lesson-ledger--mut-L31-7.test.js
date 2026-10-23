const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateDetector } = require('../lib/lesson-ledger');

test('validateDetector returns the empty-detector result for a truthy non-string', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ledger-non-string-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(validateDetector(42, dir), {
    ok: false,
    reason: 'detector is empty',
  });
});
