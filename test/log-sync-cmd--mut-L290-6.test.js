require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('pulls changed remote content despite an older timestamp when local content matches sync history', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-case-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const argv = process.argv;
  const exit = process.exit;
  const log = console.log;
  const request = api.apiRequestJson;
  t.after(() => {
    process.chdir(cwd);
    process.env = env;
    process.argv = argv;
    process.exit = exit;
    console.log = log;
    api.apiRequestJson = request;
  });
  process.env = { HOME: root, ATRIS_TOKEN: 'test-token' };
  process.chdir(root);
  process.argv = ['node', 'atris', 'log', 'sync', '2020-01-15'];
  process.exit = (code) => { throw new Error(`exit ${code}`); };
  console.log = () => {};
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', '.config'), JSON.stringify({ agent_id: 'journal-agent' }));
  const local = '# Log, 2020-01-15\n\n## Notes\nold note\n';
  const localPath = path.join(root, 'atris/logs/2020/2020-01-15.md');
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, local);
  fs.utimesSync(localPath, new Date('2020-01-16T12:00:00Z'), new Date('2020-01-16T12:00:00Z'));
  fs.writeFileSync(path.join(root, 'atris/.log_sync_state.json'), JSON.stringify({ '2020-01-15': { updated_at: '2020-01-16T12:00:00Z', hash: require('../lib/journal').computeContentHash(local) } }));
  api.apiRequestJson = async (...args) => {
    if (args[1].method === 'PUT') throw new Error('unexpected upload');
    return { ok: true, data: { valid: true, user: {}, content: '# Log, 2020-01-15\n\n## Notes\nremote note\n', updated_at: '2020-01-14T12:00:00Z' } };
  };
  const { logSyncAtris } = require('../commands/log-sync');
  await logSyncAtris();
  assert.equal(fs.readFileSync(localPath, 'utf8').includes('remote note'), true);
});
