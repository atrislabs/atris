require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('a push without deletions can upload without delete permission', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-no-delete-'));
  const cwd = process.cwd();
  const argv = process.argv;
  const env = { ...process.env };
  const output = [];
  let uploadedPath;
  const stopped = new Error('exit intercepted');
  try {
    process.env.HOME = root;
    process.env.ATRIS_HOME = root;
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    process.chdir(workspace);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    fs.writeFileSync(path.join(workspace, 'README.md'), 'A changed document.\n');
    process.argv = [process.execPath, 'atris', 'push', 'example-co', '--from', workspace, '--yes'];
    t.mock.method(api, 'apiRequestJson', async (route, options) => {
      if (route === '/business/') return { ok: true, data: [{ id: 'business-one', workspace_id: 'ws-one', slug: 'example-co', name: 'Example' }] };
      if (route.endsWith('/git/head')) return { ok: true, data: { head: null } };
      if (route.endsWith('/snapshot?include_content=false')) return { ok: true, data: { files: [] } };
      if (route.includes('/sync?')) {
        uploadedPath = options.body.files[0].path;
        return { ok: true, data: { synced: 1 } };
      }
      throw new Error(`unhandled route: ${route}`);
    });
    t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
    t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
    t.mock.method(process, 'exit', () => { throw stopped; });
    const { pushAtris } = require('../commands/push');
    try { await pushAtris(); } catch (error) { if (error !== stopped) throw error; }
    assert.doesNotMatch(output.join('\n'), /Refusing to delete/);
    assert.equal(uploadedPath, 'README.md');
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
