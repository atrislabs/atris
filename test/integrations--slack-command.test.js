'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The module reads HOME at load time and several ATRIS_* variables when it
// talks to the backend. Point HOME at a throwaway folder and clear them
// before the require so nothing on this machine leaks in.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-slack-command-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { slackCommand } = require('../commands/integrations');

test.after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

// Runs slackCommand with console and process.exit captured. Only paths that
// finish before any login or network call are exercised here.
async function run(...args) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  let exitCode = null;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  process.exit = (code) => {
    throw new ExitSignal(code);
  };
  try {
    await slackCommand(...args);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    exitCode = e.code;
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
  }
  return { out, err, exitCode };
}

const HELP_LINES = [
  'Slack commands:',
  '  atris slack channels             - List Slack channels',
  '  atris slack dms                  - List Slack DMs',
  '  atris slack messages <channel>   - Read recent messages',
  '  atris slack search <query>       - Search Slack messages',
  '  atris slack send <channel> "<message>" --approved - Send a message as you',
  '  atris slack dm <user_id> "<message>" --approved   - DM someone as you',
];

test('no subcommand prints the help list and exits cleanly', async () => {
  const { out, err, exitCode } = await run();
  assert.deepStrictEqual(out, HELP_LINES);
  assert.deepStrictEqual(err, []);
  assert.strictEqual(exitCode, null);
});

test('an unknown subcommand prints the same help list', async () => {
  const { out, err, exitCode } = await run('nonsense', 'extra', 'args');
  assert.deepStrictEqual(out, HELP_LINES);
  assert.deepStrictEqual(err, []);
  assert.strictEqual(exitCode, null);
});

test('messages and its read alias refuse a missing channel with exit 1', async () => {
  for (const verb of ['messages', 'read']) {
    const { out, err, exitCode } = await run(verb);
    assert.strictEqual(exitCode, 1, `${verb} exit code`);
    assert.deepStrictEqual(err, ['Usage: atris slack messages <channel-or-id> [--limit 20]']);
    assert.deepStrictEqual(out, []);
  }
});

test('messages treats an empty channel string like a missing one', async () => {
  const { out, err, exitCode } = await run('messages', '');
  assert.strictEqual(exitCode, 1);
  assert.strictEqual(err.length, 1);
  assert.match(err[0], /^Usage: atris slack messages /);
  assert.deepStrictEqual(out, []);
});

test('search refuses an empty query, including when only a limit is given', async () => {
  const cases = [[], ['--limit', '5'], ['-n', '10']];
  for (const args of cases) {
    const { out, err, exitCode } = await run('search', ...args);
    assert.strictEqual(exitCode, 1, `search ${args.join(' ')}`);
    assert.deepStrictEqual(err, ['Usage: atris slack search <query> [--limit 20]']);
    assert.deepStrictEqual(out, []);
  }
});

test('send refuses to go out without --approved and exits 2', async () => {
  const { out, err, exitCode } = await run('send', 'general', 'hello', 'team');
  assert.strictEqual(exitCode, 2);
  assert.deepStrictEqual(err, [
    'Refusing to send without --approved after the exact channel and exact text are confirmed.',
    'Usage: atris slack send <channel> "<message>" --approved',
  ]);
  assert.deepStrictEqual(out, []);
});

test('dm refuses to go out without --approved and exits 2', async () => {
  const { out, err, exitCode } = await run('dm', 'U123ABC', 'hello');
  assert.strictEqual(exitCode, 2);
  assert.deepStrictEqual(err, [
    'Refusing to send without --approved after the exact recipient and exact text are confirmed.',
    'Usage: atris slack dm <slack_user_id> "<message>" --approved',
  ]);
  assert.deepStrictEqual(out, []);
});

test('send and dm with no arguments at all still hit the approval refusal first', async () => {
  const send = await run('send');
  const dm = await run('dm');
  assert.strictEqual(send.exitCode, 2);
  assert.strictEqual(dm.exitCode, 2);
  assert.match(send.err[0], /^Refusing to send without --approved/);
  assert.match(dm.err[0], /^Refusing to send without --approved/);
});
