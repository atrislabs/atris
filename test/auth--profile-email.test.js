const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { profileEmail } = require('../commands/auth');

// profileEmail is a hidden command (`atris _profile-email <name>`): it reads
// the profile name from process.argv[3], loads
// <home>/.atris/profiles/<name>.json, writes the stored email to stdout, and
// calls process.exit. Each test sandboxes the home directory and stubs
// argv/stdout/exit so nothing real is touched.
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-profile-email-'));
  t.mock.method(os, 'homedir', () => dir);
  const savedEnv = {};
  for (const name of ['HOME', ...Object.keys(process.env).filter((key) => key.startsWith('ATRIS_'))]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.HOME = dir;
  t.after(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const profilesDir = path.join(dir, '.atris', 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  return { dir, profilesDir };
}

function run(t, argv) {
  const chunks = [];
  const exits = [];
  t.mock.method(process.stdout, 'write', (chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  t.mock.method(process, 'exit', (code) => {
    exits.push(code);
    throw new Error(`process.exit(${code})`);
  });
  const before = process.argv;
  process.argv = argv;
  try {
    profileEmail();
  } catch (err) {
    assert.match(err.message, /^process\.exit\(\d+\)$/);
  } finally {
    process.argv = before;
  }
  return { exits, stdout: chunks.join('') };
}

const argvFor = (name) => (name === undefined
  ? ['node', 'atris', '_profile-email']
  : ['node', 'atris', '_profile-email', name]);

test('prints the stored email and exits 0 for a known profile', (t) => {
  const { profilesDir } = sandbox(t);
  fs.writeFileSync(
    path.join(profilesDir, 'alice.json'),
    JSON.stringify({ email: 'alice@example.com', token: 'secret', user_id: 'u1' }),
  );
  const { exits, stdout } = run(t, argvFor('alice'));
  assert.deepEqual(exits, [0]);
  assert.equal(stdout, 'alice@example.com');
});

test('exits 1 with no output when no profile name is given', (t) => {
  sandbox(t);
  const { exits, stdout } = run(t, argvFor(undefined));
  assert.deepEqual(exits, [1]);
  assert.equal(stdout, '');
});

test('exits 1 with no output for a profile that does not exist', (t) => {
  sandbox(t);
  const { exits, stdout } = run(t, argvFor('ghost'));
  assert.deepEqual(exits, [1]);
  assert.equal(stdout, '');
});

test('exits 1 with no output when the profile file has no email', (t) => {
  const { profilesDir } = sandbox(t);
  fs.writeFileSync(
    path.join(profilesDir, 'noemail.json'),
    JSON.stringify({ token: 'secret', user_id: 'u2' }),
  );
  const { exits, stdout } = run(t, argvFor('noemail'));
  assert.deepEqual(exits, [1]);
  assert.equal(stdout, '');
});

test('exits 1 with no output when the profile file is not valid json', (t) => {
  const { profilesDir } = sandbox(t);
  fs.writeFileSync(path.join(profilesDir, 'broken.json'), '{not json');
  const { exits, stdout } = run(t, argvFor('broken'));
  assert.deepEqual(exits, [1]);
  assert.equal(stdout, '');
});
