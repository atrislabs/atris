require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a known empty web journal preserves local edits despite clock skew', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-known-update-'));
  const previous = { cwd: process.cwd(), home: process.env.HOME, argv: process.argv, log: console.log };
  process.env.HOME = root;
  process.chdir(root);
  process.argv = ['node', 'atris', 'log', 'sync', '--date=2020-01-15'];
  console.log = () => {};
  const auth = require('../utils/auth');
  const api = require('../utils/api');
  const originalAuth = auth.ensureValidCredentials;
  const originalRequest = api.apiRequestJson;
  t.after(() => {
    auth.ensureValidCredentials = originalAuth;
    api.apiRequestJson = originalRequest;
    process.chdir(previous.cwd);
    process.argv = previous.argv;
    console.log = previous.log;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  });
  const { saveConfig, saveLogSyncState } = require('../utils/config');
  const { computeContentHash } = require('../lib/journal');
  fs.mkdirSync(path.join(root, 'atris', 'logs', '2020'), { recursive: true });
  saveConfig({ agent_id: 'test-agent' });
  const stamp = '2020-01-16T12:00:00.000Z';
  saveLogSyncState({ '2020-01-15': { updated_at: stamp, hash: computeContentHash('') } });
  const local = '# Log, 2020-01-15\n\n## Notes\n\nKeep my first note.\n\n## Notes\n\nKeep my second note.\n';
  const journal = path.join(root, 'atris', 'logs', '2020', '2020-01-15.md');
  fs.writeFileSync(journal, local);
  fs.utimesSync(journal, new Date('2020-01-15T12:00:00.000Z'), new Date('2020-01-15T12:00:00.000Z'));
  auth.ensureValidCredentials = async () => ({ credentials: { token: 'test-token' } });
  let pushed;
  api.apiRequestJson = async (_route, options) => {
    if (options.method === 'GET') return { ok: true, data: { content: '', updated_at: stamp } };
    pushed = options.body.content;
    return { ok: true, data: { updated_at: stamp } };
  };
  const { logSyncAtris } = require('../commands/log-sync');
  await logSyncAtris();
  assert.ok(pushed.includes('Keep my first note.'));
});
