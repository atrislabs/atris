'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// switchSession reads ~/.atris through os.homedir(), which follows HOME.
// Point HOME at a scratch dir before loading the module so nothing touches
// the real account. The terminal-id and ATRIS_* variables are cleared so the
// result never depends on the machine running the check.
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-switch-session-test-'));
const CLEARED_KEYS = [
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'TMUX_PANE',
  'WT_SESSION',
  'WEZTERM_PANE',
  ...Object.keys(process.env).filter((key) => key.startsWith('ATRIS_')),
];
const savedEnv = Object.fromEntries(CLEARED_KEYS.map((key) => [key, process.env[key]]));
const savedHome = process.env.HOME;

for (const key of CLEARED_KEYS) delete process.env[key];
process.env.HOME = scratchHome;

test.after(() => {
  for (const key of CLEARED_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

const { switchSession } = require('../commands/auth');

const atrisDir = path.join(scratchHome, '.atris');
const profilesDir = path.join(atrisDir, 'profiles');
const sessionsDir = path.join(atrisDir, 'sessions');
const credentialsPath = path.join(atrisDir, 'credentials.json');

// Each test starts from an empty ~/.atris so file checks see only that test's writes.
function resetState() {
  fs.rmSync(atrisDir, { recursive: true, force: true });
  fs.mkdirSync(profilesDir, { recursive: true });
}

function writeProfile(name, creds) {
  fs.writeFileSync(path.join(profilesDir, `${name}.json`), JSON.stringify(creds, null, 2));
}

// switchSession ends by calling process.exit. Replace it with a throw so the
// test can read the exit code, then put the real one back.
class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function runSwitch(args) {
  const savedArgv = process.argv;
  const savedExit = process.exit;
  process.argv = ['node', 'atris', '_switch-session', ...args];
  process.exit = (code) => { throw new ExitSignal(code); };
  try {
    switchSession();
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  } finally {
    process.argv = savedArgv;
    process.exit = savedExit;
  }
  return 'returned without exiting';
}

test('--session-id writes a session file that names the profile, and leaves credentials.json alone', () => {
  resetState();
  writeProfile('work', { token: 'work-token', email: 'work@example.com' });

  const code = runSwitch(['work', '--session-id', 'term-42']);

  assert.strictEqual(code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'term-42.json'), 'utf8'));
  assert.strictEqual(written.profile, 'work');
  assert.strictEqual(typeof written.set_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(written.set_at)), 'set_at should be an ISO timestamp');
  assert.strictEqual(fs.existsSync(credentialsPath), false);
});

test('a session id with unsafe characters is sanitized and cut to 64 characters for the file name', () => {
  resetState();
  writeProfile('work', { token: 'work-token' });
  const longId = `ab/cd ef:${'x'.repeat(80)}`;

  const code = runSwitch(['work', '--session-id', longId]);

  assert.strictEqual(code, 0);
  const expectedName = `ab-cd-ef-${'x'.repeat(55)}.json`;
  assert.deepStrictEqual(fs.readdirSync(sessionsDir), [expectedName]);
});

test('without --session-id, the terminal id from the environment names the session file', () => {
  resetState();
  writeProfile('work', { token: 'work-token' });
  process.env.TERM_SESSION_ID = 'w0t1p0:ABC';
  try {
    const code = runSwitch(['work']);

    assert.strictEqual(code, 0);
    const written = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'w0t1p0-ABC.json'), 'utf8'));
    assert.strictEqual(written.profile, 'work');
  } finally {
    delete process.env.TERM_SESSION_ID;
  }
});

test('a bare --session-id flag with no value falls back to the terminal id', () => {
  resetState();
  writeProfile('work', { token: 'work-token' });
  process.env.TERM_SESSION_ID = 'term-7';
  try {
    const code = runSwitch(['work', '--session-id']);

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(fs.readdirSync(sessionsDir), ['term-7.json']);
  } finally {
    delete process.env.TERM_SESSION_ID;
  }
});

test('exits 1 and writes nothing when no profile name is given', () => {
  resetState();

  const code = runSwitch([]);

  assert.strictEqual(code, 1);
  assert.strictEqual(fs.existsSync(sessionsDir), false);
  assert.strictEqual(fs.existsSync(credentialsPath), false);
});

test('exits 1 and writes nothing when the profile does not exist', () => {
  resetState();
  writeProfile('work', { token: 'work-token' });

  const code = runSwitch(['nobody', '--session-id', 'term-9']);

  assert.strictEqual(code, 1);
  assert.strictEqual(fs.existsSync(sessionsDir), false);
});

test('exits 1 and writes nothing when the profile has no login token', () => {
  resetState();
  writeProfile('stale', { email: 'stale@example.com' });

  const code = runSwitch(['stale', '--session-id', 'term-10']);

  assert.strictEqual(code, 1);
  assert.strictEqual(fs.existsSync(sessionsDir), false);
});
