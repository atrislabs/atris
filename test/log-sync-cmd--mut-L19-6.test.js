const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a state write failure without a message retains its error fallback', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-error-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const argv = process.argv;
  const exit = process.exit;
  const api = require('../utils/api');
  const auth = require('../utils/auth');
  const config = require('../utils/config');
  const saveState = config.saveLogSyncState;
  const request = api.apiRequestJson;
  const credentials = auth.ensureValidCredentials;
  const log = console.log;
  const error = console.error;
  t.after(() => {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    process.argv = argv;
    process.exit = exit;
    api.apiRequestJson = request;
    config.saveLogSyncState = saveState;
    auth.ensureValidCredentials = credentials;
    console.log = log;
    console.error = error;
  });
  process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
  process.env.HOME = root;
  process.chdir(root);
  process.argv = ['node', 'atris', 'log', 'sync', '2020-01-15'];
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', '.config'), JSON.stringify({ agent_id: 'example-agent' }));
  api.apiRequestJson = async (_url, options) => !options.method || options.method === 'GET'
    ? { ok: false, status: 404 }
    : { ok: true, status: 200, data: {} };
  config.saveLogSyncState = () => { throw new Error(''); };
  auth.ensureValidCredentials = async () => ({ credentials: { token: 'example-token' } });
  console.log = console.error = () => {};
  const { logSyncAtris } = require('../commands/log-sync');
  let failure;
  try { await logSyncAtris(); } catch (caught) { failure = caught; }
  assert.ok(failure.message.includes('Error'));
});
