'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFunctionalOwner } = require('../lib/functional-owner');

test('falls back to default owner when task signals have zero score', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lane-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = resolveFunctionalOwner({
    title: 'unrelated widget item',
    root,
  });

  assert.strictEqual(result.owner, 'architect');
  assert.strictEqual(result.reason, 'missing_functional_owner_fit');
});
