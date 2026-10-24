'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grants = require('../lib/permission-grants');

test('saving without a storage override persists grants under HOME', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-default-grants-'));
  const previousEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.HOME = home;

  try {
    grants.saveGrants({ schema: grants.GRANTS_SCHEMA, grants: [] });
  } finally {
    const filename = ['permission', 'grants'].join('-') + '.json';
    assert.strictEqual(fs.existsSync(path.join(home, '.atris', filename)), true);
  }
});
