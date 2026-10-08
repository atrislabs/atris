'use strict';

// Agent self-login: owner commands, `atris login --client-id`, env sign-in,
// renew before expiry, one retry after a 401, and no secret or token in output.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const CLIENT_ID = 'atc_test123';
const SECRET = 'atcs_supersecretvalue_DO_NOT_PRINT';

const ENV_KEYS = [
  'HOME', 'ATRIS_TOKEN', 'ATRIS_PROFILE', 'ATRIS_API_URL', 'ATRIS_BACKEND_URL',
  'ATRIS_CLIENT_ID', 'ATRIS_CLIENT_SECRET', 'ATRIS_CLIENT_SECRET_FILE', 'ATRIS_AGENT_TOKEN_FILE',
];

function jwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

function agentJwt(n) {
  return jwt({ type: 'agent_access', n, exp: Math.floor(Date.now() / 1000) + 3600 });
}

// Which minted token this is. The exp claim moves with the clock, so tests
// compare the counter, never the whole string.
function tokenNumber(token) {
  return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).n;
}

function humanJwt() {
  return jwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 });
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function makeTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agent-client-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { dir, home };
}

function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = text;
      if ((req.headers['content-type'] || '').includes('application/json') && text) {
        try { body = JSON.parse(text); } catch {}
      }
      if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(text));
      }
      const request = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      };
      requests.push(request);
      Promise.resolve()
        .then(() => handler(request, requests))
        .catch((error) => ({ status: 500, body: { error: String(error.message || error) } }))
        .then((response) => {
          res.statusCode = (response && response.status) || 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify((response && response.body) || {}));
        });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function runCli(args, { cwd, env = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_NONINTERACTIVE: '1',
        ATRIS_TOKEN: '',
        ATRIS_PROFILE: '',
        ATRIS_CLIENT_ID: '',
        ATRIS_CLIENT_SECRET: '',
        ATRIS_CLIENT_SECRET_FILE: '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`cli hung: ${args.join(' ')}`)); }, timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

// In-process tests change env; put it back after each one.
function withEnv(values, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) if (!(key in values)) delete process.env[key];
  Object.assign(process.env, values);
  const restore = () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

function writeHumanLogin(home, extra = {}) {
  const dir = path.join(home, '.atris');
  fs.mkdirSync(dir, { recursive: true });
  const creds = { token: humanJwt(), refresh_token: 'rt', email: 'owner@example.com', user_id: 'user-1', provider: 'atris', ...extra };
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(creds));
  return creds;
}

function writeSecretFile(dir, secret = SECRET) {
  const file = path.join(dir, 'client.secret');
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return file;
}

function setupAgentClientLogin(home, secretFile, { token, expiresAt }) {
  const dir = path.join(home, '.atris', 'agent-clients');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
    auth_type: 'agent_client', client_id: CLIENT_ID, client_secret_file: secretFile, scope: null,
  }));
  if (token) {
    fs.writeFileSync(path.join(dir, `${CLIENT_ID}.token.json`), JSON.stringify({
      client_id: CLIENT_ID, access_token: token, scope: 'mcp:read x-search', expires_at: new Date(expiresAt).toISOString(),
    }));
  }
}

function freshModules() {
  for (const rel of ['../utils/api', '../utils/auth', '../utils/agent-client', '../commands/auth', '../commands/agent-client']) {
    delete require.cache[require.resolve(rel)];
  }
  return {
    api: require('../utils/api'),
    auth: require('../utils/auth'),
    agentClient: require('../utils/agent-client'),
    authCmd: require('../commands/auth'),
    ownerCmd: require('../commands/agent-client'),
  };
}

function tokenHandler(counter, { status = 200, body } = {}) {
  return () => {
    counter.n += 1;
    if (status !== 200) return { status, body };
    return { body: { access_token: agentJwt(counter.n), token_type: 'Bearer', expires_in: 900, scope: 'mcp:read x-search' } };
  };
}

function assertNoSecrets(text, extra = []) {
  for (const value of [SECRET, ...extra]) {
    if (value) assert.ok(!String(text).includes(value), `output leaked a secret or token: ${value.slice(0, 12)}...`);
  }
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(String(text)), 'output leaked a JWT');
}

// ---------------------------------------------------------------- owner commands

test('agent-client create, list, revoke, rotate over mocked HTTP', async () => {
  const { dir, home } = makeTemp();
  const human = writeHumanLogin(home);
  const { server, requests, url } = await startServer((req) => {
    if (req.url === '/api/auth/validate') return { body: { valid: true, user: { id: 'user-1', email: 'owner@example.com', provider: 'atris' } } };
    if (req.method === 'POST' && req.url === '/api/auth/agent-clients') {
      return { body: { client_id: CLIENT_ID, client_secret: SECRET, name: req.body.name, scopes: req.body.scopes } };
    }
    if (req.method === 'GET' && req.url === '/api/auth/agent-clients') {
      return { body: { clients: [{ client_id: CLIENT_ID, name: 'bot', scopes: ['mcp:read'], last_used_at: null }] } };
    }
    if (req.method === 'DELETE' && req.url === `/api/auth/agent-clients/${CLIENT_ID}`) return { body: { ok: true } };
    if (req.method === 'POST' && req.url === `/api/auth/agent-clients/${CLIENT_ID}/rotate-secret`) {
      return { body: { client_id: CLIENT_ID, client_secret: `${SECRET}_2` } };
    }
    return { status: 404, body: { detail: 'nope' } };
  });
  const env = { HOME: home, ATRIS_API_URL: `${url}/api` };
  try {
    const created = await runCli(['agent-client', 'create', '--name', 'bot', '--scopes', 'mcp:read,x-search', '--daily-credit-cap', '25', '--ttl', '900'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /store this secret now, it will not be shown again/);
    assert.equal(created.stdout.split(SECRET).length - 1, 1, 'secret printed exactly once');
    assert.ok(!created.stderr.includes(SECRET));
    const createReq = requests.find((r) => r.method === 'POST' && r.url === '/api/auth/agent-clients');
    assert.deepEqual(createReq.body, { name: 'bot', scopes: ['mcp:read', 'x-search'], daily_credit_cap: 25, token_ttl_seconds: 900 });
    assert.equal(createReq.authorization, `Bearer ${human.token}`);

    const listed = await runCli(['agent-client', 'list'], { cwd: dir, env });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /atc_test123 {2}bot {2}scopes: mcp:read/);

    const revoked = await runCli(['agent-client', 'revoke', CLIENT_ID], { cwd: dir, env });
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.match(revoked.stdout, /revoked atc_test123/);

    const secretFile = path.join(dir, 'rotated.secret');
    const rotated = await runCli(['agent-client', 'rotate', CLIENT_ID, '--secret-file', secretFile], { cwd: dir, env });
    assert.equal(rotated.status, 0, rotated.stderr);
    assertNoSecrets(rotated.stdout + rotated.stderr, [`${SECRET}_2`]);
    assert.equal(fs.readFileSync(secretFile, 'utf8').trim(), `${SECRET}_2`);
    assert.equal(mode(secretFile), 0o600);
    assert.match(rotated.stdout, /secret saved to .*rotated\.secret/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent-client create --secret-file writes 0600 and never prints the secret, even with --json', async () => {
  const { dir, home } = makeTemp();
  const calls = [];
  const { ownerCmd } = freshModules();
  const out = [];
  const err = [];
  const secretFile = path.join(dir, 'new.secret');
  const code = await withEnv({ HOME: home }, () => ownerCmd.agentClientCommand(
    ['create', '--name', 'bot', '--scopes', 'mcp:read', '--secret-file', secretFile, '--json'],
    {
      log: (line) => out.push(line),
      err: (line) => err.push(line),
      readActiveCredentials: () => null,
      ensureValidCredentials: async () => ({ credentials: { token: 'human-token' }, user: null }),
      apiRequestJson: async (p, opts) => { calls.push({ p, opts }); return { ok: true, status: 200, data: { client_id: CLIENT_ID, client_secret: SECRET, name: 'bot' } }; },
    },
  ));
  try {
    assert.equal(code, 0);
    assertNoSecrets(out.join('\n') + err.join('\n'));
    const payload = JSON.parse(out[0]);
    assert.equal(payload.client_id, CLIENT_ID);
    assert.equal(payload.secret_file, secretFile);
    assert.equal(payload.client_secret, undefined);
    assert.equal(mode(secretFile), 0o600);
    assert.equal(fs.readFileSync(secretFile, 'utf8').trim(), SECRET);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent-client refuses to run as an agent client and checks its arguments', async () => {
  const { ownerCmd } = freshModules();
  const err = [];
  const deps = {
    log: () => {},
    err: (line) => err.push(line),
    readActiveCredentials: () => ({ auth_type: 'agent_client', client_id: CLIENT_ID }),
    ensureValidCredentials: async () => { throw new Error('must not be called'); },
    apiRequestJson: async () => { throw new Error('must not be called'); },
  };
  assert.equal(await ownerCmd.agentClientCommand(['list'], deps), 1);
  assert.match(err.pop(), /your own login/);
  assert.match(ownerCmd.parseAgentClientArgs(['create', '--scopes', 'a']).error, /--name/);
  assert.match(ownerCmd.parseAgentClientArgs(['create', '--name', 'x']).error, /--scopes/);
  assert.match(ownerCmd.parseAgentClientArgs(['revoke']).error, /revoke <client_id>/);
  assert.match(ownerCmd.parseAgentClientArgs(['rotate', 'nope']).error, /atc_/);
  assert.match(ownerCmd.parseAgentClientArgs(['create', '--name', 'x', '--scopes', 'a', '--ttl', '-5']).error, /--ttl/);
});

// ---------------------------------------------------------------- agent login

test('atris login --client-id --client-secret-file stores a 0600 reference, caches the token, prints neither', async () => {
  const { dir, home } = makeTemp();
  writeHumanLogin(home);
  const counter = { n: 0 };
  const { server, requests, url } = await startServer((req) => (req.url === '/oauth/token' ? tokenHandler(counter)() : { status: 404 }));
  try {
    const secretFile = writeSecretFile(dir);
    const result = await runCli(['login', '--client-id', CLIENT_ID, '--client-secret-file', secretFile], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_URL: `${url}/api` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /signed in as agent client atc_test123/);
    assert.match(result.stdout, /switch back: atris switch owner/);

    const tokenReq = requests.find((r) => r.url === '/oauth/token');
    assert.equal(tokenReq.method, 'POST');
    assert.match(tokenReq.contentType, /application\/x-www-form-urlencoded/);
    assert.deepEqual(tokenReq.body, { grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: SECRET });
    assert.equal(tokenReq.authorization, undefined);

    const credsPath = path.join(home, '.atris', 'credentials.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    assert.equal(creds.auth_type, 'agent_client');
    assert.equal(creds.client_id, CLIENT_ID);
    assert.equal(creds.client_secret_file, secretFile);
    assert.ok(!fs.readFileSync(credsPath, 'utf8').includes(SECRET));
    assert.equal(mode(credsPath), 0o600);

    const cachePath = path.join(home, '.atris', 'agent-clients', `${CLIENT_ID}.token.json`);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(tokenNumber(cache.access_token), 1);
    assert.ok(Date.parse(cache.expires_at) > Date.now() + 800 * 1000);
    assert.equal(mode(cachePath), 0o600);
    assert.ok(fs.existsSync(path.join(home, '.atris', 'profiles', 'owner.json')), 'human login kept as a profile');

    assertNoSecrets(result.stdout + result.stderr, [cache.access_token]);

    const whoami = await runCli(['whoami', '--json'], { cwd: dir, env: { HOME: home, ATRIS_API_URL: `${url}/api` } });
    assert.equal(whoami.status, 0, whoami.stderr);
    assert.equal(JSON.parse(whoami.stdout).client_id, CLIENT_ID);
    assert.equal(counter.n, 1, 'whoami reused the cached token');
    assertNoSecrets(whoami.stdout + whoami.stderr, [cache.access_token]);

    const logout = await runCli(['logout'], { cwd: dir, env: { HOME: home } });
    assert.equal(logout.status, 0, logout.stderr);
    assert.ok(!fs.existsSync(credsPath));
    assert.ok(!fs.existsSync(cachePath));
    assert.ok(fs.existsSync(secretFile), 'never deletes a secret file the person owns');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris login with ATRIS_CLIENT_ID + ATRIS_CLIENT_SECRET keeps a private 0600 copy of the secret', async () => {
  const { dir, home } = makeTemp();
  const counter = { n: 0 };
  const { server, url } = await startServer((req) => (req.url === '/oauth/token' ? tokenHandler(counter)() : { status: 404 }));
  try {
    const result = await runCli(['login', '--json'], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_URL: `${url}/api`, ATRIS_CLIENT_ID: CLIENT_ID, ATRIS_CLIENT_SECRET: SECRET },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.client_id, CLIENT_ID);
    assertNoSecrets(result.stdout + result.stderr, [agentJwt(1)]);
    const managed = path.join(home, '.atris', 'agent-clients', `${CLIENT_ID}.secret`);
    assert.equal(fs.readFileSync(managed, 'utf8').trim(), SECRET);
    assert.equal(mode(managed), 0o600);
    const creds = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'credentials.json'), 'utf8'));
    assert.equal(creds.client_secret_file, managed);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('whoami signs in from ATRIS_CLIENT_ID + ATRIS_CLIENT_SECRET_FILE and later processes reuse the cache', async () => {
  const { dir, home } = makeTemp();
  const counter = { n: 0 };
  const { server, url } = await startServer((req) => (req.url === '/oauth/token' ? tokenHandler(counter)() : { status: 404 }));
  try {
    const secretFile = writeSecretFile(dir);
    const env = { HOME: home, ATRIS_API_URL: `${url}/api`, ATRIS_CLIENT_ID: CLIENT_ID, ATRIS_CLIENT_SECRET_FILE: secretFile };
    const first = await runCli(['whoami', '--json'], { cwd: dir, env });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).client_id, CLIENT_ID);
    const second = await runCli(['whoami', '--json'], { cwd: dir, env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(counter.n, 1, 'second process used the cached token');
    assertNoSecrets(first.stdout + first.stderr + second.stdout + second.stderr, [agentJwt(1)]);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed sign-in never echoes the secret, and a secret on the command line is refused', async () => {
  const { dir, home } = makeTemp();
  const { server, url } = await startServer(() => ({
    status: 401,
    body: { error: 'invalid_client', error_description: `bad secret ${SECRET} for client` },
  }));
  try {
    const secretFile = writeSecretFile(dir);
    const failed = await runCli(['login', '--client-id', CLIENT_ID, '--client-secret-file', secretFile], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_URL: `${url}/api` },
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /invalid_client/);
    assertNoSecrets(failed.stdout + failed.stderr);
    assert.ok(!fs.existsSync(path.join(home, '.atris', 'credentials.json')), 'nothing saved on failure');

    const inline = await runCli(['login', '--client-id', CLIENT_ID, `--client-secret=${SECRET}`], { cwd: dir, env: { HOME: home } });
    assert.equal(inline.status, 1);
    assert.match(inline.stderr, /--client-secret-file/);
    assertNoSecrets(inline.stdout + inline.stderr);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bare atris login with env set signs the agent in, no browser, and says where the secret copy went', async () => {
  const { dir, home } = makeTemp();
  const counter = { n: 0 };
  const { server, requests, url } = await startServer((req) => (req.url === '/oauth/token' ? tokenHandler(counter)() : { status: 404 }));
  try {
    // No --json, no ATRIS_NONINTERACTIVE: the same call a person would type.
    const result = await runCli(['login'], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_URL: `${url}/api`, ATRIS_NONINTERACTIVE: '', ATRIS_CLIENT_ID: CLIENT_ID, ATRIS_CLIENT_SECRET: SECRET },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /signed in as agent client atc_test123/);
    assert.doesNotMatch(result.stdout, /Choose login method|Opening browser/);
    const managed = path.join(home, '.atris', 'agent-clients', `${CLIENT_ID}.secret`);
    assert.ok(result.stdout.includes(`copied the secret from ATRIS_CLIENT_SECRET to ${managed}`));
    assertNoSecrets(result.stdout + result.stderr, [agentJwt(1)]);
    assert.equal(requests.filter((r) => r.url === '/oauth/token').length, 1);

    // After that one login, a command that only reads the saved login sees the token.
    await withEnv({ HOME: home, ATRIS_CLIENT_ID: CLIENT_ID, ATRIS_CLIENT_SECRET: SECRET }, () => {
      const { auth } = freshModules();
      assert.equal(tokenNumber(auth.loadCredentials().token), 1);
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris switch --global away from an agent client keeps it as a profile, and switching back works', async () => {
  const { dir, home } = makeTemp();
  const counter = { n: 0 };
  const { server, url } = await startServer((req) => (req.url === '/oauth/token' ? tokenHandler(counter)() : { status: 404 }));
  try {
    const env = { HOME: home, ATRIS_API_URL: `${url}/api` };
    writeHumanLogin(home);
    const secretFile = writeSecretFile(dir);
    const login = await runCli(['login', '--client-id', CLIENT_ID, '--client-secret-file', secretFile], { cwd: dir, env });
    assert.equal(login.status, 0, login.stderr);
    const credsPath = path.join(home, '.atris', 'credentials.json');
    const cachePath = path.join(home, '.atris', 'agent-clients', `${CLIENT_ID}.token.json`);

    const away = await runCli(['switch', 'owner', '--global'], { cwd: dir, env });
    assert.equal(away.status, 0, away.stderr);
    assert.match(away.stdout, /Switched to owner@example\.com/);
    assert.match(away.stdout, /Switch back: atris switch atc_test123 --global/);
    assert.equal(JSON.parse(fs.readFileSync(credsPath, 'utf8')).email, 'owner@example.com');
    const profilePath = path.join(home, '.atris', 'profiles', `${CLIENT_ID}.json`);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.equal(profile.client_id, CLIENT_ID);
    assert.ok(!fs.readFileSync(profilePath, 'utf8').includes(SECRET));
    assert.equal(mode(profilePath), 0o600);
    assert.ok(fs.existsSync(cachePath), 'token cache kept');

    const back = await runCli(['switch', CLIENT_ID, '--global'], { cwd: dir, env });
    assert.equal(back.status, 0, back.stderr);
    assert.match(back.stdout, /Switched to agent client atc_test123/);
    const whoami = await runCli(['whoami', '--json'], { cwd: dir, env });
    assert.equal(whoami.status, 0, whoami.stderr);
    assert.equal(JSON.parse(whoami.stdout).client_id, CLIENT_ID);
    assert.equal(counter.n, 1, 'switching back reused the cached token');

    // The shell wrapper's hidden global switch keeps it too.
    fs.rmSync(profilePath);
    const hidden = await runCli(['_activate', 'owner'], { cwd: dir, env });
    assert.equal(hidden.status, 0, hidden.stderr);
    assert.equal(JSON.parse(fs.readFileSync(profilePath, 'utf8')).client_id, CLIENT_ID);
    assertNoSecrets(login.stdout + login.stderr + away.stdout + away.stderr + back.stdout + back.stderr, [agentJwt(1)]);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing the last agent client profile cleans up its files; logout keeps them while a profile still points at them', async () => {
  const { dir, home } = makeTemp();
  try {
    await withEnv({ HOME: home }, () => {
      const secretFile = writeSecretFile(dir);
      setupAgentClientLogin(home, secretFile, { token: agentJwt('x'), expiresAt: Date.now() + 600 * 1000 });
      const cachePath = path.join(home, '.atris', 'agent-clients', `${CLIENT_ID}.token.json`);
      const { auth } = freshModules();
      assert.equal(auth.preserveAgentClientLogin(), CLIENT_ID);
      auth.deleteCredentials();
      assert.ok(fs.existsSync(cachePath), 'profile still points at the client');
      auth.deleteProfile(CLIENT_ID);
      assert.ok(!fs.existsSync(cachePath), 'last reference gone, files gone');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- renew + 401

test('a token within 60 seconds of expiry is renewed before the call', async () => {
  const { dir, home } = makeTemp();
  const counter = { n: 100 };
  const seen = [];
  const { server, url } = await startServer((req) => {
    if (req.url === '/oauth/token') return tokenHandler(counter)();
    seen.push(req.authorization);
    return { body: { ok: true } };
  });
  try {
    await withEnv({ HOME: home, ATRIS_API_URL: `${url}/api` }, async () => {
      const secretFile = writeSecretFile(dir);
      const oldToken = agentJwt('old');
      setupAgentClientLogin(home, secretFile, { token: oldToken, expiresAt: Date.now() + 30 * 1000 });
      const { api, auth } = freshModules();

      const ensured = await auth.ensureValidCredentials(api.apiRequestJson);
      assert.equal(ensured.source, 'agent_client');
      assert.equal(tokenNumber(ensured.credentials.token), 101);
      assert.equal(counter.n, 101);

      // A caller still holding the old cached token: the shared helper renews too.
      setupAgentClientLogin(home, secretFile, { token: oldToken, expiresAt: Date.now() + 10 * 1000 });
      const res = await api.apiRequestJson('/ping', { token: oldToken });
      assert.equal(res.ok, true);
      assert.equal(tokenNumber(seen.pop().replace(/^Bearer /, '')), 102);

      // Far from expiry: no token request.
      const before = counter.n;
      const again = await api.apiRequestJson('/ping', { token: agentJwt(102) });
      assert.equal(again.ok, true);
      assert.equal(counter.n, before);
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a 401 re-fetches the token once and retries once, never loops', async () => {
  const { dir, home } = makeTemp();
  const counter = { n: 200 };
  let pings = 0;
  const { server, url } = await startServer((req) => {
    if (req.url === '/oauth/token') return tokenHandler(counter)();
    pings += 1;
    return { status: 401, body: { detail: 'Invalid token' } };
  });
  try {
    await withEnv({ HOME: home, ATRIS_API_URL: `${url}/api` }, async () => {
      const secretFile = writeSecretFile(dir);
      const token = agentJwt('cached');
      setupAgentClientLogin(home, secretFile, { token, expiresAt: Date.now() + 600 * 1000 });
      const { api } = freshModules();
      const res = await api.apiRequestJson('/ping', { token });
      assert.equal(res.status, 401);
      assert.equal(pings, 2, 'one call plus one retry');
      assert.equal(counter.n, 201, 'one token fetch');
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a 401 then success: the retry carries the new token', async () => {
  const { dir, home } = makeTemp();
  const counter = { n: 300 };
  const { server, url } = await startServer((req) => {
    if (req.url === '/oauth/token') return tokenHandler(counter)();
    if (req.authorization === `Bearer ${agentJwt(301)}`) return { body: { ok: true } };
    return { status: 401, body: { detail: 'expired' } };
  });
  try {
    await withEnv({ HOME: home, ATRIS_API_URL: `${url}/api` }, async () => {
      const secretFile = writeSecretFile(dir);
      const token = agentJwt('revoked');
      setupAgentClientLogin(home, secretFile, { token, expiresAt: Date.now() + 600 * 1000 });
      const { api } = freshModules();
      const res = await api.apiRequestJson('/ping', { token });
      assert.equal(res.ok, true);
      assert.equal(counter.n, 301);
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a 401 on a person\'s token or an API key never triggers a client token fetch', async () => {
  const { dir, home } = makeTemp();
  const counter = { n: 0 };
  let pings = 0;
  const { server, url } = await startServer((req) => {
    if (req.url === '/oauth/token') return tokenHandler(counter)();
    pings += 1;
    return { status: 401, body: { detail: 'nope' } };
  });
  try {
    await withEnv({ HOME: home, ATRIS_API_URL: `${url}/api` }, async () => {
      const secretFile = writeSecretFile(dir);
      setupAgentClientLogin(home, secretFile, { token: agentJwt('cached'), expiresAt: Date.now() + 600 * 1000 });
      const { api } = freshModules();
      const res = await api.apiRequestJson('/ping', { token: 'atris_some_api_key' });
      assert.equal(res.status, 401);
      assert.equal(pings, 1);
      assert.equal(counter.n, 0);
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- cache safety

test('concurrent processes writing the token cache never leave a broken or partial file', async () => {
  const { dir, home } = makeTemp();
  try {
    const modulePath = path.join(repoRoot, 'utils', 'agent-client.js');
    const script = `
      const ac = require(${JSON.stringify(modulePath)});
      const id = process.argv[1];
      for (let i = 0; i < 40; i += 1) {
        ac.writeTokenCache(${JSON.stringify(CLIENT_ID)}, { access_token: 'tok-' + id + '-' + i + '-' + 'x'.repeat(4000), expires_at: new Date(Date.now() + 9e5).toISOString() });
        const read = ac.readTokenCache(${JSON.stringify(CLIENT_ID)});
        if (!read || !read.access_token.startsWith('tok-')) { console.error('bad read'); process.exit(2); }
      }`;
    const runs = Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script, String(i)], { cwd: dir, env: { ...process.env, HOME: home } });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (status) => resolve({ status, stderr }));
    }));
    const results = await Promise.all(runs);
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const cacheDir = path.join(home, '.atris', 'agent-clients');
    const cache = JSON.parse(fs.readFileSync(path.join(cacheDir, `${CLIENT_ID}.token.json`), 'utf8'));
    assert.match(cache.access_token, /^tok-\d+-39-/);
    assert.deepEqual(fs.readdirSync(cacheDir).filter((n) => n.endsWith('.tmp')), []);
    assert.equal(mode(path.join(cacheDir, `${CLIENT_ID}.token.json`)), 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- old paths unchanged

test('old login paths are untouched: --token, --agent, plain login, ATRIS_TOKEN', async () => {
  const { authCmd } = freshModules();
  assert.equal(authCmd.agentClientLoginRequest([], {}), null);
  assert.equal(authCmd.agentClientLoginRequest(['--token', 'abc'], {}), null);
  assert.equal(authCmd.agentClientLoginRequest(['--agent', '--scopes', 'x-search'], {}), null);
  assert.equal(authCmd.agentClientLoginRequest(['--force'], { ATRIS_TOKEN: 'x' }), null);
  // Env client never hijacks an explicit --token or --agent.
  assert.equal(authCmd.agentClientLoginRequest(['--token', 'abc'], { ATRIS_CLIENT_ID: CLIENT_ID, ATRIS_CLIENT_SECRET: SECRET }), null);
  assert.equal(authCmd.agentClientLoginRequest(['--agent'], { ATRIS_CLIENT_ID: CLIENT_ID, ATRIS_CLIENT_SECRET: SECRET }), null);

  const { dir, home } = makeTemp();
  try {
    await withEnv({ HOME: home, ATRIS_TOKEN: 'env-token', ATRIS_CLIENT_ID: CLIENT_ID, ATRIS_CLIENT_SECRET: SECRET }, () => {
      const { auth } = freshModules();
      const active = auth.readActiveCredentials();
      assert.equal(active.token, 'env-token');
      assert.equal(active.source, 'env');
    });
    const result = await runCli(['login', '--token', 'plain-token', '--json'], { cwd: dir, env: { HOME: home, ATRIS_API_URL: 'http://127.0.0.1:9/api' } });
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'credentials.json'), 'utf8'));
    assert.equal(saved.token, 'plain-token');
    assert.equal(saved.auth_type, undefined);
    assert.ok(result.status === 0 || result.status === 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
