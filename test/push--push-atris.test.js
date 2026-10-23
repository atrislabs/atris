const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These cases stop before API discovery. Keep the real command, filesystem,
// argument parsing, and credential loading; intercept only output and exit.
async function runPush(t, args, prepare = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-atris-'));
  const cwd = process.cwd();
  const argv = process.argv;
  const env = { ...process.env };
  const logs = [];
  const errors = [];
  const stopped = new Error('intercepted process.exit');
  let exitCode;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.TERM_SESSION_ID = 'push-atris-test';
    process.chdir(root);
    process.argv = [process.execPath, 'atris', 'push', ...args];
    prepare(root);
    t.mock.method(console, 'log', (...parts) => logs.push(parts.join(' ')));
    t.mock.method(console, 'error', (...parts) => errors.push(parts.join(' ')));
    t.mock.method(process, 'exit', (code) => {
      exitCode = code;
      throw stopped;
    });
    const { pushAtris } = require('../commands/push');
    try {
      await pushAtris();
      assert.fail('expected the command to exit before API discovery');
    } catch (error) {
      assert.strictEqual(error, stopped);
    }
    return { logs, errors, exitCode };
  } finally {
    t.mock.restoreAll();
    process.chdir(cwd);
    process.argv = argv;
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('pushAtris prints help for an explicit help flag without login', async (t) => {
  const result = await runPush(t, ['example-co', '--help']);
  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(result.errors, []);
  assert.match(result.logs[0], /^Usage: atris push \[business\]/);
  assert.ok(result.logs.includes('  atris push --changed         Push only files that differ from the last-synced manifest'));
});

test('pushAtris treats positional help as help', async (t) => {
  const result = await runPush(t, ['help']);
  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(result.errors, []);
  assert.match(result.logs.join('\n'), /--yes\s+Skip interactive confirmation/);
});

test('pushAtris prints usage for empty input and malformed local metadata', async (t) => {
  for (const malformed of [false, true]) {
    const result = await runPush(t, [], (root) => {
      if (malformed) {
        fs.mkdirSync(path.join(root, '.atris'));
        fs.writeFileSync(path.join(root, '.atris', 'business.json'), '{invalid');
      }
    });
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(result.errors, []);
    assert.match(result.logs[0], /^Usage: atris push/);
  }
});

test('pushAtris rejects a business push without credentials', async (t) => {
  const result = await runPush(t, ['example-co']);
  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.logs, []);
  assert.deepStrictEqual(result.errors, ['Not logged in. Run: atris login']);
});

test('pushAtris rejects a missing source folder with local credentials', async (t) => {
  const result = await runPush(t, ['example-co'], (root) => {
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'),
      JSON.stringify({ token: 'local-test-token' }));
  });
  assert.strictEqual(result.exitCode, 1);
  assert.deepStrictEqual(result.logs, []);
  assert.deepStrictEqual(result.errors, [
    'No local folder found for "example-co".',
    'Run from inside a pulled folder, or: atris push example-co --from ./path',
  ]);
});
