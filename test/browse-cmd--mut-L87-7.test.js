require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('template results display the supplied author', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-author-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const argv = process.argv;
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    process.argv = [process.execPath, 'atris', 'browse'];
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-login-token', refresh_token: null, email: 'reader@example.com',
      user_id: 'reader', provider: null, saved_at: '2025-01-15T12:00:00.000Z',
    }));
    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async () => ({
      ok: true,
      data: [{ name: 'garden', description: 'Garden planning', author: 'Mira Patel', agent_count: 2 }],
    }));
    t.mock.method(console, 'log', (...values) => lines.push(values.join(' ')));
    t.mock.method(console, 'error', (...values) => lines.push(values.join(' ')));
    t.mock.method(process, 'exit', code => { throw new Error(`unexpected exit ${code}`); });
    const { browseAtris } = require('../commands/browse');
    await browseAtris();
    assert.ok(lines.some(line => line.includes('Mira Patel')));
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
