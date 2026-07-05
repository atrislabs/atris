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

// A fake backend client: captures the pushed body and replies with a canned
// authoritative set, so sync stays offline and deterministic.
function fakeApi(reply) {
  const calls = [];
  const api = async (endpoint, options) => {
    // Snapshot the body the way the real client does (JSON at call time), so a
    // later in-place merge of store.grants can't retro-mutate what we assert on.
    const body = options && options.body ? JSON.parse(JSON.stringify(options.body)) : undefined;
    calls.push({ endpoint, options, body });
    return typeof reply === 'function' ? reply({ endpoint, options }) : reply;
  };
  api.calls = calls;
  return api;
}

test('syncGrants pushes local grants and pulls a web-created grant that then matches', async () => {
  const { dir, file } = tempStore();
  const root = fs.realpathSync(dir);
  grants.addGrant({ command: 'npm test', workspaceRoot: dir, file });

  const apiRequestJson = fakeApi({
    ok: true,
    status: 200,
    data: {
      grants: [{
        grant_id: 'grant-from-web',
        status: 'active',
        action_type: 'local_command',
        scope: { kind: 'workspace', workspace_root: root },
        pattern: { type: 'exact_argv', argv: ['npm', 'run', 'build'], display: 'npm run build' },
        constraints: {},
        audit: {},
      }],
    },
  });

  const result = await grants.syncGrants({ apiRequestJson, token: 'tok', file });
  assert.equal(result.ok, true);
  assert.equal(result.pulled, 1);
  // The push carried our local grant up to the backend.
  assert.equal(apiRequestJson.calls[0].body.grants.length, 1);
  assert.equal(apiRequestJson.calls[0].body.grants[0].pattern.display, 'npm test');
  // The web-created grant is now redeemable locally.
  const hit = grants.matchGrant({ command: 'npm run build', workspaceRoot: dir, file });
  assert.ok(hit, 'pulled grant auto-approves in its workspace');
  assert.equal(hit.grant_id, 'grant-from-web');
});

test('a web revocation is honored locally and never resurrected (fail closed)', async () => {
  const { dir, file } = tempStore();
  const root = fs.realpathSync(dir);
  const added = grants.addGrant({ command: 'npm test', workspaceRoot: dir, file });
  assert.ok(grants.matchGrant({ command: 'npm test', workspaceRoot: dir, file }));

  const apiRequestJson = fakeApi({
    ok: true,
    status: 200,
    data: {
      grants: [{
        ...added.grant,
        status: 'revoked',
        scope: { kind: 'workspace', workspace_root: root },
      }],
    },
  });

  const result = await grants.syncGrants({ apiRequestJson, token: 'tok', file });
  assert.equal(result.ok, true);
  assert.equal(result.revoked, 1);
  assert.equal(grants.matchGrant({ command: 'npm test', workspaceRoot: dir, file }), null);

  // A later sync that reports the grant active again must NOT resurrect it.
  const reactivate = fakeApi({
    ok: true,
    status: 200,
    data: { grants: [{ ...added.grant, status: 'active', scope: { kind: 'workspace', workspace_root: root } }] },
  });
  await grants.syncGrants({ apiRequestJson: reactivate, token: 'tok', file });
  assert.equal(grants.matchGrant({ command: 'npm test', workspaceRoot: dir, file }), null);
});

test('a dangerous grant from the backend is rejected on ingest and never matches', async () => {
  const { dir, file } = tempStore();
  const root = fs.realpathSync(dir);
  const apiRequestJson = fakeApi({
    ok: true,
    status: 200,
    data: {
      grants: [
        { grant_id: 'g-sudo', status: 'active', action_type: 'local_command',
          scope: { kind: 'workspace', workspace_root: root },
          pattern: { type: 'exact_argv', argv: ['sudo', 'ls'], display: 'sudo ls' }, constraints: {}, audit: {} },
        { grant_id: 'g-accept', status: 'active', action_type: 'local_command',
          scope: { kind: 'workspace', workspace_root: root },
          pattern: { type: 'argv_prefix', argv: ['atris', 'task', 'accept'], display: 'atris task accept' }, constraints: {}, audit: {} },
      ],
    },
  });

  const result = await grants.syncGrants({ apiRequestJson, token: 'tok', file });
  assert.equal(result.ok, true);
  assert.equal(result.pulled, 0);
  assert.equal(result.rejected, 2);
  assert.equal(grants.loadGrants(file).grants.length, 0, 'no dangerous grant landed in the store');
  assert.equal(grants.matchGrant({ command: 'sudo ls', workspaceRoot: dir, file }), null);
});

test('a failed sync request leaves the local store untouched', async () => {
  const { dir, file } = tempStore();
  grants.addGrant({ command: 'npm test', workspaceRoot: dir, file });
  const before = JSON.stringify(grants.loadGrants(file));

  const apiRequestJson = fakeApi({ ok: false, status: 503, error: 'backend down' });
  const result = await grants.syncGrants({ apiRequestJson, token: 'tok', file });
  assert.equal(result.ok, false);
  assert.match(result.reason, /backend down/);
  assert.equal(JSON.stringify(grants.loadGrants(file)), before, 'store unchanged after failed sync');
  // The local grant still redeems while offline.
  assert.ok(grants.matchGrant({ command: 'npm test', workspaceRoot: dir, file }));
});
