const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { wakeAtris } = require('../commands/lifecycle');

const stopped = new Error('captured process exit');

// Env the code reads that could point a run at real machine state.
function sandboxEnvKeys() {
  return [...Object.keys(process.env).filter((key) => key.startsWith('ATRIS_')), 'TERM_SESSION_ID'];
}

function writeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `# ${name}\n`);
}

function writeSwitches(root, members) {
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'member-switches.json'), JSON.stringify({ members }, null, 2));
}

function readSwitches(root) {
  const file = path.join(root, '.atris', 'state', 'member-switches.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).members;
}

async function withSandbox(setup, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lifecycle-wake-'));
  const previous = {
    cwd: process.cwd(),
    home: process.env.HOME,
    argv: process.argv,
    log: console.log,
    error: console.error,
    exit: process.exit,
  };
  const savedEnv = {};
  for (const key of sandboxEnvKeys()) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const logs = [];
  const errors = [];
  const exits = [];
  try {
    process.env.HOME = root;
    process.env.TERM_SESSION_ID = 'lifecycle-wake-test';
    process.chdir(root);
    setup(root);
    console.log = (...values) => logs.push(values.join(' '));
    console.error = (...values) => errors.push(values.join(' '));
    process.exit = (code) => {
      exits.push(code);
      throw stopped;
    };
    const run = async (args) => {
      process.argv = ['node', 'atris', 'wake', ...args];
      try {
        await wakeAtris();
      } catch (error) {
        if (error !== stopped) throw error;
      }
    };
    await body({ root, run, logs, errors, exits });
  } finally {
    console.log = previous.log;
    console.error = previous.error;
    process.exit = previous.exit;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    for (const key of sandboxEnvKeys()) delete process.env[key];
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) process.env[key] = value;
    }
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('wake <member> marks only that member awake', async () => {
  await withSandbox((root) => {
    writeMember(root, 'ada');
    writeMember(root, 'bob');
    writeSwitches(root, {
      ada: { awake: false, loops: {} },
      bob: { awake: false, loops: {} },
    });
  }, async ({ root, run, logs, errors, exits }) => {
    await run(['ada']);

    assert.deepStrictEqual(logs, ['ada is awake']);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(exits, []);
    const members = readSwitches(root);
    assert.strictEqual(members.ada.awake, true);
    assert.strictEqual(members.bob.awake, false);
  });
});

test('wake <member> --loop <id> wakes only that loop and leaves the member asleep', async () => {
  await withSandbox((root) => {
    writeMember(root, 'ada');
    writeSwitches(root, { ada: { awake: false, loops: {} } });
  }, async ({ root, run, logs, errors, exits }) => {
    await run(['ada', '--loop', 'nightly']);

    assert.deepStrictEqual(logs, ['ada loop nightly is awake']);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(exits, []);
    const members = readSwitches(root);
    assert.strictEqual(members.ada.awake, false);
    assert.deepStrictEqual(members.ada.loops, { nightly: true });
  });
});

test('wake with no name and no bound workspace prints usage, exits 0, and writes nothing', async () => {
  await withSandbox(() => {}, async ({ root, run, logs, errors, exits }) => {
    await run([]);

    assert.deepStrictEqual(logs, [
      'Usage: atris wake [business|member] [--loop <loop-id>]',
      '',
      '  Wake a sleeping workspace. Wake signal sent; loops pick it up on their next pass.',
      '  Or flip a local member / member-loop switch awake.',
    ]);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(exits, [0]);
    assert.strictEqual(fs.existsSync(path.join(root, '.atris', 'state', 'member-switches.json')), false);
  });
});

test('wake of a name that is not a local member, with no login, exits 1 and writes nothing', async () => {
  await withSandbox(() => {}, async ({ root, run, logs, errors, exits }) => {
    await run(['ghost']);

    assert.deepStrictEqual(logs, []);
    assert.deepStrictEqual(errors, ['Not logged in. Run: atris login']);
    assert.deepStrictEqual(exits, [1]);
    assert.strictEqual(fs.existsSync(path.join(root, '.atris', 'state', 'member-switches.json')), false);
  });
});
