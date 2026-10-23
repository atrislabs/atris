'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// activateGlobal resolves profiles and credentials under stateHome(), which
// follows $HOME on POSIX. Point HOME at a scratch dir before requiring the
// module and drop every ATRIS_* var so nothing in the run env leaks in.
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-activate-global-'));
test.after(() => fs.rmSync(scratchHome, { recursive: true, force: true }));
process.env.HOME = scratchHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { activateGlobal } = require('../commands/auth');

const atrisDir = path.join(scratchHome, '.atris');
const profilesDir = path.join(atrisDir, 'profiles');
const credentialsPath = path.join(atrisDir, 'credentials.json');

test.beforeEach(() => {
  fs.rmSync(atrisDir, { recursive: true, force: true });
});

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

// activateGlobal always ends in process.exit; capture the code by making it
// throw. All the work is synchronous, so the file writes land before the throw.
function runActivate(name) {
  const savedArgv = process.argv.slice();
  const savedExit = process.exit;
  try {
    while (process.argv.length > 3) process.argv.pop();
    if (name !== undefined) process.argv[3] = name;
    process.exit = (code) => { throw new ExitSignal(code); };
    try {
      activateGlobal();
      return undefined;
    } catch (err) {
      if (err instanceof ExitSignal) return err.code;
      throw err;
    }
  } finally {
    process.exit = savedExit;
    process.argv.length = 0;
    process.argv.push(...savedArgv);
  }
}

function writeProfileFile(name, creds) {
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, `${name}.json`), JSON.stringify(creds, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const ALICE = {
  token: 'alice-token',
  refresh_token: 'alice-refresh',
  email: 'alice@example.com',
  user_id: 'user-alice',
  provider: 'google',
  saved_at: '2024-01-01T00:00:00.000Z',
};

test('copies a usable profile into credentials.json and exits 0', () => {
  writeProfileFile('alice', ALICE);

  const code = runActivate('alice');

  assert.equal(code, 0);
  assert.equal(fs.existsSync(credentialsPath), true);
  assert.deepEqual(readJson(credentialsPath), ALICE);
  assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o600);
});

test('keeps an agent client login as a profile before overwriting credentials.json', () => {
  const clientLogin = {
    auth_type: 'agent_client',
    client_id: 'atc_testbot',
    client_secret_file: '/secrets/testbot',
    provider: 'agent_client',
  };
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(clientLogin, null, 2));
  writeProfileFile('alice', ALICE);

  const code = runActivate('alice');

  assert.equal(code, 0);
  assert.deepEqual(readJson(credentialsPath), ALICE);
  assert.deepEqual(readJson(path.join(profilesDir, 'atc_testbot.json')), clientLogin);
});

test('exits 1 and leaves credentials.json alone when the profile has no usable token', () => {
  writeProfileFile('broken', { email: 'broken@example.com' });
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify({ token: 'still-current' }));

  const code = runActivate('broken');

  assert.equal(code, 1);
  assert.deepEqual(readJson(credentialsPath), { token: 'still-current' });
});

test('exits 1 for a missing profile or a missing name', () => {
  assert.equal(runActivate('ghost'), 1);
  assert.equal(fs.existsSync(credentialsPath), false);

  assert.equal(runActivate(undefined), 1);
  assert.equal(fs.existsSync(credentialsPath), false);
});
