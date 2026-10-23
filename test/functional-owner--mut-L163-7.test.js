'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFunctionalOwner } = require('../lib/functional-owner');

test('exact member resolution preserves the requested engine owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-request-'));
  try {
    const result = resolveFunctionalOwner({ root, requestedOwner: 'codex', title: 'refresh wiki-miner documentation' });
    assert.strictEqual(result.requested_owner, 'codex');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
