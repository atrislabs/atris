'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// auth.js resolves ~/.atris from os.homedir(), which honors $HOME on POSIX.
// Point HOME at a scratch dir BEFORE requiring the module so every path in
// the suite stays inside the sandbox.
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auth-test-'));
process.env.HOME = scratchHome;

const auth = require('../utils/auth');

function writeProfile(name, creds) {
  const dir = path.join(scratchHome, '.atris', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(creds, null, 2));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const PROFILE_CREDS = {
  token: 'old-token',
  refresh_token: 'old-refresh',
  email: 'keshav@atrislabs.com',
  user_id: 'user-1',
  provider: 'google',
};

const fakeApi = async (pathname) => {
  if (pathname === '/auth/refresh') {
    return { ok: true, data: { access_token: 'new-token', refresh_token: 'new-refresh' } };
  }
  if (pathname === '/auth/validate') {
    return { ok: true, data: { valid: true, user: { email: 'keshav@atrislabs.com', id: 'user-1', provider: 'google' } } };
  }
  return { ok: false, status: 404, error: 'unexpected call: ' + pathname };
};

test('loadCredentials tags ATRIS_PROFILE credentials with their source profile', () => {
  writeProfile('keshav', PROFILE_CREDS);
  process.env.ATRIS_PROFILE = 'keshav';
  try {
    const creds = auth.loadCredentials();
    assert.equal(creds.source_profile, 'keshav');
    assert.equal(creds.token, 'old-token');
  } finally {
    delete process.env.ATRIS_PROFILE;
  }
});

test('performTokenRefresh writes a profile-sourced refresh back to the profile file, not credentials.json', async () => {
  writeProfile('keshav', PROFILE_CREDS);
  process.env.ATRIS_PROFILE = 'keshav';
  try {
    const creds = auth.loadCredentials();
    const result = await auth.performTokenRefresh(creds, fakeApi);
    assert.equal(result.ok, true);

    const profile = readJson(path.join(scratchHome, '.atris', 'profiles', 'keshav.json'));
    assert.equal(profile.token, 'new-token');
    assert.equal(profile.refresh_token, 'new-refresh');
    assert.equal('source_profile' in profile, false, 'source tag must not leak into the profile file');

    const globalPath = path.join(scratchHome, '.atris', 'credentials.json');
    if (fs.existsSync(globalPath)) {
      assert.notEqual(readJson(globalPath).token, 'new-token',
        'a profile refresh must not overwrite the global credentials.json token');
    }
  } finally {
    delete process.env.ATRIS_PROFILE;
  }
});

test('performTokenRefresh without a profile still writes credentials.json', async () => {
  const globalPath = path.join(scratchHome, '.atris', 'credentials.json');
  fs.writeFileSync(globalPath, JSON.stringify({ ...PROFILE_CREDS }, null, 2));
  const creds = auth.loadCredentials();
  assert.equal(creds.source_profile, undefined);

  const result = await auth.performTokenRefresh(creds, fakeApi);
  assert.equal(result.ok, true);
  assert.equal(readJson(globalPath).token, 'new-token');
});

test('refreshAccessToken sends refresh_token and omits the google provider hint for app JWTs', async () => {
  let captured;
  const api = async (pathname, options) => {
    captured = { pathname, options };
    return { ok: true, data: { access_token: 'new-token' } };
  };
  const jwtRefresh = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig';
  await auth.refreshAccessToken(jwtRefresh, 'google', api);
  assert.equal(captured.pathname, '/auth/refresh');
  assert.deepEqual(captured.options.body, { refresh_token: jwtRefresh });
});

test('refreshAccessToken still forwards a non-google provider hint', async () => {
  let captured;
  const api = async (_pathname, options) => {
    captured = options.body;
    return { ok: true, data: { access_token: 'x' } };
  };
  await auth.refreshAccessToken('rt', 'email', api);
  assert.deepEqual(captured, { refresh_token: 'rt', provider: 'email' });
});

test('refreshAccessToken keeps provider=google only for Google OAuth refresh tokens', async () => {
  let captured;
  const api = async (_pathname, options) => {
    captured = options.body;
    return { ok: true, data: { access_token: 'x' } };
  };
  await auth.refreshAccessToken('1//google-oauth-refresh', 'google', api);
  assert.deepEqual(captured, { refresh_token: '1//google-oauth-refresh', provider: 'google' });
});

test('performTokenRefresh for a google profile omits the google hint and writes the profile file', async () => {
  writeProfile('keshav', PROFILE_CREDS);
  process.env.ATRIS_PROFILE = 'keshav';
  try {
    const creds = auth.loadCredentials();
    let refreshBody;
    const api = async (pathname, options) => {
      if (pathname === '/auth/refresh') {
        refreshBody = options.body;
        return { ok: true, data: { access_token: 'new-token', refresh_token: 'new-refresh' } };
      }
      if (pathname === '/auth/validate') {
        return { ok: true, data: { valid: true, user: { email: 'keshav@atrislabs.com', id: 'user-1', provider: 'google' } } };
      }
      return { ok: false, status: 404, error: 'unexpected call: ' + pathname };
    };
    const result = await auth.performTokenRefresh(creds, api);
    assert.equal(result.ok, true);
    assert.deepEqual(refreshBody, { refresh_token: 'old-refresh' });
    const profile = readJson(path.join(scratchHome, '.atris', 'profiles', 'keshav.json'));
    assert.equal(profile.token, 'new-token');
    assert.equal(profile.refresh_token, 'new-refresh');
  } finally {
    delete process.env.ATRIS_PROFILE;
  }
});

test('ensureValidCredentials writes profile metadata back to the profile file, not credentials.json', async () => {
  const globalPath = path.join(scratchHome, '.atris', 'credentials.json');
  if (fs.existsSync(globalPath)) fs.unlinkSync(globalPath);
  writeProfile('keshav', { ...PROFILE_CREDS, email: 'old@example.com' });
  process.env.ATRIS_PROFILE = 'keshav';
  try {
    const api = async (pathname) => {
      if (pathname === '/auth/validate') {
        return {
          ok: true,
          data: { valid: true, user: { email: 'keshav@atrislabs.com', id: 'user-1', provider: 'google' } },
        };
      }
      return { ok: false, status: 404, error: 'unexpected call: ' + pathname };
    };
    const result = await auth.ensureValidCredentials(api);
    assert.equal(result.error, undefined);
    assert.equal(fs.existsSync(globalPath), false);
    const profile = readJson(path.join(scratchHome, '.atris', 'profiles', 'keshav.json'));
    assert.equal(profile.email, 'keshav@atrislabs.com');
    assert.equal('source_profile' in profile, false);
  } finally {
    delete process.env.ATRIS_PROFILE;
  }
});

test('abortOnAuthFailure stops on 401/403 and ignores other statuses', () => {
  let exited = null;
  const exitFn = (code) => { exited = code; };
  assert.equal(auth.isAuthFailure({ status: 401 }), true);
  assert.equal(auth.isAuthFailure({ status: 403 }), true);
  assert.equal(auth.isAuthFailure({ status: 500 }), false);
  assert.equal(auth.abortOnAuthFailure({ status: 200 }, false, exitFn), false);
  assert.equal(exited, null);
  assert.equal(auth.abortOnAuthFailure({ status: 401 }, false, exitFn), true);
  assert.equal(exited, 1);
});
