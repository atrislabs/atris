'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('resolves a listed business to its workspace', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-lookup-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  t.after(() => {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });

  const api = require('../utils/api');
  t.mock.method(api, 'apiRequestJson', async () => ({
    ok: true,
    data: [{ id: 'business-42', slug: 'sample-co', name: 'Sample Company', workspace_id: 'workspace-73' }],
  }));
  const { resolveBusiness } = require('../commands/terminal');
  const result = await resolveBusiness('test-token', 'sample-co');
  assert.equal(result && result.workspaceId, 'workspace-73');
});
