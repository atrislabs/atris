const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHandle, HANDLE_RE, signupCommand } = require('../commands/signup');

test('HANDLE_RE accepts lowercase alnum 3-30', () => {
  assert.ok(HANDLE_RE.test('ada'));
  assert.ok(HANDLE_RE.test('agent007'));
  assert.ok(HANDLE_RE.test('a'.repeat(30)));
});

test('HANDLE_RE rejects too short, too long, symbols, case', () => {
  assert.ok(!HANDLE_RE.test('ab'));
  assert.ok(!HANDLE_RE.test('a'.repeat(31)));
  for (const bad of ['a.b', 'a-b', 'a b', 'Ada', 'a_b', 'a/b']) {
    assert.ok(!HANDLE_RE.test(bad), bad);
  }
});

test('parseHandle picks the first positional, lowercased', () => {
  assert.equal(parseHandle(['NewBie']), 'newbie');
  assert.equal(parseHandle(['--json', 'ghost']), 'ghost');
  assert.equal(parseHandle(['  Spaced  ']), 'spaced');
  assert.equal(parseHandle([]), '');
  assert.equal(parseHandle(['help']), '');
  assert.equal(parseHandle(['--help', 'ghost']), 'ghost');
});

test('signupCommand returns 1 on missing handle without a network call', async () => {
  const code = await signupCommand([]);
  assert.equal(code, 1);
});

test('signupCommand treats help as usage without POW or network', async () => {
  assert.equal(await signupCommand(['help']), 2);
  assert.equal(await signupCommand(['--help']), 2);
  assert.equal(await signupCommand(['-h']), 2);
});

test('signupCommand returns 1 on invalid handle without a network call', async () => {
  // Symbols / wrong length fail the client-side guard before any request.
  assert.equal(await signupCommand(['a.b!']), 1);
  assert.equal(await signupCommand(['ab']), 1);
});

// ------------------------------------------------ signup that also returns an agent client

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
const CLIENT_ID = 'atc_signup123';
const SECRET = 'atcs_signupsecret_DO_NOT_PRINT';

function jwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}
const SIGNUP_TOKEN = jwt({ sub: 'agent-user-1', type: 'agent_identity', exp: Math.floor(Date.now() / 1000) + 30 * 86400 });
const clientJwt = (n) => jwt({ type: 'agent_access', n, exp: Math.floor(Date.now() / 1000) + 3600 });

function startServer(signupBody) {
  const state = { tokenCalls: 0, requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/auth/agent/signup') {
        res.end(JSON.stringify(signupBody));
        return;
      }
      if (req.method === 'POST' && req.url === '/oauth/token') {
        state.tokenCalls += 1;
        res.end(JSON.stringify({ access_token: clientJwt(state.tokenCalls), token_type: 'Bearer', expires_in: 3600, scope: 'account' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: 'nope' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function runCli(args, cwd, env) {
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
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('cli hung')); }, 60000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function assertNoSecrets(text) {
  assert.ok(!text.includes(SECRET), 'output leaked the client secret');
  assert.ok(!text.includes(SIGNUP_TOKEN), 'output leaked the signup token');
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(text), 'output leaked a JWT');
}

async function signupWith(signupBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-signup-client-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const { server, state, url } = await startServer(signupBody);
  const env = { HOME: home, ATRIS_API_URL: `${url}/api` };
  const result = await runCli(['signup', 'robot7'], dir, env);
  return { dir, home, server, state, url, env, result };
}

const BASE_BODY = { token: SIGNUP_TOKEN, email: 'robot7@atrismail.com', user_id: 'agent-user-1' };
const RENEW_LINE = 'This agent renews its own login; no human needed.';
const FRESH_SIGNUP_LINE = /renewing it will need a fresh signup login/;

test('signup with a client: agent client becomes the login, secret 0600, first token fetched, later calls renew', async () => {
  const run = await signupWith({
    ...BASE_BODY,
    client: { client_id: CLIENT_ID, client_secret: SECRET, scopes: ['account'], token_endpoint: 'https://api.atris.ai/oauth/token', expires_in_seconds: 3600 },
  });
  const { dir, home, server, state, result } = run;
  try {
    assert.equal(result.status, 0, result.stderr);
    assertNoSecrets(result.stdout + result.stderr);
    const lines = result.stdout.split('\n');
    const inAt = lines.findIndex((l) => l.includes("You're in: robot7@atrismail.com"));
    assert.ok(inAt >= 0, result.stdout);
    assert.equal(lines[inAt + 1], RENEW_LINE);
    assert.doesNotMatch(result.stdout, FRESH_SIGNUP_LINE);

    // Secret stored privately, exactly like the env-secret login path.
    const secretFile = path.join(home, '.atris', 'agent-clients', `${CLIENT_ID}.secret`);
    assert.equal(fs.readFileSync(secretFile, 'utf8').trim(), SECRET);
    assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);

    // Active login is the agent client, with no secret inside it.
    const credsText = fs.readFileSync(path.join(home, '.atris', 'credentials.json'), 'utf8');
    const creds = JSON.parse(credsText);
    assert.equal(creds.auth_type, 'agent_client');
    assert.equal(creds.client_id, CLIENT_ID);
    assert.equal(creds.client_secret_file, secretFile);
    assert.ok(!credsText.includes(SECRET));

    // First token fetched with client_credentials and cached.
    assert.equal(state.tokenCalls, 1);
    const tokenReq = state.requests.find((r) => r.url === '/oauth/token');
    const form = Object.fromEntries(new URLSearchParams(tokenReq.body));
    assert.equal(form.grant_type, 'client_credentials');
    assert.equal(form.client_id, CLIENT_ID);
    const cachePath = path.join(home, '.atris', 'agent-clients', `${CLIENT_ID}.token.json`);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cache.access_token, clientJwt(1));

    // The 30-day token is kept as a profile named after the handle.
    const fallback = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'profiles', 'robot7.json'), 'utf8'));
    assert.equal(fallback.token, SIGNUP_TOKEN);
    assert.equal(fallback.email, 'robot7@atrismail.com');

    // A later command renews on its own once the short token runs low.
    cache.expires_at = new Date(Date.now() + 10 * 1000).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify(cache));
    const whoami = await runCli(['whoami'], dir, run.env);
    assertNoSecrets(whoami.stdout + whoami.stderr);
    assert.equal(state.tokenCalls, 2, whoami.stdout + whoami.stderr);
    assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).access_token, clientJwt(2));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('signup with client null and client_error: old behavior plus one plain line', async () => {
  const { dir, home, server, state, result } = await signupWith({ ...BASE_BODY, client: null, client_error: 'client mint failed' });
  try {
    assert.equal(result.status, 0, result.stderr);
    assertNoSecrets(result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(RENEW_LINE));
    assert.equal(result.stdout.split('\n').filter((l) => FRESH_SIGNUP_LINE.test(l)).length, 1);
    assert.equal(state.tokenCalls, 0);
    const creds = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'credentials.json'), 'utf8'));
    assert.equal(creds.token, SIGNUP_TOKEN);
    assert.equal(creds.auth_type, undefined);
    const clientsDir = path.join(home, '.atris', 'agent-clients');
    assert.ok(!fs.existsSync(clientsDir) || fs.readdirSync(clientsDir).length === 0);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('signup against an old server (no client field): exactly the old behavior, no extra line', async () => {
  const { dir, home, server, state, result } = await signupWith(BASE_BODY);
  try {
    assert.equal(result.status, 0, result.stderr);
    assertNoSecrets(result.stdout + result.stderr);
    assert.ok(!result.stdout.includes(RENEW_LINE));
    assert.doesNotMatch(result.stdout, FRESH_SIGNUP_LINE);
    assert.equal(state.tokenCalls, 0);
    const creds = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'credentials.json'), 'utf8'));
    assert.equal(creds.token, SIGNUP_TOKEN);
    assert.equal(creds.email, 'robot7@atrismail.com');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
