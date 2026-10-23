const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { accountsCmd } = require('../commands/auth');

const SESSION_ENV_VARS = ['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'TMUX_PANE', 'WT_SESSION', 'WEZTERM_PANE'];

// Point every source of account state at a throwaway home: os.homedir() for
// lib/state-home, HOME for anything reading the environment, and a clean slate
// of ATRIS_* and terminal-session variables so nothing leaks in from the host.
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-accounts-'));
  t.mock.method(os, 'homedir', () => dir);

  const names = new Set(['HOME', ...SESSION_ENV_VARS, ...Object.keys(process.env).filter((k) => k.startsWith('ATRIS_'))]);
  const saved = {};
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.HOME = dir;
  t.after(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedProfile(dir, name, fields) {
  const profilesDir = path.join(dir, '.atris', 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, `${name}.json`), JSON.stringify({
    token: `token-${name}`,
    saved_at: '2024-01-01T00:00:00.000Z',
    ...fields,
  }));
}

function seedCredentials(dir, fields) {
  const atrisDir = path.join(dir, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'credentials.json'), JSON.stringify({
    provider: 'manual',
    saved_at: '2024-01-01T00:00:00.000Z',
    ...fields,
  }));
}

// accountsCmd ends most branches with process.exit; swap it for a sentinel
// throw so the runner survives and the code is observable.
async function runAccounts(argv) {
  const exits = [];
  const logs = [];
  const errors = [];
  const realExit = process.exit;
  const realLog = console.log;
  const realError = console.error;
  process.exit = (code) => {
    exits.push(code);
    throw new Error(`__exit__:${code}`);
  };
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await accountsCmd(argv);
  } catch (error) {
    if (!String(error && error.message).startsWith('__exit__:')) throw error;
  } finally {
    process.exit = realExit;
    console.log = realLog;
    console.error = realError;
  }
  return { exits, logs, errors };
}

test('accounts on an empty home says there are no saved accounts', async (t) => {
  sandbox(t);
  const { exits, logs, errors } = await runAccounts([]);
  assert.deepStrictEqual(exits, [0]);
  assert.deepStrictEqual(logs, ['No accounts saved. Run "atris login" to add one.']);
  assert.deepStrictEqual(errors, []);
});

test('accounts --global --json lists every saved profile with the active one marked', async (t) => {
  const dir = sandbox(t);
  seedProfile(dir, 'alice', { email: 'alice@example.com', user_id: 'u-alice' });
  seedProfile(dir, 'bob', { email: 'bob@example.com', user_id: 'u-bob' });
  seedCredentials(dir, { token: 'token-alice', email: 'alice@example.com', user_id: 'u-alice' });

  const { exits, logs } = await runAccounts(['--global', '--json']);
  assert.deepStrictEqual(exits, [0]);
  const payload = JSON.parse(logs.join('\n'));
  assert.equal(payload.scope, 'global');
  assert.equal(payload.total_profiles, 2);
  const byName = Object.fromEntries(payload.accounts.map((row) => [row.name, row]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['alice', 'bob']);
  assert.deepStrictEqual(byName.alice, { name: 'alice', email: 'alice@example.com', active: true });
  assert.deepStrictEqual(byName.bob, { name: 'bob', email: 'bob@example.com', active: false });
});

test('workspace scope reports only the active account while counting all profiles', async (t) => {
  const dir = sandbox(t);
  seedProfile(dir, 'alice', { email: 'alice@example.com', user_id: 'u-alice' });
  seedProfile(dir, 'bob', { email: 'bob@example.com', user_id: 'u-bob' });
  seedCredentials(dir, { token: 'token-alice', email: 'alice@example.com', user_id: 'u-alice' });

  const { exits, logs } = await runAccounts(['--json']);
  assert.deepStrictEqual(exits, [0]);
  const payload = JSON.parse(logs.join('\n'));
  assert.equal(payload.scope, 'workspace');
  assert.equal(payload.total_profiles, 2);
  assert.deepStrictEqual(payload.accounts, [{ name: 'alice', email: 'alice@example.com', active: true }]);
});

test('workspace text listing marks the active account and counts hidden profiles', async (t) => {
  const dir = sandbox(t);
  seedProfile(dir, 'alice', { email: 'alice@example.com', user_id: 'u-alice' });
  seedProfile(dir, 'bob', { email: 'bob@example.com', user_id: 'u-bob' });
  seedCredentials(dir, { token: 'token-alice', email: 'alice@example.com', user_id: 'u-alice' });

  const { exits, logs } = await runAccounts([]);
  assert.deepStrictEqual(exits, []);
  assert.ok(logs.some((line) => line.includes('● alice  alice@example.com')));
  assert.ok(!logs.some((line) => line.includes('bob@example.com')));
  assert.ok(logs.some((line) => line.includes('1 more profile(s) hidden. Pass --global to list them.')));
});

test('workspace listing with saved profiles but no active account points at --global', async (t) => {
  const dir = sandbox(t);
  seedProfile(dir, 'alice', { email: 'alice@example.com', user_id: 'u-alice' });
  seedProfile(dir, 'bob', { email: 'bob@example.com', user_id: 'u-bob' });

  const { exits, logs } = await runAccounts([]);
  assert.deepStrictEqual(exits, [0]);
  assert.deepStrictEqual(logs, [
    'No active account in this workspace.',
    'Pass --global to list all saved profiles, or atris switch <name>.',
  ]);
});

test('accounts remove without a name prints usage, exits 1, and deletes nothing', async (t) => {
  const dir = sandbox(t);
  seedProfile(dir, 'alice', { email: 'alice@example.com', user_id: 'u-alice' });

  const { exits, logs } = await runAccounts(['remove']);
  assert.deepStrictEqual(exits, [1]);
  assert.deepStrictEqual(logs, [
    'Usage: atris accounts remove <name>',
    '       atris accounts remove --all',
  ]);
  assert.ok(fs.existsSync(path.join(dir, '.atris', 'profiles', 'alice.json')));
});
