'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// resolveProfile reads its query from process.argv[3], prints the matched
// profile name to stdout, and ends the process with exit(0) or exit(1). To
// call it in-process we swap argv, stdout.write and exit for the duration of
// one synchronous call. Profiles are read from ~/.atris/profiles, so HOME
// points at a scratch dir and every ATRIS_* variable is cleared first.
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { resolveProfile } = require('../commands/auth');

test.after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function makeHome(profiles = {}, extraFiles = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-resolve-profile-'));
  const dir = path.join(home, '.atris', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, creds] of Object.entries(profiles)) {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(creds));
  }
  for (const [file, raw] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, file), raw);
  }
  return home;
}

// Runs resolveProfile against a scratch HOME and returns { code, out }.
// Pass `undefined` as the query to leave argv[3] unset.
function run(home, query) {
  const saved = {
    argv: process.argv,
    exit: process.exit,
    write: process.stdout.write,
    home: process.env.HOME,
    userprofile: process.env.USERPROFILE,
  };
  let out = '';
  let code = null;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.argv = query === undefined
    ? [process.argv[0], process.argv[1], '_resolve']
    : [process.argv[0], process.argv[1], '_resolve', query];
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  process.exit = (c) => {
    throw new ExitSignal(c);
  };
  try {
    resolveProfile();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    code = err.code;
  } finally {
    process.argv = saved.argv;
    process.exit = saved.exit;
    process.stdout.write = saved.write;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.userprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.userprofile;
  }
  return { code, out };
}

function withHome(profiles, extraFiles, fn) {
  const home = makeHome(profiles, extraFiles);
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('exact name match prints the profile name and exits 0', () => {
  withHome({ alex: { email: 'alex@example.com' }, alexander: { email: 'big@example.com' } }, {}, (home) => {
    assert.deepEqual(run(home, 'alex'), { code: 0, out: 'alex' });
    assert.deepEqual(run(home, 'alexander'), { code: 0, out: 'alexander' });
  });
});

test('matching ignores case in the query and keeps the saved name casing', () => {
  withHome({ Casey: { email: 'casey@example.com' } }, {}, (home) => {
    assert.deepEqual(run(home, 'CASEY'), { code: 0, out: 'Casey' });
    assert.deepEqual(run(home, 'cAs'), { code: 0, out: 'Casey' });
  });
});

test('a prefix beats a substring match', () => {
  withHome({ 'acme-prod': {}, 'prod-eu': {} }, {}, (home) => {
    assert.deepEqual(run(home, 'prod'), { code: 0, out: 'prod-eu' });
  });
});

test('a substring matches when no name starts with the query', () => {
  withHome({ 'work-main': {}, personal: {} }, {}, (home) => {
    assert.deepEqual(run(home, 'main'), { code: 0, out: 'work-main' });
  });
});

test('falls back to the saved email when no profile name matches', () => {
  withHome({ bob: { email: 'Robert.Smith@Example.com' }, dana: { email: 'dana@example.com' } }, {}, (home) => {
    assert.deepEqual(run(home, 'robert.smith'), { code: 0, out: 'bob' });
    assert.deepEqual(run(home, 'ROBERT.SMITH@EXAMPLE'), { code: 0, out: 'bob' });
  });
});

test('a name match wins over an email match on another profile', () => {
  withHome({ zed: { email: 'mia@example.com' }, 'mia-work': { email: 'other@example.com' } }, {}, (home) => {
    assert.deepEqual(run(home, 'mia'), { code: 0, out: 'mia-work' });
  });
});

test('no matching profile exits 1 and prints nothing', () => {
  withHome({ alex: { email: 'alex@example.com' } }, {}, (home) => {
    assert.deepEqual(run(home, 'nobody'), { code: 1, out: '' });
  });
});

test('missing query exits 1 and prints nothing', () => {
  withHome({ alex: { email: 'alex@example.com' } }, {}, (home) => {
    assert.deepEqual(run(home, undefined), { code: 1, out: '' });
  });
});

test('empty query exits 1 instead of matching every profile', () => {
  withHome({ alex: { email: 'alex@example.com' } }, {}, (home) => {
    assert.deepEqual(run(home, ''), { code: 1, out: '' });
  });
});

test('no saved profiles at all exits 1', () => {
  withHome({}, {}, (home) => {
    assert.deepEqual(run(home, 'alex'), { code: 1, out: '' });
  });
});

test('missing profiles folder exits 1', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-resolve-profile-empty-'));
  try {
    assert.deepEqual(run(home, 'alex'), { code: 1, out: '' });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('non-json files and unreadable profiles do not break the lookup', () => {
  const extras = { 'notes.txt': 'alex was here', 'broken.json': '{not json' };
  withHome({ dana: { email: 'dana@example.com' } }, extras, (home) => {
    assert.deepEqual(run(home, 'notes'), { code: 1, out: '' });
    assert.deepEqual(run(home, 'dana@example'), { code: 0, out: 'dana' });
    assert.deepEqual(run(home, 'broken'), { code: 1, out: '' });
  });
});
