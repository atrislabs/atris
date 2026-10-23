'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const grants = require('../lib/permission-grants');

test('unsupported schema falls back to default store schema', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-store-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const file = path.join(tmp, 'store.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'legacy-v0', grants: [] }));

  const store = grants.loadGrants(file);
  assert.strictEqual(store.schema, grants.GRANTS_SCHEMA);
});
