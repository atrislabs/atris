'use strict';

// Real binary, real HTTP, fake backend. Covers the headless sign-in report:
// login must take the one-time browser code with no terminal, must never save
// that code as a token, and must not start an update in the middle of login.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');
const CODE = 'Ab3_dE5-gH7iJ9kL1mN3oP5qR7sT9uV1wX3yZ5aB7cd'; // 43 url-safe chars, like token_urlsafe(32)
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl';

function fakeBackend(t) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/auth/cli/exchange')) {
        const sent = JSON.parse(body || '{}').code;
        if (sent === CODE) {
          res.end(JSON.stringify({ token: JWT, refresh_token: 'refresh-1', email: 'person@example.com', user_id: 'user-1', provider: 'atris' }));
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ detail: 'Invalid or expired code' }));
        }
        return;
      }
      res.end(JSON.stringify({}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({ url: `http://127.0.0.1:${server.address().port}/api`, calls });
    });
  });
}

function run(t, args, { api, stdin = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'login-headless-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ATRIS_TEST_STATE_DIR: home, ATRIS_API_URL: api, ATRIS_APP_URL: 'https://app.example' };
  for (const name of ['ATRIS_TOKEN', 'ATRIS_CLIENT_ID', 'ATRIS_CLIENT_SECRET', 'ATRIS_CLIENT_SECRET_FILE', 'ATRIS_PROFILE', 'ATRIS_SKIP_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER', 'ATRIS_NONINTERACTIVE']) delete env[name];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'login', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const credFile = findCredentials(home);
      resolve({ code, out, creds: credFile ? JSON.parse(fs.readFileSync(credFile, 'utf8')) : null });
    });
  });
}

function findCredentials(home) {
  const stack = [home];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'credentials.json') return full;
    }
  }
  return null;
}

test('login --code signs in with no terminal and saves the real token', async (t) => {
  const { url, calls } = await fakeBackend(t);
  const res = await run(t, ['--code', CODE], { api: url });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Signed in as person@example\.com/);
  assert.equal(res.creds.token, JWT);
  assert.equal(res.creds.refresh_token, 'refresh-1');
  assert.ok(calls.some((c) => c.url.endsWith('/auth/cli/exchange')));
});

test('a code piped into login signs in with no terminal', async (t) => {
  const { url } = await fakeBackend(t);
  const res = await run(t, [], { api: url, stdin: `${CODE}\n` });
  assert.equal(res.code, 0, res.out);
  assert.equal(res.creds.token, JWT);
});

test('a code passed as --token is exchanged, never saved as a token', async (t) => {
  const { url } = await fakeBackend(t);
  const res = await run(t, ['--token', CODE], { api: url });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /one-time code from the browser, not a token/);
  assert.equal(res.creds.token, JWT);
  assert.notEqual(res.creds.token, CODE);
});

test('an expired code fails plainly and saves nothing', async (t) => {
  const { url } = await fakeBackend(t);
  const wrong = 'Zz9_yY8-xX7wW6vV5uU4tT3sS2rR1qQ0pP9oO8nN7mM';
  const res = await run(t, ['--code', wrong, '--json'], { api: url });
  assert.equal(res.code, 1, res.out);
  const payload = JSON.parse(res.out);
  assert.equal(payload.ok, false);
  assert.match(payload.next, /auth\/cli/);
  assert.equal(res.creds, null);
});

test('no terminal and no code points at the headless paths, not just a token', async (t) => {
  const { url } = await fakeBackend(t);
  const res = await run(t, [], { api: url, stdin: '' });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /atris login --code <code>/);
  assert.match(res.out, /--client-id/);
  assert.equal(res.creds, null);
});

test('login never asks the registry for updates', async (t) => {
  const { url } = await fakeBackend(t);
  const marker = fs.mkdtempSync(path.join(os.tmpdir(), 'login-update-'));
  t.after(() => fs.rmSync(marker, { recursive: true, force: true }));
  // the update check calls https.get on registry.npmjs.org; trap any attempt
  const trap = path.join(marker, 'trap.js');
  fs.writeFileSync(trap, `const https=require('https');const fs=require('fs');const orig=https.get;https.get=function(...a){fs.writeFileSync(${JSON.stringify(path.join(marker, 'hit'))},String(a[0]&&a[0].hostname||a[0]));return orig.apply(this,a)};`);
  const prev = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${prev ? `${prev} ` : ''}--require ${trap}`;
  t.after(() => { if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev; });
  const res = await run(t, ['--code', CODE], { api: url });
  assert.equal(res.code, 0, res.out);
  assert.equal(fs.existsSync(path.join(marker, 'hit')), false, 'login made an update request');
  assert.doesNotMatch(res.out, /update available|updating/i);
});
