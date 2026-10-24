require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('default pull restores cloud content over local edits after an earlier sync', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-overwrite-'));
  const workspace = path.join(home, 'workspace');
  const saved = {
    env: { ...process.env }, cwd: process.cwd(), argv: process.argv,
    exit: process.exit, log: console.log, error: console.error,
    write: process.stdout.write,
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.HOME = home;
  process.env.PATH = saved.env.PATH || '';
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  try {
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(home, '.atris', 'businesses', 'example'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    const content = 'cloud copy\n';
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    fs.writeFileSync(path.join(workspace, 'note.md'), 'local edits\n');
    fs.writeFileSync(path.join(home, '.atris', 'businesses', 'example', 'manifest.json'), JSON.stringify({
      workspace_root: workspace,
      files: { '/note.md': { hash, size: Buffer.byteLength(content) } },
    }));
    api.apiRequestJson = async (url) => {
      if (url === '/business/') {
        return { ok: true, data: [{ id: 'business', workspace_id: 'workspace', slug: 'example', name: 'Example' }] };
      }
      if (url.startsWith('/business/business/workspaces/workspace/snapshot?')) {
        const file = { path: '/note.md', hash, size: Buffer.byteLength(content) };
        if (new URL(url, 'https://example.invalid').searchParams.get('include_content') === 'true') {
          file.content = content;
        }
        return { ok: true, data: { files: [file] } };
      }
      if (url === '/atris-sync/telemetry') return { ok: true };
      throw new Error(`unexpected request: ${url}`);
    };
    const { pullAtris } = require('../commands/pull');
    process.chdir(workspace);
    process.argv = ['node', 'atris', 'pull', 'example', '--into', workspace];
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    console.log = console.error = () => {};
    process.stdout.write = () => true;
    await pullAtris();
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'note.md'), 'utf8'), content);
  } finally {
    api.apiRequestJson = request;
    process.chdir(saved.cwd);
    process.argv = saved.argv;
    process.exit = saved.exit;
    console.log = saved.log;
    console.error = saved.error;
    process.stdout.write = saved.write;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
  }
});
