'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { clearSessionRoster, NO_SESSION_MESSAGE } = require('../lib/engine-registry');

const ENV_KEYS = [
  'HOME',
  'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR',
  'ATRIS_MACHINE_ROSTER_PATH',
  'ATRIS_MACHINE_ROSTER_MD_PATH',
];

let scratch;
let sessionsDir;
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clear-session-roster-'));
  process.env.HOME = scratch;
  sessionsDir = path.join(scratch, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

// Same file name the code under test derives: readable part plus a key hash.
function rosterFileFor(key) {
  const readable = key.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[.-]+/, '').slice(0, 32).replace(/[.-]+$/, '');
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  return path.join(sessionsDir, `roster-${readable ? `${readable}-` : ''}${hash}.md`);
}

function writeRoster(key) {
  const file = rosterFileFor(key);
  fs.writeFileSync(file, '## small build\n\n- claude code, model: opus 5.5\n');
  return file;
}

test('removes the roster file for the given session and returns true', () => {
  const file = writeRoster('shell-one');
  assert.ok(fs.existsSync(file));

  const cleared = clearSessionRoster({ sessionKey: 'shell-one', sessionRosterDir: sessionsDir });

  assert.strictEqual(cleared, true);
  assert.strictEqual(fs.existsSync(file), false);
});

test('returns false when the session has no roster file, and a second clear is a no-op', () => {
  const file = writeRoster('shell-one');
  const options = { sessionKey: 'shell-one', sessionRosterDir: sessionsDir };

  assert.strictEqual(clearSessionRoster({ sessionKey: 'never-written', sessionRosterDir: sessionsDir }), false);
  assert.strictEqual(clearSessionRoster(options), true);
  assert.strictEqual(clearSessionRoster(options), false);
  assert.strictEqual(fs.existsSync(file), false);
});

test('leaves other sessions\' roster files alone', () => {
  const mine = writeRoster('shell-one');
  const theirs = writeRoster('shell-two');

  assert.strictEqual(clearSessionRoster({ sessionKey: 'shell-one', sessionRosterDir: sessionsDir }), true);

  assert.strictEqual(fs.existsSync(mine), false);
  assert.strictEqual(fs.existsSync(theirs), true);
  assert.deepStrictEqual(fs.readdirSync(sessionsDir), [path.basename(theirs)]);
});

test('keys that only differ in punctuation do not share a file', () => {
  const slash = writeRoster('shell/b');
  const dash = writeRoster('shell-b');
  assert.notStrictEqual(slash, dash);

  assert.strictEqual(clearSessionRoster({ sessionKey: 'shell/b', sessionRosterDir: sessionsDir }), true);

  assert.strictEqual(fs.existsSync(slash), false);
  assert.strictEqual(fs.existsSync(dash), true);
});

test('a key full of path tricks only touches a file inside the sessions folder', () => {
  const outside = path.join(scratch, 'outside.md');
  fs.writeFileSync(outside, 'keep me\n');
  const key = '../outside';
  const file = writeRoster(key);
  assert.strictEqual(path.dirname(file), sessionsDir);

  assert.strictEqual(clearSessionRoster({ sessionKey: key, sessionRosterDir: sessionsDir }), true);

  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep me\n');
});

test('trims whitespace around the session key', () => {
  const file = writeRoster('padded');

  assert.strictEqual(clearSessionRoster({ sessionKey: '  padded  ', sessionRosterDir: sessionsDir }), true);

  assert.strictEqual(fs.existsSync(file), false);
});

test('throws the no-session message when the key is empty or blank', () => {
  const file = writeRoster('shell-one');

  for (const sessionKey of ['', '   ', null]) {
    assert.throws(
      () => clearSessionRoster({ sessionKey, sessionRosterDir: sessionsDir }),
      (err) => err instanceof Error && err.message === NO_SESSION_MESSAGE,
    );
  }
  assert.match(NO_SESSION_MESSAGE, /ATRIS_ROSTER_SESSION/);
  assert.strictEqual(fs.existsSync(file), true);
});

test('an explicit empty sessionKey wins over ATRIS_ROSTER_SESSION', () => {
  process.env.ATRIS_ROSTER_SESSION = 'from-env';
  const file = writeRoster('from-env');

  assert.throws(
    () => clearSessionRoster({ sessionKey: '', sessionRosterDir: sessionsDir }),
    (err) => err.message === NO_SESSION_MESSAGE,
  );
  assert.strictEqual(fs.existsSync(file), true);
});

test('reads the session from ATRIS_ROSTER_SESSION and the folder from ATRIS_ROSTER_SESSIONS_DIR', () => {
  process.env.ATRIS_ROSTER_SESSION = 'from-env';
  process.env.ATRIS_ROSTER_SESSIONS_DIR = sessionsDir;
  const file = writeRoster('from-env');
  const other = writeRoster('someone-else');

  assert.strictEqual(clearSessionRoster(), true);

  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(fs.existsSync(other), true);
  assert.strictEqual(clearSessionRoster(), false);
});

test('finds the sessions folder beside a scratch machine roster path', () => {
  const machineRosterFile = path.join(scratch, 'machine', 'roster.json');
  const beside = path.join(scratch, 'machine', 'sessions');
  fs.mkdirSync(beside, { recursive: true });
  const key = 'beside-machine';
  const readable = key;
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  const file = path.join(beside, `roster-${readable}-${hash}.md`);
  fs.writeFileSync(file, '## small build\n\n- claude code\n');

  assert.strictEqual(clearSessionRoster({ sessionKey: key, machineRosterFile }), true);

  assert.strictEqual(fs.existsSync(file), false);
});

test('returns false and keeps the file when session rosters are switched off', () => {
  const file = writeRoster('shell-one');

  const cleared = clearSessionRoster({ sessionKey: 'shell-one', sessionRosterDir: sessionsDir, sessionRoster: false });

  assert.strictEqual(cleared, false);
  assert.strictEqual(fs.existsSync(file), true);
});

test('returns false when the sessions folder does not exist', () => {
  const missing = path.join(scratch, 'no-such-folder');

  assert.strictEqual(clearSessionRoster({ sessionKey: 'shell-one', sessionRosterDir: missing }), false);
  assert.strictEqual(fs.existsSync(missing), false);
});
