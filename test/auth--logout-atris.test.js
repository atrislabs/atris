'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Fence every path the command can touch into a throwaway home.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-logout-'));
process.env.HOME = TEST_HOME;
process.env.ATRIS_TEST_STATE_DIR = TEST_HOME;
// A fixed session id keeps getTerminalSessionId() from shelling out to `tty`;
// no session file exists under the temp home, so no session profile applies.
process.env.TERM_SESSION_ID = 'atris-logout-test';

const { logoutAtris } = require('../commands/auth');

const CREDENTIAL_ENV_KEYS = [
  'ATRIS_TOKEN',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_CLIENT_SECRET_FILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_PROFILE',
  'ATRIS_TEST_PROTECTED_HOME',
  'ATRIS_TEST_REAL_HOME',
];

function clearCredentialEnv() {
  for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];
}

function freshHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-logout-home-'));
  process.env.HOME = home;
  process.env.ATRIS_TEST_STATE_DIR = home;
  clearCredentialEnv();
  t.after(() => {
    process.env.HOME = TEST_HOME;
    process.env.ATRIS_TEST_STATE_DIR = TEST_HOME;
    clearCredentialEnv();
  });
  return home;
}

function credentialsPath(home) {
  return path.join(home, '.atris', 'credentials.json');
}

function writeCredentials(home, creds) {
  fs.mkdirSync(path.dirname(credentialsPath(home)), { recursive: true });
  fs.writeFileSync(credentialsPath(home), JSON.stringify(creds, null, 2));
}

function writeProfile(home, name, data) {
  const dir = path.join(home, '.atris', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
}

// process.exit would kill the test runner, so swap it for a recorder that
// unwinds out of the command the way exit does.
function runLogout() {
  const realLog = console.log;
  const realExit = process.exit;
  const lines = [];
  const exits = [];
  console.log = (...args) => lines.push(args.join(' '));
  process.exit = (code) => {
    exits.push(code);
    throw new Error(`__exit__:${code}`);
  };
  try {
    logoutAtris();
  } catch (error) {
    if (!String(error && error.message).startsWith('__exit__:')) throw error;
  } finally {
    console.log = realLog;
    process.exit = realExit;
  }
  return { lines, exits };
}

test('logout deletes credentials.json and reports the email plus remaining accounts', (t) => {
  const home = freshHome(t);
  writeCredentials(home, {
    token: 'stored-token',
    refresh_token: 'stored-refresh',
    email: 'alice@example.com',
    user_id: 'u1',
    provider: 'atris',
    saved_at: '2020-01-01T00:00:00.000Z',
  });
  writeProfile(home, 'bob', { email: 'bob@example.com', token: 'bob-token' });

  const { lines, exits } = runLogout();

  assert.deepStrictEqual(exits, []);
  assert.strictEqual(fs.existsSync(credentialsPath(home)), false, 'credentials.json should be deleted');
  assert.ok(lines.includes('✓ Signed out from alice@example.com'), `lines: ${lines.join(' | ')}`);
  assert.ok(lines.some((line) => line.includes('1 other account saved.')), `lines: ${lines.join(' | ')}`);
  assert.ok(lines.includes('Switch to one: atris switch bob'), `lines: ${lines.join(' | ')}`);
  assert.ok(lines.includes('Or remove all: atris accounts remove --all'), `lines: ${lines.join(' | ')}`);
});

test('logout prints "Not signed in." and exits 0 when nothing is stored', (t) => {
  freshHome(t);

  const { lines, exits } = runLogout();

  assert.deepStrictEqual(exits, [0]);
  assert.deepStrictEqual(lines, ['Not signed in.']);
});

test('logout keeps credentials.json when the active login comes from ATRIS_CLIENT_ID', (t) => {
  const home = freshHome(t);
  writeCredentials(home, { token: 'stored-token', email: 'alice@example.com', provider: 'atris' });
  process.env.ATRIS_CLIENT_ID = 'atc_test123';

  const { lines, exits } = runLogout();

  assert.deepStrictEqual(exits, [0]);
  assert.deepStrictEqual(lines, [
    'This agent client (atc_test123) comes from ATRIS_CLIENT_ID in your environment.',
    'Unset ATRIS_CLIENT_ID to sign it out.',
  ]);
  assert.strictEqual(fs.existsSync(credentialsPath(home)), true, 'env-based login must not delete credentials.json');
});
