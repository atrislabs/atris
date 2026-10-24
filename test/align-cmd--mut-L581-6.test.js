require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('matching cloud content does not report hash drift', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'align-hash-'));
  const previous = { env: { ...process.env }, cwd: process.cwd(), argv: process.argv,
    log: console.log, error: console.error, exit: process.exit };
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const output = [];
  const content = '# Workspace\n';
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  try {
    process.env.HOME = home;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token', refresh_token: null, email: 'test@example.com', user_id: null, provider: null, saved_at: '2025-01-15T12:00:00.000Z' }));
    fs.writeFileSync(path.join(home, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co', business_id: 'biz', workspace_id: 'ws' }));
    fs.writeFileSync(path.join(home, 'README.md'), content);
    api.apiRequestJson = async (url) => {
      if (url === '/business/') return { ok: true, data: [{ id: 'biz', workspace_id: 'ws', slug: 'example-co', name: 'Example' }] };
      if (url.endsWith('/ai-computer/status')) return { ok: true, data: { status: 'running', endpoint: 'https://unused.example' } };
      if (url.includes('/workspaces') && !url.includes('/snapshot')) return { ok: true, data: [{ id: 'ws', name: 'default', is_default: true }] };
      if (url.includes('/snapshot')) return { ok: true, data: { files: [{ path: '/README.md', hash, content }] } };
      throw new Error(`unexpected request: ${url}`);
    };
    const { alignAtris } = require('../commands/align');
    process.chdir(home);
    process.argv = ['node', 'atris', 'align', 'example-co', '--dry-run'];
    console.log = console.error = (...args) => output.push(args.join(' '));
    const exit = new Error('command exit');
    process.exit = () => { throw exit; };
    try { await alignAtris(); } catch (error) { if (error !== exit) throw error; }
    assert.match(output.join('\n'), /Hash differ:\s+0\b/);
  } finally {
    api.apiRequestJson = request;
    process.chdir(previous.cwd);
    process.argv = previous.argv;
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
    for (const key of Object.keys(process.env)) if (!(key in previous.env)) delete process.env[key];
    Object.assign(process.env, previous.env);
  }
});
