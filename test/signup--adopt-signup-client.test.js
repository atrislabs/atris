'use strict';

// adoptSignupClient: a signup that comes back with an agent client saves the
// secret privately, trades it for a token, and makes the client the active
// login. Every failure path keeps the 30-day login and never prints the secret.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { adoptSignupClient } = require('../commands/signup');

const CLIENT_ID = 'atc_alice01';
const SECRET = 'atcs_fixture_secret_do_not_print';
const HUMAN_TOKEN = 'human-thirty-day-token';
const ACCESS_TOKEN = 'agent-access-token';

// A fixed clock, so expires_at is the same on every machine and time zone.
const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW = () => FIXED_NOW;

// A throwaway HOME with every ATRIS_* variable cleared, so nothing reads or
// writes the real machine. Restore puts the caller's environment back.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-signup-adopt-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = home;
  return {
    home,
    close() {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Stands in for the token endpoint. Records each call and returns the reply,
// or throws it when the reply is an Error.
function fakeTokenEndpoint(reply) {
  const calls = [];
  const httpRequest = async (url, options) => {
    calls.push({ url, options });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, httpRequest };
}

// The 30-day login that signup saved before adopting the client. Written
// directly, not through saveCredentials, which would also auto-save a profile.
function seedHumanLogin(home) {
  const dir = path.join(home, '.atris');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
    token: HUMAN_TOKEN,
    email: 'alice@atrismail.com',
    provider: 'atrisos',
  }, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('a signup client is saved privately, traded for a token, and made the active login', async () => {
  const box = sandbox();
  try {
    const { home } = box;
    seedHumanLogin(home);
    const { calls, httpRequest } = fakeTokenEndpoint({
      status: 200,
      body: JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: '' }),
    });

    const result = await adoptSignupClient({ client_id: CLIENT_ID, client_secret: SECRET }, 'alice', { httpRequest, now: NOW });

    assert.deepStrictEqual(result, { ok: true, clientId: CLIENT_ID });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/oauth\/token$/);
    assert.match(calls[0].options.body, /grant_type=client_credentials/);

    const agentDir = path.join(home, '.atris', 'agent-clients');
    const secretFile = path.join(agentDir, `${CLIENT_ID}.secret`);
    assert.equal(fs.readFileSync(secretFile, 'utf8'), `${SECRET}\n`);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
    }

    // The 30-day login survives as a profile named after the handle.
    const profile = readJson(path.join(home, '.atris', 'profiles', 'alice.json'));
    assert.equal(profile.token, HUMAN_TOKEN);

    // The client is now the active login. It points at the secret file, not the secret.
    const active = readJson(path.join(home, '.atris', 'credentials.json'));
    assert.deepStrictEqual(
      { auth_type: active.auth_type, client_id: active.client_id, client_secret_file: active.client_secret_file, scope: active.scope },
      { auth_type: 'agent_client', client_id: CLIENT_ID, client_secret_file: secretFile, scope: null },
    );

    // The token cache expires one hour after the fixed clock.
    const cache = readJson(path.join(agentDir, `${CLIENT_ID}.token.json`));
    assert.equal(cache.access_token, ACCESS_TOKEN);
    assert.equal(cache.client_id, CLIENT_ID);
    assert.equal(cache.expires_at, '2026-01-15T13:00:00.000Z');

    // No login file holds the secret. Only the private secret file does.
    for (const file of ['credentials.json', 'profiles/alice.json', `agent-clients/${CLIENT_ID}.token.json`]) {
      const text = fs.readFileSync(path.join(home, '.atris', file), 'utf8');
      assert.ok(!text.includes(SECRET), `${file} must not contain the secret`);
    }
  } finally {
    box.close();
  }
});

test('a client with a bad id, a blank secret, or no client is refused before anything is written', async () => {
  const box = sandbox();
  try {
    const { home } = box;
    const cases = [
      null,
      {},
      { client_id: 'xx_alice01', client_secret: SECRET },
      { client_id: CLIENT_ID, client_secret: '   ' },
      { client_id: CLIENT_ID, client_secret: 42 },
    ];
    for (const client of cases) {
      const { calls, httpRequest } = fakeTokenEndpoint({ status: 200, body: '{}' });
      const result = await adoptSignupClient(client, 'alice', { httpRequest, now: NOW });
      assert.deepStrictEqual(result, { ok: false });
      assert.equal(calls.length, 0, `no token request for ${JSON.stringify(client)}`);
    }
    // Nothing was created under HOME, not even the agent-clients folder.
    assert.deepStrictEqual(fs.readdirSync(home), []);
  } finally {
    box.close();
  }
});

test('a rejected token request keeps the 30-day login and leaves the secret file for a retry', async () => {
  const box = sandbox();
  try {
    const { home } = box;
    seedHumanLogin(home);
    const { httpRequest } = fakeTokenEndpoint({
      status: 401,
      body: JSON.stringify({ error: 'invalid_client', error_description: 'bad secret' }),
    });

    const result = await adoptSignupClient({ client_id: CLIENT_ID, client_secret: SECRET }, 'alice', { httpRequest, now: NOW });

    const secretFile = path.join(home, '.atris', 'agent-clients', `${CLIENT_ID}.secret`);
    assert.deepStrictEqual(result, {
      ok: false,
      clientId: CLIENT_ID,
      secretFile,
      reason: 'agent client sign-in failed (401, invalid_client): bad secret',
    });
    assert.ok(!result.reason.includes(SECRET));

    // The retry hint in signupCommand needs this file to exist.
    assert.equal(fs.readFileSync(secretFile, 'utf8'), `${SECRET}\n`);

    // The active login did not switch, and no handle profile was made.
    const active = readJson(path.join(home, '.atris', 'credentials.json'));
    assert.equal(active.token, HUMAN_TOKEN);
    assert.equal(fs.existsSync(path.join(home, '.atris', 'profiles', 'alice.json')), false);
  } finally {
    box.close();
  }
});

test('a network failure is reported with the secret scrubbed from the message', async () => {
  const box = sandbox();
  try {
    const { home } = box;
    seedHumanLogin(home);
    const { httpRequest } = fakeTokenEndpoint(new Error(`socket hang up while sending ${SECRET}`));

    const result = await adoptSignupClient({ client_id: CLIENT_ID, client_secret: SECRET }, 'alice', { httpRequest, now: NOW });

    assert.equal(result.ok, false);
    assert.equal(result.clientId, CLIENT_ID);
    assert.equal(result.reason, 'could not reach the token endpoint: socket hang up while sending [redacted]');
    assert.ok(!result.reason.includes(SECRET));
    assert.equal(readJson(path.join(home, '.atris', 'credentials.json')).token, HUMAN_TOKEN);
  } finally {
    box.close();
  }
});
