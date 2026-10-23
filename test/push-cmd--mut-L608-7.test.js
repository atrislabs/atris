const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('push accepts cloud content matching the saved sync baseline', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-push-'));
  const cwd = process.cwd();
  const argv = process.argv;
  const env = { ...process.env };
  const logs = [];
  const api = require('../utils/api');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    process.chdir(workspace);
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    const body = 'A synced document.\n';
    fs.writeFileSync(path.join(workspace, 'README.md'), body);
    require('../lib/manifest').saveManifest('acme', {
      last_sync: '2025-01-15T12:00:00.000Z',
      last_commit: null,
      workspace_root: workspace,
      files: { '/README.md': { hash: crypto.createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body) } },
    });
    t.mock.method(api, 'apiRequestJson', async (endpoint) => {
      if (endpoint === '/business/') return { ok: true, data: [{ slug: 'acme', id: 'business-acme', name: 'Acme', workspace_id: 'workspace-acme' }] };
      if (endpoint.endsWith('/snapshot?include_content=false')) return { ok: true, data: { files: [{ path: '/README.md', hash: crypto.createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body) }] } };
      throw new Error(`unexpected request: ${endpoint}`);
    });
    t.mock.method(process.stdout, 'write', (chunk) => { logs.push(String(chunk)); return true; });
    t.mock.method(console, 'log', (...parts) => logs.push(parts.join(' ')));
    t.mock.method(console, 'error', (...parts) => logs.push(parts.join(' ')));
    const stopped = new Error('exit');
    t.mock.method(process, 'exit', () => { throw stopped; });
    process.argv = [process.execPath, 'atris', 'push', 'acme', '--from', workspace, '--dry-run'];
    const { pushAtris } = require('../commands/push');
    try { await pushAtris(); } catch (error) { if (error !== stopped) throw error; }
    assert.match(logs.join('\n'), /already up to date/i);
  } finally {
    t.mock.restoreAll();
    process.chdir(cwd);
    process.argv = argv;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
