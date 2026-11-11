'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentClientCommand } = require('../commands/agent-client');

const EXPECTED_ERR = 'agent clients are managed with your own login, not an agent client. sign in as yourself: atris login --force';

test('agentClientCommand rejects when ensured source is agent_client even if credentials is not an agent client credential record', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-mut-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const errLines = [];
  const logLines = [];
  const code = await agentClientCommand(['list'], {
    log: (msg) => logLines.push(String(msg)),
    err: (msg) => errLines.push(String(msg)),
    readActiveCredentials: () => null,
    ensureValidCredentials: async () => ({
      source: 'agent_client',
      credentials: { token: 'mock-token' },
    }),
    apiRequestJson: async () => ({ ok: true, data: { clients: [] } }),
    listProfiles: () => [],
  });

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errLines, [EXPECTED_ERR]);
  assert.deepStrictEqual(logLines, []);
});

test('agentClientCommand rejects when credentials is an agent client credential record even if ensured source is not agent_client', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-mut-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const errLines = [];
  const logLines = [];
  const code = await agentClientCommand(['list'], {
    log: (msg) => logLines.push(String(msg)),
    err: (msg) => errLines.push(String(msg)),
    readActiveCredentials: () => null,
    ensureValidCredentials: async () => ({
      source: 'env',
      credentials: {
        auth_type: 'agent_client',
        client_id: 'atc_test123',
        token: 'mock-token',
      },
    }),
    apiRequestJson: async () => ({ ok: true, data: { clients: [] } }),
    listProfiles: () => [],
  });

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errLines, [EXPECTED_ERR]);
  assert.deepStrictEqual(logLines, []);
});

test('the error names the saved login to switch back to, not a placeholder', async () => {
  const errLines = [];
  const profiles = {
    keshavrao250: { token: 'jwt', email: 'keshavrao250@gmail.com' },
    nightly: { auth_type: 'agent_client', client_id: 'atc_x', token: 't' },
  };
  const code = await agentClientCommand(['revoke', 'atc_x'], {
    log: () => {},
    err: (msg) => errLines.push(String(msg)),
    readActiveCredentials: () => ({ auth_type: 'agent_client', client_id: 'atc_x' }),
    listProfiles: () => Object.keys(profiles),
    loadProfile: (name) => profiles[name],
    apiRequestJson: async () => { throw new Error('must not call the server'); },
  });
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errLines, ['agent clients are managed with your own login, not an agent client. switch back: atris switch keshavrao250 --global']);
  assert.doesNotMatch(errLines[0], /<you>/);
});

test('an unknown scope from the server comes back with the scopes you can use', async () => {
  const errLines = [];
  const code = await agentClientCommand(['create', '--name', 'bot', '--scopes', 'mcp:read'], {
    log: () => {},
    err: (msg) => errLines.push(String(msg)),
    readActiveCredentials: () => null,
    ensureValidCredentials: async () => ({ source: 'file', credentials: { token: 'jwt' } }),
    apiRequestJson: async () => ({ ok: false, status: 400, data: { detail: 'Unknown scope: mcp:read' } }),
  });
  assert.strictEqual(code, 1);
  assert.match(errLines.join('\n'), /Unknown scope: mcp:read\. scopes you can use: x-search, youtube/);
  assert.match(errLines.join('\n'), /mcp:workspace:read/);
});
