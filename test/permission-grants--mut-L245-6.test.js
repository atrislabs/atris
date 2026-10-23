'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grants = require('../lib/permission-grants');

test('sync preserves an existing active grant when the server also reports it active', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-active-sync-'));
  const file = path.join(dir, 'grants.json');
  const grant = {
    grant_id: 'grant-active-sync',
    status: 'active',
    action_type: 'local_command',
    scope: { kind: 'workspace', workspace_root: fs.realpathSync(dir) },
    pattern: { type: 'exact_argv', argv: ['npm', 'test'], display: 'npm test' },
    constraints: {},
    audit: {},
  };
  grants.saveGrants({ schema: grants.GRANTS_SCHEMA, grants: [grant] }, file);

  await grants.syncGrants({
    file,
    token: 'test-token',
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { grants: [JSON.parse(JSON.stringify(grant))] },
    }),
  });

  assert.equal(grants.loadGrants(file).grants[0].status, 'active');
});
