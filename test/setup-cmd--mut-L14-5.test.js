'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-setup-mut-'));
process.env.HOME = tmpHome;

const fakeAuth = {
  loadCredentials: () => ({ token: 'test-token', email: 'test@example.com' }),
  promptUser: async () => 'skip',
};
const fakeApi = {
  apiRequestJson: async () => ({ ok: true, data: [] }),
};
const fakeLogin = { loginAtris: async () => {} };
const fakePull = { pullAtris: async () => {} };

require.cache[require.resolve('../utils/auth')] = {
  id: require.resolve('../utils/auth'),
  filename: require.resolve('../utils/auth'),
  loaded: true,
  exports: fakeAuth,
};
require.cache[require.resolve('../utils/api')] = {
  id: require.resolve('../utils/api'),
  filename: require.resolve('../utils/api'),
  loaded: true,
  exports: fakeApi,
};
require.cache[require.resolve('../commands/auth')] = {
  id: require.resolve('../commands/auth'),
  filename: require.resolve('../commands/auth'),
  loaded: true,
  exports: fakeLogin,
};
require.cache[require.resolve('../commands/pull')] = {
  id: require.resolve('../commands/pull'),
  filename: require.resolve('../commands/pull'),
  loaded: true,
  exports: fakePull,
};

const { setupAtris } = require('../commands/setup');

test('Node.js 18 satisfies the minimum version requirement', async (t) => {
  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const origVersion = process.versions.node;
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;

  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));

  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`process.exit: ${code}`);
  };

  Object.defineProperty(process.versions, 'node', {
    value: '18.0.0',
    configurable: true,
    writable: true,
  });

  try {
    try {
      await setupAtris();
    } catch (err) {
      if (!err.message.startsWith('process.exit')) {
        throw err;
      }
    }

    const out = lines.join('\n');
    assert.match(out, /  \[1\/4\] Node\.js 18\.0\.0 \.\.\. OK/);
    assert.doesNotMatch(out, /Node\.js 18\.0\.0 is too old\. Atris requires Node\.js 18 or newer\./);
    assert.strictEqual(exitCode, null);
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
    Object.defineProperty(process.versions, 'node', {
      value: origVersion,
      configurable: true,
      writable: false,
    });
  }
});
