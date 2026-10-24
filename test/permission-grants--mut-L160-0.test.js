'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grants = require('../lib/permission-grants');

test('a workspace prefix grant approves extra arguments only after matching tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prefix-grant-'));
  const file = path.join(dir, 'grants.json');
  grants.saveGrants({
    schema: grants.GRANTS_SCHEMA,
    grants: [{
      grant_id: 'grant-status-prefix',
      status: 'active',
      action_type: 'local_command',
      scope: { kind: 'workspace', workspace_root: fs.realpathSync(dir) },
      pattern: { type: 'argv_prefix', argv: ['git', 'status'], display: 'git status' },
      constraints: {},
      audit: {},
    }],
  }, file);

  const hit = grants.matchGrant({ command: 'git status --short', workspaceRoot: dir, file });
  assert.equal(hit && hit.grant_id, 'grant-status-prefix');
  assert.equal(grants.matchGrant({ command: 'npm test --silent', workspaceRoot: dir, file }), null);
});
