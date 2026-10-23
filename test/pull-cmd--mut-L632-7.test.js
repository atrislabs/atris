const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('first scoped pull previews a remote file without a saved manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-first-scoped-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const argv = process.argv;
  const exit = process.exit;
  const log = console.log;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const lines = [];
  try {
    process.env.HOME = root;
    process.env.ATRIS_HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'example-co', 'atris'), { recursive: true });
    process.argv = ['node', 'atris', 'pull', 'example-co', '--keep-local', '--only=team/', '--dry-run'];
    process.exit = () => { throw new Error('unexpected exit'); };
    console.log = (...args) => lines.push(args.join(' '));
    require('../utils/auth').saveCredentials('test-token', null, 'person@example.com', 'person', 'google');
    api.apiRequestJson = async (route) => {
      if (route === '/business/') return { ok: true, data: [{ id: 'business-one', workspace_id: 'ws-one', slug: 'example-co', name: 'Example' }] };
      if (route.includes('validate')) return { ok: true, data: { valid: true, user: { id: 'person', email: 'person@example.com', provider: 'google' } } };
      if (route.includes('/snapshot?include_content=true')) return { ok: true, data: { files: [{ path: '/team/MEMBER.md', content: 'A team member\n' }] } };
      throw new Error(`unexpected API route: ${route}`);
    };
    const { pullAtris } = require('../commands/pull');
    await pullAtris();
    assert.equal(lines.some(line => line.includes('team/MEMBER.md') && line.includes('dry run')), true);
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
