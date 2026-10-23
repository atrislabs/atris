'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ideaAtris } = require('../commands/idea');
const { findToken, savedToken, saveToken, forgetToken } = require('../lib/engine-login');

const TOKEN = `sk-ant-oat01-${'a1B2_c3-'.repeat(8)}`;

function withStateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-login-'));
  const before = process.env.ATRIS_TEST_STATE_DIR;
  process.env.ATRIS_TEST_STATE_DIR = dir;
  t.after(() => {
    if (before === undefined) delete process.env.ATRIS_TEST_STATE_DIR;
    else process.env.ATRIS_TEST_STATE_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function login(deps) {
  const out = [];
  const code = ideaAtris(['login'], { log: (line) => out.push(line), keepDeps: { login: { isTTY: true, ...deps } } });
  return { code, out: out.join('\n') };
}

test('the token is read off a recorded screen, colors and redraws stripped', () => {
  const screen = `\x1b[2J\x1b[1mYour token:\x1b[0m\r\n\x1b[32msk-ant-oat01-old${'x'.repeat(30)}\x1b[0m\r\n\x1b[32m${TOKEN}\x1b[0m\r\nStore this token`;
  assert.equal(findToken(screen), TOKEN);
  assert.equal(findToken('Login cancelled.'), '');
});

test('atris idea login saves a login that signs in, readable only by the owner', (t) => {
  withStateDir(t);
  const checked = [];
  const { code, out } = login({
    recordSetupToken: () => ({ status: 0, text: `token: ${TOKEN}\n` }),
    checkToken: (token) => { checked.push(token); return { ok: true, detail: '' }; },
  });
  assert.equal(code, 0, out);
  assert.deepEqual(checked, [TOKEN]);
  assert.equal(savedToken(), TOKEN);
  const file = path.join(process.env.ATRIS_TEST_STATE_DIR, '.atris', 'secrets', 'claude-oauth-token');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(out, /sealed builds now sign in to Claude on your subscription/);
  assert.doesNotMatch(out, /sk-ant/);
});

test('a login that does not sign in is never saved', (t) => {
  withStateDir(t);
  const { code, out } = login({
    recordSetupToken: () => ({ status: 0, text: TOKEN }),
    checkToken: () => ({ ok: false, detail: 'Invalid API key' }),
  });
  assert.equal(code, 1);
  assert.match(out, /did not sign in: Invalid API key\. nothing saved/);
  assert.equal(savedToken(), '');
});

test('when the screen holds no token, it is pasted once instead', (t) => {
  withStateDir(t);
  const { code } = login({
    recordSetupToken: () => ({ status: 0, text: 'done' }),
    askToken: () => ` ${TOKEN} `,
    checkToken: () => ({ ok: true, detail: '' }),
  });
  assert.equal(code, 0);
  assert.equal(savedToken(), TOKEN);
});

test('login needs a terminal, and logout forgets the saved login', (t) => {
  withStateDir(t);
  const out = [];
  assert.equal(ideaAtris(['login'], { log: (l) => out.push(l), keepDeps: { login: { isTTY: false } } }), 2);
  assert.match(out.join('\n'), /run this in your own terminal: atris idea login/);
  saveToken(TOKEN);
  assert.equal(forgetToken(), true);
  assert.equal(savedToken(), '');
  out.length = 0;
  assert.equal(ideaAtris(['logout'], { log: (l) => out.push(l) }), 0);
  assert.match(out.join('\n'), /there was no saved login/);
});
