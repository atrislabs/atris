const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('force pull preserves local instructions omitted by the server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-instructions-pull-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const argv = process.argv;
  const exit = process.exit;
  const log = console.log;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  try {
    process.env.HOME = root;
    process.env.ATRIS_HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'example-co', 'atris'), { recursive: true });
    fs.writeFileSync(path.join(root, 'example-co', 'atris', 'CLAUDE.md'), 'Local instructions\n');
    process.argv = ['node', 'atris', 'pull', 'example-co', '--force'];
    process.exit = () => { throw new Error('unexpected exit'); };
    console.log = () => {};
    require('../utils/auth').saveCredentials('test-token', null, 'person@example.com', 'person', 'google');
    api.apiRequestJson = async (route) => {
      if (route === '/business/') return { ok: true, data: [{ id: 'business-one', workspace_id: 'ws-one', slug: 'example-co', name: 'Example' }] };
      if (route.includes('validate')) return { ok: true, data: { valid: true, user: { id: 'person', email: 'person@example.com', provider: 'google' } } };
      if (route.endsWith('/git/head')) return { ok: true, data: { head: null } };
      if (route.includes('/snapshot?include_content=true')) return { ok: true, data: { files: [{ path: '/team/MEMBER.md', content: 'A team member\n' }] } };
      throw new Error(`unexpected API route: ${route}`);
    };
    const { saveManifest, computeLocalHashes } = require('../lib/manifest');
    const workspace = path.join(root, 'example-co');
    saveManifest('example-co', { last_sync: '2026-05-01T12:00:00Z', workspace_root: workspace, files: computeLocalHashes(workspace) });
    const { pullAtris } = require('../commands/pull');
    await pullAtris();
    assert.equal(fs.readFileSync(path.join(root, 'example-co', 'atris', 'CLAUDE.md'), 'utf8'), 'Local instructions\n');
  } finally {
    console.log = log;
    api.apiRequestJson = request;
    process.exit = exit;
    process.argv = argv;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
