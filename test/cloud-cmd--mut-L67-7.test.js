'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cached-name-'));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { collectCloudOrphans } = require('../commands/cloud');

test('cached business display name survives an unavailable business listing', async () => {
  try {
    const workspace = fs.mkdtempSync(path.join(home, 'workspace-'));
    const result = await collectCloudOrphans(workspace, 'example-co', {
      loadCredentials: () => ({ token: 'test-token' }),
      loadBusinesses: () => ({
        'example-co': {
          business_id: 'biz-1',
          workspace_id: 'ws-1',
          name: 'Example Company',
          slug: 'example-co',
        },
      }),
      apiRequestJson: async (pathname) => {
        if (pathname === '/business/') return { ok: false, status: 503 };
        if (pathname === '/business/biz-1/workspaces/ws-1/snapshot?include_content=false') {
          return { ok: true, status: 200, data: { files: [] } };
        }
        throw new Error('Unexpected request');
      },
      computeLocalHashes: () => ({}),
    });
    assert.strictEqual(result.businessName, 'Example Company');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
