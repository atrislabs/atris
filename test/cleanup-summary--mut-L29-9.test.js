'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendOvernightNote } = require('../lib/cleanup-summary');

test('appending a note returns false when the root has no atris directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-summary-missing-atris-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(
    appendOvernightNote(root, 'Autoland: Landed 1 finished item.', new Date(2026, 0, 15, 12)),
    false,
  );
});
