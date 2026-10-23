const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point home at a throwaway folder before the command module reads it, and
// drop account env so a login on this machine cannot leak into the run.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-twitter-command-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { twitterCommand } = require('../commands/integrations');

const HELP_LINES = [
  'Twitter commands:',
  '  atris twitter post "<text>" --approved  - Post a tweet',
];

const REFUSAL_LINES = [
  'Refusing to post without --approved after the exact text is confirmed.',
  'Usage: atris twitter post "<text>" --approved',
];

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// process.exit would stop the runner. Throw instead, and keep the code.
async function capture(fn) {
  const stdout = [];
  const stderr = [];
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exit;
  let exitCode = null;
  console.log = (...args) => { stdout.push(args.join(' ')); };
  console.error = (...args) => { stderr.push(args.join(' ')); };
  process.exit = (code) => {
    exitCode = code === undefined ? 0 : code;
    const error = new Error(`process.exit:${exitCode}`);
    error.exitCode = exitCode;
    throw error;
  };
  try {
    await fn();
  } catch (error) {
    if (!error || error.exitCode === undefined) throw error;
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
  }
  return { exitCode, stdout, stderr };
}

test('no subcommand prints the twitter command list and does not exit', async () => {
  const result = await capture(() => twitterCommand());
  assert.strictEqual(result.exitCode, null);
  assert.deepStrictEqual(result.stdout, HELP_LINES);
  assert.deepStrictEqual(result.stderr, []);
});

test('empty, unknown, and wrong-case names print help; a lookalike flag still refuses', async () => {
  for (const subcommand of ['', 'help', 'POST']) {
    const result = await capture(() => twitterCommand(subcommand, '--json'));
    assert.strictEqual(result.exitCode, null, subcommand);
    assert.deepStrictEqual(result.stdout, HELP_LINES, subcommand);
    assert.deepStrictEqual(result.stderr, [], subcommand);
  }

  const lookalike = await capture(() => twitterCommand('post', 'shipped the fix --approved'));
  assert.strictEqual(lookalike.exitCode, 2);
  assert.deepStrictEqual(lookalike.stdout, []);
  assert.deepStrictEqual(lookalike.stderr, REFUSAL_LINES);
});

test('post and tweet refuse when approval is missing, including an empty post', async () => {
  const posted = await capture(() => twitterCommand('post', 'shipped the fix'));
  assert.strictEqual(posted.exitCode, 2);
  assert.deepStrictEqual(posted.stdout, []);
  assert.deepStrictEqual(posted.stderr, REFUSAL_LINES);

  const tweet = await capture(() => twitterCommand('tweet', 'shipped the fix'));
  assert.strictEqual(tweet.exitCode, 2);
  assert.deepStrictEqual(tweet.stdout, []);
  assert.deepStrictEqual(tweet.stderr, REFUSAL_LINES);

  const empty = await capture(() => twitterCommand('post'));
  assert.strictEqual(empty.exitCode, 2);
  assert.deepStrictEqual(empty.stdout, []);
  assert.deepStrictEqual(empty.stderr, REFUSAL_LINES);
});
