'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentClientCommand } = require('../commands/agent-client');

const EXPECTED_ERR = 'agent clients are managed with your own login, not an agent client. run: atris switch <you> or atris login --force';

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
  });

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errLines, [EXPECTED_ERR]);
  assert.deepStrictEqual(logLines, []);
});
