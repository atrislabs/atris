'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeContentHash } = require('../lib/journal');

async function exercise(t, { localTime, remoteTime, remote, known }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-times-'));
  const previousCwd = process.cwd();
  const previousArgs = process.argv;
  t.after(() => { process.chdir(previousCwd); process.argv = previousArgs; fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(root);
  process.argv = ['node', 'atris', 'log', 'sync', '--date=2020-01-15'];
  const file = path.join(root, 'atris', 'logs', '2020', '2020-01-15.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const local = '# Today\n\n## Notes\nlocal changes\n';
  fs.writeFileSync(file, local);
  fs.utimesSync(file, new Date(localTime), new Date(localTime));
  const api = require('../utils/api');
  const auth = require('../utils/auth');
  const config = require('../utils/config');
  let puts = 0;
  let saved = 0;
  t.mock.method(console, 'log', () => {});
  t.mock.method(config, 'loadConfig', () => ({ agent_id: 'synthetic-agent' }));
  t.mock.method(config, 'loadLogSyncState', () => known ? { '2020-01-15': known } : {});
  t.mock.method(config, 'saveLogSyncState', () => { saved++; });
  t.mock.method(auth, 'ensureValidCredentials', async () => ({ credentials: { token: 'synthetic' } }));
  t.mock.method(api, 'apiRequestJson', async (_p, opts) => {
    if (opts.method === 'PUT') { puts++; return { ok: true, data: {} }; }
    return { ok: true, data: { updated_at: remoteTime, content: remote } };
  });
  delete require.cache[require.resolve('../commands/log-sync')];
  await assert.rejects(require('../commands/log-sync').logSyncAtris(), /cannot safely|could not safely/i);
  assert.equal(fs.readFileSync(file, 'utf8'), local);
  assert.equal(puts, 0);
  assert.equal(saved, 0);
}

test('equal timestamps with different content are not treated as identical', async t => {
  await exercise(t, { localTime: '2020-01-16T00:00:00Z', remoteTime: '2020-01-16T00:00:00Z', remote: '# Remote\n' });
});
test('newer local content does not overwrite changed remote even with matching old timestamp', async t => {
  await exercise(t, { localTime: '2020-01-17T00:00:00Z', remoteTime: '2020-01-16T00:00:00Z', remote: '# Changed remote\n', known: { updated_at: '2020-01-16T00:00:00Z', hash: computeContentHash('# Old remote\n') } });
});
test('missing remote timestamp does not trigger an unconditional overwrite', async t => {
  await exercise(t, { localTime: '2020-01-17T00:00:00Z', remoteTime: null, remote: '# Remote\n' });
});
test('newer empty remote does not save a fictitious merged baseline', async t => {
  const local = '# Today\n\n## Notes\nlocal changes\n';
  await exercise(t, { localTime: '2020-01-15T00:00:00Z', remoteTime: '2020-01-16T00:00:00Z', remote: '', known: { updated_at: '2020-01-14T00:00:00Z', hash: computeContentHash(local) } });
});
test('remote section removal does not save a fictitious merged baseline', async t => {
  const local = '# Today\n\n## Notes\nlocal changes\n';
  await exercise(t, { localTime: '2020-01-15T00:00:00Z', remoteTime: '2020-01-16T00:00:00Z', remote: '# Today\n\n## Inbox\nremote only\n', known: { updated_at: '2020-01-14T00:00:00Z', hash: computeContentHash(local) } });
});
