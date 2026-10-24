'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grants = require('../lib/permission-grants');

test('sync normalizes a null principal to the default principal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-principal-'));
  const file = path.join(dir, 'grants.json');
  await grants.syncGrants({
    file,
    token: 'test-token',
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { grants: [{
        grant_id: 'web-grant',
        status: 'active',
        action_type: 'local_command',
        principal: null,
        scope: { kind: 'workspace', workspace_root: fs.realpathSync(dir) },
        pattern: { type: 'exact_argv', argv: ['npm', 'test'], display: 'npm test' },
        constraints: {},
        audit: {},
      }] },
    }),
  });
  assert.notEqual(grants.loadGrants(file).grants[0].principal, null);
});
