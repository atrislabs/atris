const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { askAtris } = require('../commands/ask');

async function captureHelp(t, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ask-command-'));
  const overrides = {
    HOME: home,
    ATRIS_AGENT_TOKEN_FILE: path.join(home, 'agent-token.json'),
    ATRIS_PROFILE: '',
    TERM_SESSION_ID: 'ask-command-test',
    // Scoped tokens are checked locally, so help needs no authentication request.
    ATRIS_TOKEN: `test.${Buffer.from(JSON.stringify({
      type: 'agent_access',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url')}.test`,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const lines = [];
  const log = t.mock.method(console, 'log', (...values) => lines.push(values.join(' ')));
  const guards = ['node:http', 'node:https'].map(name =>
    t.mock.method(require(name), 'request', () => {
      assert.fail('help must not make a network request');
    }));
  const exit = t.mock.method(process, 'exit', code => {
    assert.fail(`help must not exit the process (${code})`);
  });
  try {
    Object.assign(process.env, overrides);
    const result = await askAtris(args);
    assert.strictEqual(result, undefined);
    return lines;
  } finally {
    log.mock.restore();
    exit.mock.restore();
    for (const guard of guards) guard.mock.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const expectedHelp = [
  'Usage: atris ask ["message"]',
  '',
  '  Chat with your personal Atris computer: memory, calendar, email, tools.',
  '',
  '  atris ask                      Interactive chat',
  '  atris ask what is on today     One-shot question',
];

test('ask prints complete usage for each help alias', async t => {
  for (const alias of ['-h', '--help', 'help']) {
    assert.deepStrictEqual(await captureHelp(t, [alias]), expectedHelp, alias);
  }
});

test('ask joins and trims arguments before recognizing help', async t => {
  assert.deepStrictEqual(await captureHelp(t, ['', '  --help  ', '']), expectedHelp);
  assert.deepStrictEqual(await captureHelp(t, ['  help\n']), expectedHelp);
});
