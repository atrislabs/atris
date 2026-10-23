const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sleepAtris } = require('../commands/lifecycle');

const SWITCHES_REL = path.join('.atris', 'state', 'member-switches.json');

// Env vars the sleep path reads (login lookup, profile pick, terminal session id).
// They are cleared for each run so the test never picks up this machine's login.
function isAuthEnvKey(key) {
  return key.startsWith('ATRIS_')
    || ['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'TMUX_PANE', 'WT_SESSION', 'WEZTERM_PANE'].includes(key);
}

function addMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `# ${name}\n`, 'utf8');
}

function readSwitches(root) {
  return JSON.parse(fs.readFileSync(path.join(root, SWITCHES_REL), 'utf8'));
}

// Runs sleepAtris inside a fresh temp folder. Captures console output and
// process.exit (which would otherwise end the test run), then restores everything.
async function runSleep(args, { setup } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sleep-atris-'));
  const previous = {
    cwd: process.cwd(),
    argv: process.argv,
    log: console.log,
    error: console.error,
    exit: process.exit,
    env: { ...process.env },
  };
  const out = [];
  const errors = [];
  const exits = [];
  const stopped = new Error('captured process exit');
  try {
    for (const key of Object.keys(process.env)) {
      if (isAuthEnvKey(key)) delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    if (setup) setup(root);
    process.argv = ['node', 'atris', 'sleep', ...args];
    console.log = (...values) => out.push(values.join(' '));
    console.error = (...values) => errors.push(values.join(' '));
    process.exit = (code) => {
      exits.push(code);
      throw stopped;
    };
    let threw = null;
    try {
      await sleepAtris();
    } catch (error) {
      threw = error;
    }
    // Read the switch file here: the temp folder is removed in finally.
    const switches = fs.existsSync(path.join(root, SWITCHES_REL)) ? readSwitches(root) : null;
    return { out, errors, exits, threw, stopped, switches };
  } finally {
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previous.env)) delete process.env[key];
    }
    Object.assign(process.env, previous.env);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('sleep <member> marks only that member asleep in the local switch file', async () => {
  const result = await runSleep(['alice'], {
    setup: (root) => {
      addMember(root, 'alice');
      addMember(root, 'bob');
    },
  });

  assert.strictEqual(result.threw, null);
  assert.deepStrictEqual(result.out, ['alice is asleep']);
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.exits, []);
  assert.strictEqual(result.switches.members.alice.awake, false);
  assert.strictEqual(result.switches.members.bob, undefined);
});

test('sleep <member> --loop <id> sleeps that loop and leaves the member itself awake', async () => {
  const result = await runSleep(['alice', '--loop', 'nightly'], {
    setup: (root) => addMember(root, 'alice'),
  });

  assert.strictEqual(result.threw, null);
  assert.deepStrictEqual(result.out, ['alice loop nightly is asleep']);
  assert.deepStrictEqual(result.exits, []);
  assert.strictEqual(result.switches.members.alice.awake, true);
  assert.strictEqual(result.switches.members.alice.loops.nightly, false);
});

test('sleep <member> --help prints usage, exits 0, and does not flip the member', async () => {
  const result = await runSleep(['alice', '--help'], {
    setup: (root) => addMember(root, 'alice'),
  });

  assert.strictEqual(result.threw, result.stopped);
  assert.deepStrictEqual(result.exits, [0]);
  assert.deepStrictEqual(result.out, [
    'Usage: atris sleep [business|member] [--loop <loop-id>]',
    '',
    '  Pause a workspace to save compute. Storage only.',
    '  Or flip a local member / member-loop switch asleep.',
  ]);
  assert.strictEqual(result.switches, null);
});

test('unknown name with no login exits 1 with a login hint and writes no switch', async () => {
  const result = await runSleep(['ghost']);

  assert.strictEqual(result.threw, result.stopped);
  assert.deepStrictEqual(result.exits, [1]);
  assert.deepStrictEqual(result.errors, ['Not logged in. Run: atris login']);
  assert.deepStrictEqual(result.out, []);
  assert.strictEqual(result.switches, null);
});

test('no name and no bound folder prints usage and exits 0 without touching anything', async () => {
  const result = await runSleep([]);

  assert.strictEqual(result.threw, result.stopped);
  assert.deepStrictEqual(result.exits, [0]);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.out[0], 'Usage: atris sleep [business|member] [--loop <loop-id>]');
  assert.strictEqual(result.switches, null);
});
