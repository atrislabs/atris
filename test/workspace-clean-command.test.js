'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanWorkspace } = require('../commands/workspace-clean');

const ENV_KEYS = [
  'ATRIS_TOKEN',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_CLIENT_SECRET_FILE',
  'ATRIS_PROFILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_TEST_REAL_HOME',
  'ATRIS_TEST_STATE_DIR',
];

// Run cleanWorkspace with controlled argv, HOME, and captured output.
// process.exit is replaced with a recorder that throws so the command's
// exit paths can be asserted without killing the test runner.
async function run(t, argv, { home } = {}) {
  const stdout = [];
  const stderr = [];
  const exits = [];

  const savedArgv = process.argv;
  const savedHome = process.env.HOME;
  const savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;

  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  process.exit = (code) => {
    exits.push(code);
    throw new Error(`process.exit(${code})`);
  };

  if (home) process.env.HOME = home;
  process.argv = argv;

  const restore = () => {
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.argv = savedArgv;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  };
  t.after(restore);

  let error = null;
  try {
    await cleanWorkspace();
  } catch (err) {
    error = err;
  } finally {
    restore();
  }

  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exits, error };
}

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clean-ws-'));
  return home;
}

function writeJson(home, rel, value) {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

test('exports cleanWorkspace as a function', () => {
  assert.equal(typeof cleanWorkspace, 'function');
});

test('prints usage when no slug is given', async (t) => {
  const result = await run(t, ['node', 'atris', 'clean-workspace']);
  assert.equal(result.error, null);
  assert.deepEqual(result.exits, []);
  assert.match(result.stdout, /Usage: atris clean-workspace <business-slug> \[--yes\]/);
  assert.match(result.stdout, /Detects:/);
  assert.match(result.stdout, /Empty files/);
});

test('prints usage for help arguments', async (t) => {
  for (const arg of ['--help', '-h', 'help']) {
    const result = await run(t, ['node', 'atris', 'clean-workspace', arg]);
    assert.equal(result.error, null);
    assert.match(result.stdout, /Usage: atris clean-workspace/);
    assert.match(result.stdout, /--yes to actually delete/);
  }
});

test('exits when no credentials are stored', async (t) => {
  const home = makeHome(t);
  const result = await run(t, ['node', 'atris', 'clean-workspace', 'acme'], { home });
  assert.deepEqual(result.exits, [1]);
  assert.match(result.stderr, /Not logged in\. Run: atris login/);
});

test('exits when the cached business has no workspace', async (t) => {
  const home = makeHome(t);
  writeJson(home, '.atris/credentials.json', { token: 'test-token' });
  writeJson(home, '.atris/businesses.json', {
    acme: { business_id: 'biz-1', workspace_id: null, name: 'Acme' },
  });

  const result = await run(t, ['node', 'atris', 'clean-workspace', 'acme'], { home });
  assert.deepEqual(result.exits, [1]);
  assert.match(result.stderr, /Business "acme" has no workspace\./);
});
