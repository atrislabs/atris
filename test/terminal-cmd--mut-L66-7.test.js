'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('business slug selects a business with a different display name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-match-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedRequest = api.apiRequestJson;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    api.apiRequestJson = async () => ({
      ok: true,
      status: 200,
      data: [{ id: 'business-selected', slug: 'garden-co', name: 'Garden Company', workspace_id: 'garden-workspace' }],
    });
    const { resolveBusiness } = require('../commands/terminal');
    const result = await resolveBusiness('test-token', 'garden-co');
    assert.equal(result && result.businessId, 'business-selected');
  } finally {
    api.apiRequestJson = savedRequest;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
