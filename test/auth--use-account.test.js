const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { useAccount } = require('../commands/auth');
const { saveProfile, getCredentialsPath } = require('../utils/auth');

// Every env name the account code reads. Cleared so this machine cannot leak in.
const CLEARED_ENV = /^(ATRIS_|TERM_SESSION_ID$|ITERM_SESSION_ID$|TMUX_PANE$|WT_SESSION$|WEZTERM_PANE$)/;

class ExitCalled extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-use-account-'));
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (CLEARED_ENV.test(name)) delete process.env[name];
  }
  process.env.HOME = home;
  // A fixed id keeps the session lookup from shelling out to `tty`.
  process.env.TERM_SESSION_ID = 'atris-use-account-test';
  t.after(() => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
  });
}

// Runs useAccount with its argv and output captured. out.exit is null when
// the function returned normally, otherwise the code it passed to process.exit.
function run(args, { isTTY = false } = {}) {
  const out = { log: [], error: [], stdout: '', exit: null };
  const originals = {
    log: console.log,
    error: console.error,
    write: process.stdout.write,
    exit: process.exit,
    argv: process.argv,
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
  };
  console.log = (...parts) => out.log.push(parts.join(' '));
  console.error = (...parts) => out.error.push(parts.join(' '));
  process.stdout.write = (chunk) => { out.stdout += chunk; return true; };
  process.exit = (code = 0) => { throw new ExitCalled(code); };
  process.argv = ['node', 'atris', 'use', ...args];
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  try {
    useAccount();
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
    out.exit = err.code;
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    process.stdout.write = originals.write;
    process.exit = originals.exit;
    process.argv = originals.argv;
    if (originals.isTTY) Object.defineProperty(process.stdout, 'isTTY', originals.isTTY);
    else delete process.stdout.isTTY;
  }
  return out;
}

test('useAccount with a name writes only the export line when stdout is piped', t => {
  sandbox(t);
  saveProfile('work', { token: 'work-token', email: 'work@example.test' });
  saveProfile('personal', { token: 'personal-token', email: 'me@example.test' });

  const out = run(['--quiet', 'WORK']);

  assert.strictEqual(out.stdout, 'export ATRIS_PROFILE=work\n');
  assert.deepStrictEqual(out.log, []);
  assert.deepStrictEqual(out.error, []);
  assert.strictEqual(out.exit, null);
});

test('useAccount matches an email fragment, ignoring case', t => {
  sandbox(t);
  saveProfile('work', { token: 'work-token', email: 'work@example.test' });
  saveProfile('personal', { token: 'personal-token', email: 'me@example.test' });

  const out = run(['ME@EXAMPLE']);

  assert.strictEqual(out.stdout, 'export ATRIS_PROFILE=personal\n');
  assert.strictEqual(out.exit, null);
});

test('useAccount with a name that matches nothing lists the accounts and exits 1', t => {
  sandbox(t);
  saveProfile('work', { token: 'work-token', email: 'work@example.test' });

  const out = run(['nobody']);

  assert.deepStrictEqual(out.error, ['No account matching "nobody".', 'Available: work']);
  assert.strictEqual(out.stdout, '');
  assert.strictEqual(out.exit, 1);
});

test('useAccount with no accounts on disk exits 1 with an empty list', t => {
  sandbox(t);

  const out = run(['work']);

  assert.deepStrictEqual(out.error, ['No account matching "work".', 'Available: ']);
  assert.strictEqual(out.stdout, '');
  assert.strictEqual(out.exit, 1);
});

test('useAccount with no name shows the account this terminal is pinned to', t => {
  sandbox(t);
  saveProfile('work', { token: 'work-token', email: 'work@example.test' });
  process.env.ATRIS_PROFILE = 'work';

  const out = run([]);

  assert.strictEqual(out.log[0], 'This terminal: work@example.test (ATRIS_PROFILE=work)');
  assert.strictEqual(out.exit, 0);
  assert.strictEqual(out.stdout, '');
});

test('useAccount with no name shows the global login when no terminal is pinned', t => {
  sandbox(t);
  fs.writeFileSync(getCredentialsPath(), JSON.stringify({ token: 'session-token', email: 'global@example.test' }));

  const out = run([]);

  assert.strictEqual(out.log[0], 'Global: global@example.test (no per-terminal override)');
  assert.strictEqual(out.exit, 0);
});

test('useAccount with no name and no login says not signed in', t => {
  sandbox(t);

  const out = run([]);

  assert.strictEqual(out.log[0], 'Not signed in.');
  assert.strictEqual(out.exit, 0);
});

test('useAccount in a terminal prints the export line and the activation hint', t => {
  sandbox(t);
  saveProfile('work', { token: 'work-token', email: 'work@example.test' });

  const out = run(['work'], { isTTY: true });

  assert.deepStrictEqual(out.log, [
    'export ATRIS_PROFILE=work',
    '\n# Run this to activate work@example.test in this terminal:',
    '#   eval "$(atris use work)"',
    '# Or just copy the export line above.',
  ]);
  assert.strictEqual(out.stdout, '');
  assert.strictEqual(out.exit, null);
});
