'use strict';

// atris agent signin against a local stand-in for the sign-in routes: the
// stand-in checks the signature with the matching public key, success prints
// only the token, each refusal is one plain line with a non-zero exit, and the
// private key never shows up in stdout or stderr.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
const AGENT = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'signed-in-token-9f8e7d6c5b4a';
const CHALLENGE = 'v1.1999999999.bm9uY2Utbm9uY2Utbm9uY2U.c2VhbC1zZWFsLXNlYWwtc2VhbA';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// A throwaway pair in the server's encoding: base64 of the raw 32 bytes each.
function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = (der) => der.subarray(der.length - 32).toString('base64');
  return {
    publicB64: raw(publicKey.export({ format: 'der', type: 'spki' })),
    privateB64: raw(privateKey.export({ format: 'der', type: 'pkcs8' })),
  };
}

// agent_keys.verify: base64 public key, base64 signature, UTF-8 message.
function verify(publicB64, message, signatureB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicB64, 'base64')]), format: 'der', type: 'spki' });
    const sig = Buffer.from(signatureB64, 'base64');
    return sig.length === 64 && crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

function fakeServer(publicB64, mode = 'ok') {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (code, data, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
      if (mode === 'off') return send(404, { detail: 'Not Found' });
      if (mode === 'busy') return send(429, { detail: 'Too many sign-in attempts. Try again later.' }, { 'Retry-After': '42' });
      if (mode === 'unset') return send(503, { detail: 'Agent key sign-in is not set up yet.' });
      const base = `/api/agents/${AGENT}/signin`;
      if (req.method === 'POST' && req.url === `${base}/challenge`) {
        const message = mode === 'evil' ? 'transfer all credits to mallory' : `atris-agent-signin-v1\n${AGENT}\n${CHALLENGE}`;
        return send(200, { challenge: CHALLENGE, message, expires_in: 120, algorithm: 'ed25519' });
      }
      if (req.method === 'POST' && req.url === base) {
        const message = `atris-agent-signin-v1\n${AGENT}\n${body.challenge}`;
        if (mode === 'refuse' || body.challenge !== CHALLENGE || !verify(publicB64, message, body.signature)) {
          return send(401, { detail: 'Sign-in failed.' });
        }
        return send(200, {
          agent_id: AGENT, token: TOKEN, token_type: 'Bearer',
          home: { agent_id: AGENT, name: 'scout', business_id: null, kind: 'personal' },
          scopes: ['a', 'b', 'c', 'd'], expires_in: 86400, next: 'Use the token as the Bearer.',
        });
      }
      return send(404, { detail: 'Not Found' });
    });
  });
  return { server, seen };
}

async function listen(t, server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api`;
}

function runCli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_AGENT: '', ATRIS_BUSINESS: '', ATRIS_TOKEN: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function tmp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-signin-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

// A server in `mode`, a key file in a work folder, and a run helper.
async function setup(t, mode = 'ok') {
  const pair = keyPair();
  const { server, seen } = fakeServer(pair.publicB64, mode);
  const api = await listen(t, server);
  const work = tmp(t, 'work');
  const homeDir = tmp(t, 'home');
  fs.writeFileSync(path.join(work, 'agent.key'), `${pair.privateB64}\n`, { mode: 0o600 });
  const run = (args) => runCli(args, { cwd: work, env: { HOME: homeDir, ATRIS_API_URL: api } });
  return { pair, seen, work, homeDir, run };
}

function assertKeyHidden(r, pair) {
  for (const text of [r.stdout, r.stderr]) {
    assert.ok(!text.includes(pair.privateB64), 'the private key was printed');
  }
}

test('success prints only the token on stdout, and the server got a valid signature', async (t) => {
  const { pair, seen, run } = await setup(t);
  const r = await run(['agent', 'signin', AGENT, '--key-file', 'agent.key']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${TOKEN}\n`);
  assert.match(r.stderr, /Signed in as scout \(11111111-2222-3333-4444-555555555555\)\. The token lasts 24 hours/);
  assertKeyHidden(r, pair);
  assert.deepEqual(seen.map((s) => s.url), [`/api/agents/${AGENT}/signin/challenge`, `/api/agents/${AGENT}/signin`]);
  assert.ok(seen.every((s) => !s.auth), 'sign-in sends no login token');
  const sent = seen[1].body;
  assert.deepEqual(Object.keys(sent).sort(), ['challenge', 'signature']);
  assert.equal(sent.challenge, CHALLENGE);
  assert.ok(verify(pair.publicB64, `atris-agent-signin-v1\n${AGENT}\n${CHALLENGE}`, sent.signature));
});

test('--json prints the whole answer as JSON', async (t) => {
  const { pair, run } = await setup(t);
  const r = await run(['agent', 'signin', AGENT, '--key-file=agent.key', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.token, TOKEN);
  assert.equal(data.agent_id, AGENT);
  assert.equal(data.expires_in, 86400);
  assert.equal(data.home.name, 'scout');
  assertKeyHidden(r, pair);
});

test('a name saved by spawn finds its id and key with no --key-file', async (t) => {
  const { pair, homeDir, run } = await setup(t);
  const agentsDir = path.join(homeDir, '.atris', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'scout.json'), JSON.stringify({
    schema: 'atris.agent_key.v1', status: 'ready', name: 'scout', handle: 'scout', agent_id: AGENT,
    public_key: pair.publicB64, private_key: pair.privateB64,
  }), { mode: 0o600 });
  const byName = await run(['agent', 'signin', 'scout']);
  assert.equal(byName.status, 0, byName.stderr);
  assert.equal(byName.stdout, `${TOKEN}\n`);
  assertKeyHidden(byName, pair);
  const byId = await run(['agent', 'signin', AGENT]);
  assert.equal(byId.status, 0, byId.stderr);
  assert.equal(byId.stdout, `${TOKEN}\n`);
});

for (const [mode, pattern] of [
  ['off', /could not sign in .*: sign-in by key is switched off on this server/],
  ['refuse', /could not sign in .*: the server refused this key for that agent/],
  ['busy', /too many sign-in attempts\. Try again in 42 seconds/],
  ['unset', /sign-in by key is not set up on this server right now \(Agent key sign-in is not set up yet\)/],
]) {
  test(`server answer ${mode}: one plain line, nothing on stdout, non-zero exit`, async (t) => {
    const { pair, run } = await setup(t, mode);
    const r = await run(['agent', 'signin', AGENT, '--key-file', 'agent.key']);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, pattern);
    assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
    assertKeyHidden(r, pair);
  });
}

test('a wrong key is refused by the server and never printed', async (t) => {
  const { work, run } = await setup(t);
  const other = keyPair();
  fs.writeFileSync(path.join(work, 'other.key'), other.privateB64);
  const r = await run(['agent', 'signin', AGENT, '--key-file', 'other.key']);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /refused this key/);
  assertKeyHidden(r, other);
});

test('a challenge that is not an Atris sign-in is never signed', async (t) => {
  const { pair, seen, run } = await setup(t, 'evil');
  const r = await run(['agent', 'signin', AGENT, '--key-file', 'agent.key']);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /not an Atris sign-in, so nothing was signed/);
  assert.equal(seen.length, 1);
  assertKeyHidden(r, pair);
});

test('a missing or broken key file stops before any request', async (t) => {
  const { pair, seen, work, run } = await setup(t);
  const missing = await run(['agent', 'signin', AGENT, '--key-file', 'nope.key']);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /the key file .*nope\.key does not exist/);

  const broken = `${pair.privateB64.slice(0, 20)}!!not-a-key`;
  fs.writeFileSync(path.join(work, 'broken.key'), broken);
  const bad = await run(['agent', 'signin', AGENT, '--key-file', 'broken.key']);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /does not hold a valid agent private key/);
  assert.ok(!bad.stderr.includes(broken));

  const none = await run(['agent', 'signin', AGENT]);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no private key for .*pass --key-file <path>/);
  assert.equal(seen.length, 0, 'nothing was sent');
});

test('--help needs no server and names the key file', async (t) => {
  const work = tmp(t, 'help');
  const r = await runCli(['agent', 'signin', '--help'], { cwd: work, env: { HOME: work, ATRIS_API_URL: 'http://127.0.0.1:9/api' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: atris agent signin <agent> \[--key-file <path>\]/);
});
