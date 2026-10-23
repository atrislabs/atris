'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateAcceptVerify } = require('../lib/accept-verify-gate');

test('a single-word hollow command is classified as non-falsifying, not a file path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-accept-mut-l52-'));
  try {
    assert.deepStrictEqual(
      evaluateAcceptVerify({ metadata: { verify: 'true' } }, root),
      {
        ok: false,
        reason: 'verify_not_falsifying',
        detail: '`true` cannot fail for the reason this task exists, it passes on a commit that deletes the work',
        command: 'true',
        ran: false,
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
