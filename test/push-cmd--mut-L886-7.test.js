const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('individual upload failure retains the API error beside its file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-error-detail-'));
  const cwd = process.cwd();
  const argv = process.argv;
  const env = { ...process.env };
  const output = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.ATRIS_HOME = root;
    process.env.TERM_SESSION_ID = 'push-error-detail-test';
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    fs.writeFileSync(path.join(workspace, 'first.md'), 'First document.\n');
    fs.writeFileSync(path.join(workspace, 'second.md'), 'Second document.\n');
    process.chdir(workspace);
    process.argv = [process.execPath, 'atris', 'push', 'example-co', '--from', workspace, '--force'];
    t.mock.method(api, 'apiRequestJson', async (route, options) => {
      if (route === '/business/') return { ok: true, status: 200, data: [{ id: 'business-one', workspace_id: 'workspace-one', slug: 'example-co', name: 'Example' }] };
      if (route.includes('/sync?')) {
        if (options.body.files.length > 1) return { ok: false, status: 413, error: 'Payload too large' };
        if (options.body.files[0].path === 'first.md') return { ok: false, status: 422, data: { detail: 'Document rejected' }, error: 'Document rejected' };
        return { ok: true, status: 200, data: { synced: 1 } };
      }
      if (route === '/atris-sync/telemetry') return { ok: true, status: 200 };
      throw new Error(`unexpected API route: ${route}`);
    });
    t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
    t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
    t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit: ${code}`); });
    const { pushAtris } = require('../commands/push');
    await pushAtris();
    assert.match(output.find(line => line.includes('✗ first.md')) || '', /Document rejected/);
  } finally {
    t.mock.restoreAll();
    process.chdir(cwd);
    process.argv = argv;
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  }
});
