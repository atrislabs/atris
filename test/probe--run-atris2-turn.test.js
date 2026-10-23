'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAtris2Turn } = require('../commands/probe');

// Every path below stops before a socket opens: either no login is found, or
// the API base URL is not a URL, so `new URL(...)` throws inside the request
// promise. Nothing here touches the network or a clock.
const BAD_API_URL = 'not a url';
const TERMINAL_ID_VARS = ['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'TMUX_PANE', 'WT_SESSION', 'WEZTERM_PANE'];

// Run fn with HOME pointed at a fresh temp dir and every ATRIS_* var cleared,
// then put the environment back exactly as it was.
async function withIsolatedHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-run-atris2-turn-'));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  for (const key of TERMINAL_ID_VARS) delete process.env[key];
  process.env.HOME = home;
  // a fixed terminal id keeps the session lookup from shelling out to `tty`
  process.env.TERM_SESSION_ID = 'probe-run-atris2-turn-test';
  try {
    return await fn(home);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeCredentials(home, credentials) {
  const dir = path.join(home, '.atris');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(credentials));
}

test('runAtris2Turn: no login returns the not-logged-in result with an empty shape', async () => {
  await withIsolatedHome(async () => {
    const out = await runAtris2Turn({ prompt: 'hello' });
    const { duration_ms: durationMs, ...rest } = out;
    assert.deepStrictEqual(rest, {
      ok: false,
      text: '',
      engine: null,
      tools_run: 0,
      cli_ops: [],
      unsupported: [],
      error: 'not-logged-in',
    });
    assert.ok(Number.isInteger(durationMs));
  });
});

test('runAtris2Turn: called with no options at all still resolves to not-logged-in', async () => {
  await withIsolatedHome(async () => {
    const out = await runAtris2Turn();
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'not-logged-in');
    assert.strictEqual(out.tools_run, 0);
  });
});

test('runAtris2Turn: a blank ATRIS_TOKEN does not count as a login', async () => {
  await withIsolatedHome(async () => {
    process.env.ATRIS_TOKEN = '   ';
    const out = await runAtris2Turn({ prompt: 'hello' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'not-logged-in');
  });
});

test('runAtris2Turn: a credentials file with an empty token is not-logged-in', async () => {
  await withIsolatedHome(async (home) => {
    writeCredentials(home, { token: '', email: 'nobody@example.com' });
    const out = await runAtris2Turn({ prompt: 'hello' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'not-logged-in');
    assert.strictEqual(out.text, '');
  });
});

test('runAtris2Turn: a token from ATRIS_TOKEN gets past login and fails on a bad API URL', async () => {
  await withIsolatedHome(async () => {
    process.env.ATRIS_TOKEN = 'test-token-not-real';
    process.env.ATRIS_API_URL = BAD_API_URL;
    const out = await runAtris2Turn({ prompt: 'hello', business: 'biz-123', memberSlug: 'relay' });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /^TypeError: .*Invalid URL/);
    assert.notStrictEqual(out.error, 'not-logged-in');
    assert.strictEqual(out.text, '');
    assert.strictEqual(out.engine, null);
    assert.strictEqual(out.tools_run, 0);
    assert.deepStrictEqual(out.cli_ops, []);
    assert.deepStrictEqual(out.unsupported, []);
    assert.ok(Number.isInteger(out.duration_ms));
  });
});

test('runAtris2Turn: a token from the credentials file also gets past login', async () => {
  await withIsolatedHome(async (home) => {
    writeCredentials(home, { token: 'file-token-not-real', email: 'nobody@example.com' });
    process.env.ATRIS_API_URL = BAD_API_URL;
    const out = await runAtris2Turn({ prompt: 'hello' });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /Invalid URL/);
    assert.notStrictEqual(out.error, 'not-logged-in');
  });
});
