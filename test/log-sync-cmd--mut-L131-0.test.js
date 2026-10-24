const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auth = require('../utils/auth');
const api = require('../utils/api');

const apiCalls = [];
const remoteEntry = {
  ok: true,
  status: 200,
  data: {
    updated_at: '2020-06-01T00:00:00.000Z',
    content: null, // filled in the test to match the local file exactly
  },
};

api.apiRequestJson = async (pathname, options = {}) => {
  apiCalls.push({ pathname, method: options.method || 'GET' });
  if (options.method === 'PUT') {
    return { ok: true, status: 200, data: { updated_at: '2020-06-01T00:00:00.000Z' } };
  }
  return remoteEntry;
};
auth.ensureValidCredentials = async () => ({ credentials: { token: 'test-token' } });
auth.promptUser = async () => '2';

const { logSyncAtris } = require('../commands/log-sync');

test('identical remote and local content aligns timestamps instead of merging', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-log-sync-mut-'));
  const atrisDir = path.join(root, 'atris');
  const yearDir = path.join(atrisDir, 'logs', '2020');
  fs.mkdirSync(yearDir, { recursive: true });
  fs.writeFileSync(
    path.join(atrisDir, '.config'),
    JSON.stringify({ agent_id: 'agent-1', agent_name: 'Agent One' })
  );

  const localContent = '# Log 2020-01-15\n\n## Inbox\n\n- alpha\n';
  const logFile = path.join(yearDir, '2020-01-15.md');
  fs.writeFileSync(logFile, localContent, 'utf8');
  const oldMtime = new Date('2020-01-15T00:00:00.000Z');
  fs.utimesSync(logFile, oldMtime, oldMtime);

  remoteEntry.data.content = localContent;

  const origCwd = process.cwd();
  const origLog = console.log;
  const origArgv4 = process.argv[4];
  const lines = [];
  process.chdir(root);
  console.log = (...args) => lines.push(args.join(' '));
  process.argv[4] = '2020-01-15';
  t.after(() => {
    console.log = origLog;
    process.chdir(origCwd);
    if (origArgv4 === undefined) {
      delete process.argv[4];
    } else {
      process.argv[4] = origArgv4;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  await logSyncAtris();

  assert.ok(
    lines.some((line) => line.includes('Already synced (timestamps aligned with web)')),
    `expected the identical-content fast path, got:\n${lines.join('\n')}`
  );
  assert.strictEqual(
    apiCalls.filter((c) => c.method === 'PUT').length,
    0,
    'identical content must not push local to web'
  );
  assert.strictEqual(fs.readFileSync(logFile, 'utf8'), localContent);
});
