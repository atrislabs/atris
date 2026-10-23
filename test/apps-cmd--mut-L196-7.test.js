const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apps-cmd-mut-'));
const savedEnv = new Map();
const touchedEnv = [
  'HOME',
  'USERPROFILE',
  'ATRIS_API_URL',
  'ATRIS_BACKEND_URL',
  'ATRIS_APP_URL',
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_CLIENT_SECRET_FILE',
  'ATRIS_APPS_PACK',
  'ATRIS_TEST_STATE_DIR',
  'ATRIS_TEST_REAL_HOME',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'TMUX_PANE',
  'WT_SESSION',
  'WEZTERM_PANE',
];
for (const key of touchedEnv) savedEnv.set(key, process.env[key]);
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.ATRIS_TEST_STATE_DIR = root;
for (const key of touchedEnv) {
  if (key !== 'HOME' && key !== 'USERPROFILE' && key !== 'ATRIS_TEST_STATE_DIR') {
    delete process.env[key];
  }
}

const { appsCommand } = require('../commands/apps');

const SLUG = 'pack-slug';
const ID = 'pack-id';
const NAME = 'Named App';

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('cloud app list prints the slug when the slug and id differ', async (t) => {
  t.after(() => {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({
    token: 'plain-token',
    refresh_token: null,
    email: 'apps@example.com',
    user_id: 'user-apps',
    provider: 'test',
    saved_at: '2020-01-01T00:00:00.000Z',
  }));

  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/api/auth/validate' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        valid: true,
        user: { email: 'apps@example.com', id: 'user-apps', provider: 'test' },
      }));
      return;
    }
    if (req.url === '/api/apps' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apps: [{ id: ID, slug: SLUG, name: NAME }],
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  process.env.ATRIS_API_URL = `http://127.0.0.1:${port}/api`;

  let stdout = '';
  let stderr = '';
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...args) => { stdout += args.map(String).join(' ') + '\n'; };
  console.error = (...args) => { stderr += args.map(String).join(' ') + '\n'; };
  process.exit = (code = 0) => { throw new ExitSignal(code); };
  t.after(() => {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  });

  try {
    await appsCommand('load');
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    assert.fail(stderr || stdout || err.message);
  }

  assert.equal(stderr, '');
  assert.equal(stdout, `Cloud apps:\n  ${SLUG.padEnd(24)} ${NAME}\n`);
});
