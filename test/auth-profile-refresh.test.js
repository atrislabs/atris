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
