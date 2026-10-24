require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('automatic business selection prefers the saved slug over its display name', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-slug-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const errors = [];
  const stopped = new Error('command stopped');
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ slug: 'garden-tools', name: 'Garden Tools' }));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'local-test-token' }));
    process.argv = [process.execPath, 'atris', 'push'];
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', (...parts) => errors.push(parts.join(' ')));
    t.mock.method(process, 'exit', () => { throw stopped; });
    const api = require('../utils/api');
    t.mock.method(api, 'httpRequest', async () => ({ statusCode: 200, data: { businesses: [] } }));
    t.mock.method(api, 'apiRequestJson', async () => ({ statusCode: 200, data: { businesses: [] } }));
    const { pushAtris } = require('../commands/push');
    try {
      await pushAtris();
    } catch (error) {
      if (error !== stopped) throw error;
    }
    assert.ok(errors.some(line => line.includes('garden-tools')), JSON.stringify(errors));
  } finally {
    t.mock.restoreAll();
    process.chdir(originalCwd);
    process.argv = originalArgv;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
