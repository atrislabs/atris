'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an uncached business found by name saves the matching business id', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-match-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const api = require('../utils/api');
  const savedRequest = api.apiRequestJson;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    api.apiRequestJson = async url => {
      if (url === '/business/') {
        return { ok: true, data: [
          { id: 'other-id', slug: 'other', name: 'Other', workspace_id: 'other-space' },
          { id: 'matched-id', slug: 'studio-slug', name: 'Studio', workspace_id: 'studio-space' },
        ] };
      }
      if (url === '/business/matched-id/workspaces/studio-space/snapshot?include_content=false') {
        return { ok: true, data: { files: [] } };
      }
      throw new Error('unexpected request');
    };
    const { cleanWorkspace } = require('../commands/workspace-clean');
    process.argv = ['node', 'atris', 'clean-workspace', 'studio'];
    console.log = () => {};
    console.error = () => {};
    process.exit = code => { throw new Error(`command exited ${code}`); };
    let failure;
    try {
      await cleanWorkspace();
    } catch (error) {
      failure = error;
    }
    const cachePath = path.join(home, '.atris', 'businesses.json');
    const cached = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
    assert.equal(cached.studio?.business_id, 'matched-id', failure?.message);
  } finally {
    api.apiRequestJson = savedRequest;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});
