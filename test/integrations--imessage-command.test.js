const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { imessageCommand } = require('../commands/integrations');

function withTempEnv(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-imessage-test-'));
  const savedEnv = { ...process.env };
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;

  const stdout = [];
  const stderr = [];
  const exits = [];

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = tmpDir;

  console.log = (...args) => stdout.push(args.map(String).join(' '));
  console.error = (...args) => stderr.push(args.map(String).join(' '));
  process.exit = (code) => {
    exits.push(code);
    throw new Error(`__exit__:${code}`);
  };

  return Promise.resolve()
    .then(() => fn({ tmpDir, stdout, stderr, exits }))
    .finally(() => {
      console.log = realLog;
      console.error = realError;
      process.exit = realExit;
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
}

test('imessage default prints command help without arguments', async () => {
  await withTempEnv(async ({ stdout, stderr, exits }) => {
    await imessageCommand();
    assert.strictEqual(exits.length, 0);
    assert.strictEqual(stderr.length, 0);
    const text = stdout.join('\n');
    assert.match(text, /iMessage commands:/);
    assert.match(text, /atris imessage doctor/);
    assert.match(text, /atris imessage lookup/);
    assert.match(text, /atris imessage recent/);
    assert.match(text, /atris imessage send/);
  });
});

test('imessage lookup returns cached contact details (normal input)', async () => {
  await withTempEnv(async ({ tmpDir, stdout, exits }) => {
    const cacheDir = path.join(tmpDir, '.atris', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachedContact = {
      version: 1,
      entries: {
        'grace hopper': {
          cached_at: Date.now(),
          raw: {
            ok: true,
            query: 'Grace Hopper',
            self_alias: false,
            contacts_count: 1,
            matches: [
              {
                id: 'contact-gh',
                name: 'Grace Hopper',
                phones: [{ label: 'mobile', value: '+1 (555) 987-6543' }],
                emails: [{ label: 'work', value: 'grace@navy.mil' }],
              },
            ],
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(cacheDir, 'imessage-contacts.json'),
      JSON.stringify(cachedContact, null, 2),
      'utf8'
    );

    // Test JSON format output
    await imessageCommand('lookup', '--name', 'Grace Hopper', '--max-age-minutes', '999999', '--json');
    assert.strictEqual(exits.length, 0);
    const jsonOutput = JSON.parse(stdout.join('\n'));
    assert.strictEqual(jsonOutput.ok, true);
    assert.strictEqual(jsonOutput.action, 'imessage_lookup');
    assert.strictEqual(jsonOutput.cached, true);
    assert.strictEqual(jsonOutput.match_count, 1);
    assert.strictEqual(jsonOutput.unique, true);
    assert.strictEqual(jsonOutput.ambiguous, false);
    assert.strictEqual(jsonOutput.primary.name, 'Grace Hopper');
    assert.strictEqual(jsonOutput.primary.handle, '+15559876543');
    assert.strictEqual(jsonOutput.primary.handles.length, 2);
    assert.strictEqual(jsonOutput.primary.handles[0].handle, '+15559876543');
    assert.strictEqual(jsonOutput.primary.handles[1].handle, 'grace@navy.mil');

    // Test plain text output
    stdout.length = 0;
    await imessageCommand('lookup', '--name', 'Grace Hopper', '--max-age-minutes', '999999');
    assert.strictEqual(stdout[0], 'Grace Hopper: +15559876543 (cached)');
  });
});

test('imessage lookup identifies ambiguous matches when multiple contacts match (edge case)', async () => {
  await withTempEnv(async ({ tmpDir, stdout, exits }) => {
    const cacheDir = path.join(tmpDir, '.atris', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachedContacts = {
      version: 1,
      entries: {
        alex: {
          cached_at: Date.now(),
          raw: {
            ok: true,
            query: 'Alex',
            self_alias: false,
            contacts_count: 2,
            matches: [
              {
                id: 'c1',
                name: 'Alex Rivera',
                phones: [{ label: 'mobile', value: '+1 (555) 111-2222' }],
              },
              {
                id: 'c2',
                name: 'Alex Chen',
                phones: [{ label: 'mobile', value: '+1 (555) 333-4444' }],
              },
            ],
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(cacheDir, 'imessage-contacts.json'),
      JSON.stringify(cachedContacts, null, 2),
      'utf8'
    );

    await imessageCommand('lookup', '--name', 'Alex', '--max-age-minutes', '999999', '--json');
    assert.strictEqual(exits.length, 0);
    const jsonOutput = JSON.parse(stdout.join('\n'));
    assert.strictEqual(jsonOutput.ok, true);
    assert.strictEqual(jsonOutput.match_count, 2);
    assert.strictEqual(jsonOutput.unique, false);
    assert.strictEqual(jsonOutput.ambiguous, true);
    assert.strictEqual(jsonOutput.primary, null);
    assert.strictEqual(jsonOutput.matches.length, 2);

    // Verify plain text output format lists multiple matches
    stdout.length = 0;
    await imessageCommand('lookup', '--name', 'Alex', '--max-age-minutes', '999999');
    assert.match(stdout[0], /Multiple matches for "Alex":/);
    assert.ok(stdout.some((line) => line.includes('Alex Rivera: +15551112222')));
    assert.ok(stdout.some((line) => line.includes('Alex Chen: +15553334444')));
  });
});

test('imessage send and lookup exit cleanly with usage errors when inputs are invalid (error case)', async () => {
  await withTempEnv(async ({ stdout, stderr, exits }) => {
    // 1. send without --approved
    await assert.rejects(
      async () => {
        await imessageCommand('send', '--to', '+15551234567', '--text', 'hello world', '--json');
      },
      (err) => err.message === '__exit__:1'
    );
    assert.strictEqual(exits[0], 1);
    const sendPayload = JSON.parse(stdout.join('\n'));
    assert.strictEqual(sendPayload.ok, false);
    assert.strictEqual(sendPayload.action, 'imessage_send');
    assert.strictEqual(sendPayload.approved, false);
    assert.match(sendPayload.error, /Refusing to send without --approved/);

    // 2. lookup without --name
    stdout.length = 0;
    exits.length = 0;
    await assert.rejects(
      async () => {
        await imessageCommand('lookup', '--json');
      },
      (err) => err.message === '__exit__:1'
    );
    assert.strictEqual(exits[0], 1);
    const lookupPayload = JSON.parse(stdout.join('\n'));
    assert.strictEqual(lookupPayload.ok, false);
    assert.strictEqual(lookupPayload.action, 'imessage_lookup');
    assert.match(lookupPayload.error, /Usage: atris imessage lookup/);

    // 3. recent without handle
    exits.length = 0;
    await assert.rejects(
      async () => {
        await imessageCommand('recent');
      },
      (err) => err.message === '__exit__:1'
    );
    assert.strictEqual(exits[0], 1);
    assert.ok(stderr.some((line) => line.includes('Usage: atris imessage recent')));
  });
});
