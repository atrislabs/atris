'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grants = require('../lib/permission-grants');

test('pulling a grant preserves its server revocation timestamp', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-metadata-'));
  const file = path.join(dir, 'grants.json');
  const revokedAt = '2025-01-02T03:04:05.000Z';
  await grants.syncGrants({
    file,
    token: 'test-token',
    now: new Date('2025-01-03T00:00:00.000Z'),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { grants: [{
        grant_id: 'grant-server-revoked',
        status: 'revoked',
        action_type: 'local_command',
        scope: { kind: 'workspace', workspace_root: fs.realpathSync(dir) },
        pattern: { type: 'exact_argv', argv: ['npm', 'test'], display: 'npm test' },
        constraints: {},
        audit: {},
        sync: { revoked_at: revokedAt },
      }] },
    }),
  });
  assert.equal(grants.loadGrants(file).grants[0].sync.revoked_at, revokedAt);
});
