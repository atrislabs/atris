const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a failed automatic merge shows the remote note before asking which version to keep', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-recovery-'));
  const original = {
    cwd: process.cwd(), home: process.env.HOME, argv: process.argv,
    log: console.log, write: process.stdout.write, exit: process.exit,
  };
  process.env.HOME = root;
  process.chdir(root);
  process.argv = ['node', 'atris', 'log', 'sync', '2020-01-15'];
  const api = require('../utils/api');
  const auth = require('../utils/auth');
  const journal = require('../lib/journal');
  const request = api.apiRequestJson;
  const prompt = auth.promptUser;
  const merge = journal.mergeSections;
  let output = '';
  t.after(() => {
    api.apiRequestJson = request;
    auth.promptUser = prompt;
    journal.mergeSections = merge;
    console.log = original.log;
    process.stdout.write = original.write;
    process.exit = original.exit;
    process.argv = original.argv;
    process.chdir(original.cwd);
    if (original.home === undefined) delete process.env.HOME;
    else process.env.HOME = original.home;
  });
  console.log = (...args) => { output += args.join(' ') + '\n'; };
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  process.exit = (code) => { throw new Error(`exit ${code}`); };
  const logFile = path.join(root, 'atris', 'logs', '2020', '2020-01-15.md');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '# Log, 2020-01-15\n\n## Notes\nprevious note\n');
  fs.utimesSync(logFile, 1579046400, 1579046400);
  fs.writeFileSync(path.join(root, 'atris', '.config'), JSON.stringify({ agent_id: 'test-agent' }));
  fs.mkdirSync(path.join(root, '.atris'));
  fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({
    token: 'test-token', refresh_token: null, email: null, user_id: null,
    provider: null, saved_at: '2020-01-15T12:00:00Z',
  }));
  api.apiRequestJson = async (url, options) => {
    if (url === '/auth/validate') return { ok: true, data: { valid: true } };
    if (url === '/agents/test-agent/journal/2020-01-15' && options.method === 'GET') {
      return { ok: true, data: {
        updated_at: '2020-01-16T12:00:00Z',
        content: '# Log, 2020-01-15\n\n## Notes\nremote-note-marker\n',
      } };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  journal.mergeSections = () => { throw new Error('automatic merge unavailable'); };
  auth.promptUser = async () => '1';
  const { logSyncAtris } = require('../commands/log-sync');
  await logSyncAtris();
  assert.ok(output.includes('remote-note-marker'));
});
