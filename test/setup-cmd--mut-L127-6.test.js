'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-setup-test-'));
process.env.HOME = tmpHome;

const impl = {
  loadCredentials: () => ({ token: 'tok-test', email: 'dev@example.com' }),
  promptUser: async () => '3',
  apiRequestJson: async () => ({
    ok: true,
    status: 200,
    data: [
      { name: 'Alpha', slug: 'alpha' },
      { name: 'Numeric Slug', slug: '3' },
    ],
  }),
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

test('entering a numeric string matching a business slug pulls that business when outside index range', async () => {
  const pulled = [];
  impl.pullAtris = async () => {
    pulled.push(process.argv[3]);
  };

  const cap = capture();
  try {
    await setupAtris();
  } finally {
    cap.restore();
  }
  const out = cap.text();

  assert.deepEqual(pulled, ['3']);
  assert.match(out, /\[4\/4\] Pulling "Numeric Slug"/);
  assert.match(out, /Pulled "Numeric Slug" \.\.\. OK/);
  assert.doesNotMatch(out, /Could not find a business matching/);
});
