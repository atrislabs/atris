'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const grants = require('../lib/permission-grants');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-grants-'));
  return { dir, file: path.join(dir, 'permission-grants.json') };
}

test('grant + exact match auto-approves the same command in the same workspace', () => {
  const { dir, file } = tempStore();
  const added = grants.addGrant({ command: 'npm test', workspaceRoot: dir, file });
  assert.equal(added.ok, true);
  const hit = grants.matchGrant({ command: 'npm  test', workspaceRoot: dir, file });
  assert.ok(hit, 'normalized whitespace still matches exact argv');
  assert.equal(hit.grant_id, added.grant.grant_id);
});

test('a grant never matches a different command, workspace, or after revoke/expiry', () => {
  const { dir, file } = tempStore();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-grants-other-'));
  const added = grants.addGrant({ command: 'npm test', workspaceRoot: dir, file });
  assert.equal(grants.matchGrant({ command: 'npm test -- --grep x', workspaceRoot: dir, file }), null);
  assert.equal(grants.matchGrant({ command: 'npm test', workspaceRoot: other, file }), null);
  grants.revokeGrant(added.grant.grant_id, file);
  assert.equal(grants.matchGrant({ command: 'npm test', workspaceRoot: dir, file }), null);
  const expired = grants.addGrant({ command: 'npm test', workspaceRoot: dir, file, expiresInDays: -1 });
  assert.equal(expired.ok, true);
  assert.equal(grants.matchGrant({ command: 'npm test', workspaceRoot: dir, file }), null);
});

test('shell metacharacters and dangerous commands are never grantable or matchable', () => {
  const { dir, file } = tempStore();
  for (const bad of [
    'npm test && rm -rf /',
    'echo hi; whoami',
    'cat file | sh',
    'sudo ls',
    'git push --force origin master',
    'bash -c "ls"',
    'node -e "process.exit()"',
    'atris task accept CLI-1',
  ]) {
    assert.equal(grants.addGrant({ command: bad, workspaceRoot: dir, file }).ok, false, `grantable: ${bad}`);
  }
  // Even a hand-edited store entry must not match a metacharacter command.
  grants.saveGrants({
    schema: grants.GRANTS_SCHEMA,
    grants: [{
      grant_id: 'grant-handmade', status: 'active', action_type: 'local_command',
      scope: { kind: 'workspace', workspace_root: fs.realpathSync(dir) },
      pattern: { type: 'argv_prefix', argv: ['npm'] },
      constraints: {}, audit: {},
    }],
  }, file);
  assert.equal(grants.matchGrant({ command: 'npm test && rm -rf /', workspaceRoot: dir, file }), null);
});

test('recordUse increments and max_uses caps redemption', () => {
  const { dir, file } = tempStore();
  const added = grants.addGrant({ command: 'npm test', workspaceRoot: dir, file });
  const store = grants.loadGrants(file);
  store.grants[0].constraints.max_uses = 1;
  grants.saveGrants(store, file);
  grants.recordUse(added.grant.grant_id, file);
  assert.equal(grants.loadGrants(file).grants[0].audit.use_count, 1);
  assert.equal(grants.matchGrant({ command: 'npm test', workspaceRoot: dir, file }), null);
});
