'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep any credential/profile reads inside a temp home.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-setup-test-'));
process.env.HOME = tmpHome;

// commands/setup.js hits the network (utils/api), prompts and reads credentials
// (utils/auth), and lazily requires ./auth and ./pull for the login and pull
// flows. It destructures those functions at require time, so the fakes below
// delegate to a mutable `impl` object that each test can re-point safely.
const impl = {
  loadCredentials: () => null,
  promptUser: async () => '',
  apiRequestJson: async () => ({ ok: true, data: [] }),
  loginAtris: async () => {},
  pullAtris: async () => {},
};

const fakeAuth = {
  loadCredentials: (...args) => impl.loadCredentials(...args),
  promptUser: (...args) => impl.promptUser(...args),
};
const fakeApi = { apiRequestJson: (...args) => impl.apiRequestJson(...args) };
const fakeLogin = { loginAtris: (...args) => impl.loginAtris(...args) };
const fakePull = { pullAtris: (...args) => impl.pullAtris(...args) };

for (const [modPath, exportsObj] of [
  [require.resolve('../utils/auth'), fakeAuth],
  [require.resolve('../utils/api'), fakeApi],
  [require.resolve('../commands/auth'), fakeLogin],
  [require.resolve('../commands/pull'), fakePull],
]) {
  require.cache[modPath] = { id: modPath, filename: modPath, loaded: true, exports: exportsObj };
}

const { setupAtris } = require('../commands/setup');

function capture() {
  const lines = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  return {
    text: () => lines.join('\n'),
    restore() {
      console.log = realLog;
      console.error = realErr;
    },
  };
}

test('logged-in user sees the fetch error and the finish banner when the API fails', async () => {
  const calls = [];
  impl.loadCredentials = () => ({ token: 'tok-1', email: 'dev@example.com' });
  impl.apiRequestJson = async (pathname, options) => {
    calls.push({ pathname, options });
    return { ok: false, status: 500, error: 'server exploded' };
  };

  const cap = capture();
  try {
    await setupAtris();
  } finally {
    cap.restore();
  }
  const out = cap.text();

  assert.deepEqual(calls.map((c) => c.pathname), ['/business/']);
  assert.equal(calls[0].options.token, 'tok-1');
  assert.match(out, /Logged in as dev@example\.com/);
  assert.match(out, /Could not fetch businesses: server exploded/);
  assert.match(out, /atris business add <slug>/);
  assert.match(out, /You're all set! Run `atris activate` to start\./);
});

test('picking a business by number pulls its slug', async () => {
  const pulled = [];
  impl.loadCredentials = () => ({ token: 'tok-2', email: 'dev@example.com' });
  impl.apiRequestJson = async () => ({
    ok: true,
    status: 200,
    data: [
      { name: 'Alpha', slug: 'alpha' },
      { name: 'Beta Co', slug: 'beta-co' },
    ],
  });
  impl.promptUser = async () => '2';
  impl.pullAtris = async () => { pulled.push(process.argv[3]); };

  const cap = capture();
  try {
    await setupAtris();
  } finally {
    cap.restore();
  }
  const out = cap.text();

  assert.deepEqual(pulled, ['beta-co']);
  assert.match(out, /1\. Alpha \(alpha\)/);
  assert.match(out, /2\. Beta Co \(beta-co\)/);
  assert.match(out, /\[4\/4\] Pulling "Beta Co"/);
  assert.match(out, /Pulled "Beta Co" \.\.\. OK/);
  assert.match(out, /You're all set!/);
});

test('skip answer finishes without pulling anything', async () => {
  const pulled = [];
  impl.loadCredentials = () => ({ token: 'tok-3', email: 'dev@example.com' });
  impl.apiRequestJson = async () => ({
    ok: true,
    status: 200,
    data: [{ name: 'Alpha', slug: 'alpha' }],
  });
  impl.promptUser = async () => 'skip';
  impl.pullAtris = async () => { pulled.push(process.argv[3]); };

  const cap = capture();
  try {
    await setupAtris();
  } finally {
    cap.restore();
  }
  const out = cap.text();

  assert.deepEqual(pulled, []);
  assert.match(out, /Skipped\. You can pull a business later with: atris pull <slug>/);
  assert.match(out, /You're all set!/);
});

test('no saved login runs login, reloads credentials, then lists zero businesses', async () => {
  let credCalls = 0;
  let loginCalls = 0;
  impl.loadCredentials = () => {
    credCalls += 1;
    return credCalls === 1 ? null : { token: 'tok-4', email: 'new@example.com' };
  };
  impl.loginAtris = async () => {
    loginCalls += 1;
    process.exit(0);
  };
  impl.apiRequestJson = async () => ({ ok: true, status: 200, data: [] });

  const cap = capture();
  try {
    await setupAtris();
  } finally {
    cap.restore();
  }
  const out = cap.text();

  assert.equal(loginCalls, 1);
  assert.ok(credCalls >= 2, 'credentials reloaded after login');
  assert.match(out, /Not logged in\. Starting login/);
  assert.match(out, /\[2\/4\] Logged in \.\.\. OK/);
  assert.match(out, /No businesses found on your account\./);
  assert.match(out, /You're all set!/);
});

test('an expired login exits after the 401 from the business list', async () => {
  impl.loadCredentials = () => ({ token: 'expired-tok', email: 'dev@example.com' });
  impl.apiRequestJson = async () => ({ ok: false, status: 401, error: 'unauthorized' });

  const cap = capture();
  const exits = [];
  const realExit = process.exit;
  process.exit = (code) => { exits.push(code); };
  try {
    await setupAtris();
  } finally {
    process.exit = realExit;
    cap.restore();
  }
  const out = cap.text();

  assert.ok(exits.includes(1));
  assert.match(out, /saved login has expired/);
  assert.match(out, /Run "atris login", then "atris setup" again\./);
});
