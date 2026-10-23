const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-L607-'));
const savedHome = process.env.HOME;
const savedEnv = {};
for (const key of [
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_CLIENT_SECRET_FILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_TEST_REAL_HOME',
  'ATRIS_BUSINESS_ROOT',
]) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}
process.env.HOME = home;
process.env.ATRIS_TOKEN = 'mut-l607-test-token';
process.env.ATRIS_BUSINESS_ROOT = path.join(home, 'biz-root');

// Fake the backend before the command under test loads; it binds the
// request function at require time, so this must come first.
const api = require('../utils/api');
const realApiRequestJson = api.apiRequestJson;
api.apiRequestJson = async (pathname) => {
  if (pathname === '/business/') {
    return {
      ok: true,
      data: [{ id: 'b1', slug: 'mutbiz', name: 'mutbiz', workspace_id: 'w1' }],
    };
  }
  if (pathname.endsWith('/ai-computer/status')) {
    return { ok: true, data: { status: 'running', endpoint: 'http://127.0.0.1:1' } };
  }
  if (pathname.includes('/snapshot')) {
    const files = [];
    for (let i = 0; i < 10; i++) {
      files.push({ path: `cloud-only-${String(i).padStart(2, '0')}.txt`, hash: null, size: 1 });
    }
    return { ok: true, data: { files } };
  }
  return { ok: false, status: 500, errorMessage: `unexpected call ${pathname}` };
};

const { alignAtris } = require('../commands/align');

class ExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

test('ten cloud-only files print every path and no overflow line', async () => {
  const ws = path.join(home, 'ws');
  fs.mkdirSync(path.join(ws, '.atris'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.atris', 'business.json'),
    JSON.stringify({ slug: 'mutbiz' })
  );

  const prevArgv = process.argv;
  const prevExit = process.exit;
  const prevCwd = process.cwd();
  const prevLog = console.log;
  const prevError = console.error;
  const prevWrite = process.stdout.write;
  const logs = [];
  process.argv = ['node', 'atris', 'align', 'mutbiz'];
  process.exit = (code) => { throw new ExitError(code === undefined ? 0 : code); };
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  process.stdout.write = (s) => { logs.push(String(s)); return true; };
  try {
    process.chdir(ws);
    try {
      await alignAtris();
    } catch (err) {
      if (!(err instanceof ExitError)) throw err;
    }
  } finally {
    process.argv = prevArgv;
    process.exit = prevExit;
    console.log = prevLog;
    console.error = prevError;
    process.stdout.write = prevWrite;
    try { process.chdir(prevCwd); } catch {}
  }

  const out = logs.join('\n');
  assert.ok(out.includes('Only on cloud'), 'expected the cloud-only section to print');
  assert.equal(
    out.includes('+0 more'),
    false,
    'exactly ten cloud-only paths must not print an overflow line'
  );
});

test.after(() => {
  api.apiRequestJson = realApiRequestJson;
  process.env.HOME = savedHome;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});
