// probeCommand exits before any turn is sent when there is no login. These runs
// use a temp HOME with no credentials (or an empty token), so they never touch
// the real ~/.atris or the network. The live pass/fail path needs a real
// /atris2/turn and is not covered here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeCommand } = require('../commands/probe');

const NOT_LOGGED_IN = '✗ Not logged in. Run: atris login';

function sandbox(t, credentials) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-probe-cmd-'));
  const savedHome = process.env.HOME;
  const savedAtris = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ATRIS_')) {
      savedAtris[name] = process.env[name];
      delete process.env[name];
    }
  }
  process.env.HOME = home;

  if (credentials !== undefined) {
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify(credentials));
  }

  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('ATRIS_')) delete process.env[name];
    }
    Object.assign(process.env, savedAtris);
    fs.rmSync(home, { recursive: true, force: true });
  });
}

// Runs probeCommand and returns its exit code plus everything it printed.
async function runProbe(argv) {
  const savedLog = console.log;
  const savedError = console.error;
  const stdout = [];
  const stderr = [];
  console.log = (...parts) => stdout.push(parts.join(' '));
  console.error = (...parts) => stderr.push(parts.join(' '));
  try {
    const code = await probeCommand(argv);
    return { code, stdout, stderr };
  } finally {
    console.log = savedLog;
    console.error = savedError;
  }
}

test('probeCommand with no login prints the login hint, prints no receipt, and returns 1', async (t) => {
  sandbox(t);
  const result = await runProbe([]);
  assert.equal(result.code, 1);
  assert.deepEqual(result.stderr, [NOT_LOGGED_IN]);
  assert.deepEqual(result.stdout, []);
});

test('probeCommand treats a saved login with an empty token as not logged in', async (t) => {
  sandbox(t, { token: '', email: 'probe@example.com', provider: null });
  const result = await runProbe(['--calendar', '--business', 'biz-123']);
  assert.equal(result.code, 1);
  assert.deepEqual(result.stderr, [NOT_LOGGED_IN]);
  assert.deepEqual(result.stdout, []);
});

test('probeCommand parses every flag before the login check, and accepts no argv at all', async (t) => {
  sandbox(t);
  const flagged = await runProbe([
    '--business', 'biz-123',
    '--model', 'atris:pro',
    '--member-slug', 'relay',
    '--calendar',
    '--message', 'what is on my calendar',
  ]);
  assert.equal(flagged.code, 1);
  assert.deepEqual(flagged.stderr, [NOT_LOGGED_IN]);

  const bare = await runProbe(undefined);
  assert.equal(bare.code, 1);
  assert.deepEqual(bare.stderr, [NOT_LOGGED_IN]);
});
