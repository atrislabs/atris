'use strict';

// shellInit prints the zsh/bash snippet users eval from their rc file so each
// terminal tab can keep its own Atris account. It has no inputs, so these tests
// pin the printed text: the pieces the shell depends on must stay in it.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-shell-init-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
for (const key of ['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'TMUX_PANE', 'WT_SESSION', 'WEZTERM_PANE']) {
  delete process.env[key];
}

const { shellInit } = require('../commands/auth');

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function captureShellInit(...args) {
  const calls = [];
  const original = console.log;
  console.log = (...logged) => { calls.push(logged); };
  let returned;
  try {
    returned = shellInit(...args);
  } finally {
    console.log = original;
  }
  return { calls, returned };
}

function snippet() {
  const { calls } = captureShellInit();
  assert.equal(calls.length, 1);
  return calls[0][0];
}

function count(text, re) {
  return (text.match(re) || []).length;
}

test('prints one string and returns nothing, so eval "$(atris shell-init)" gets the whole snippet', () => {
  const { calls, returned } = captureShellInit();
  assert.equal(returned, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(typeof calls[0][0], 'string');
  assert.ok(calls[0][0].startsWith('# Atris per-terminal account switching\n'));
  assert.ok(calls[0][0].endsWith('\n}'));
});

test('defines the session-id helper and the atris wrapper function', () => {
  const out = snippet();
  const lines = out.split('\n');
  assert.equal(count(out, /^_atris_session_id\(\) \{$/gm), 1);
  assert.equal(count(out, /^atris\(\) \{$/gm), 1);
  assert.ok(lines.indexOf('_atris_session_id() {') < lines.indexOf('atris() {'));
  // Each function closes at column zero.
  assert.equal(count(out, /^\}$/gm), 2);
});

test('switch with a name resolves, exports ATRIS_PROFILE, and switches the session', () => {
  const out = snippet();
  assert.ok(out.includes('if [[ "$1" == "switch" && -n "$2" && "$2" != "-"* ]]; then'));
  assert.ok(out.includes('_profile=$(command atris _resolve "$2" 2>/dev/null)'));
  assert.ok(out.includes('export ATRIS_PROFILE="$_profile"'));
  assert.ok(out.includes('command atris _switch-session "$_profile" --session-id "$_sid" 2>/dev/null'));
  assert.ok(out.includes('command atris _activate "$_profile" 2>/dev/null'));
  assert.ok(out.includes('_email=$(command atris _profile-email "$_profile" 2>/dev/null)'));
  assert.ok(out.includes('echo "Switched to ${_email:-$_profile}"'));
});

test('switch with no name lists accounts and prompts, and every other command passes straight through', () => {
  const out = snippet();
  assert.ok(out.includes('elif [[ "$1" == "switch" && $# -eq 1 ]]; then'));
  assert.ok(out.includes('printf "Switch to: "'));
  assert.ok(out.includes('read _pick'));
  assert.ok(out.includes('_profile=$(command atris _resolve "$_pick" 2>/dev/null)'));
  // The final else hands everything else to the real binary untouched.
  const lines = out.split('\n');
  const tail = lines.slice(-4);
  assert.deepEqual(tail, [
    '  else',
    '    command atris "$@"',
    '  fi',
    '}',
  ]);
});

test('an unknown account name prints a plain message with the name in single quotes', () => {
  const out = snippet();
  assert.ok(out.includes(`echo "No account matching '$2'."`));
  assert.ok(out.includes(`echo "No account matching '$_pick'."`));
  // The one-argument form falls back to listing accounts; the prompt form does not.
  assert.equal(count(out, /command atris accounts/g), 2);
  // JS escapes must not leak into the shell text.
  assert.equal(out.includes('\\'), false);
});

test('terminal id lookup checks the same variables, in the same order, as utils/auth.js', () => {
  const out = snippet();
  const order = ['TERM_SESSION_ID', 'ITERM_SESSION_ID', 'TMUX_PANE', 'WT_SESSION', 'WEZTERM_PANE'];
  const line = out.split('\n').find((l) => l.includes('local _sid="'));
  assert.ok(line, 'expected the _sid assignment line');
  const positions = order.map((name) => line.indexOf(name));
  assert.ok(positions.every((p) => p >= 0), `missing a variable in: ${line}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);

  const authSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'auth.js'), 'utf8');
  const authPositions = order.map((name) => authSource.indexOf(`process.env.${name}`));
  assert.ok(authPositions.every((p) => p >= 0));
  assert.deepEqual([...authPositions].sort((a, b) => a - b), authPositions);

  // With none of them set, the shell falls back to the tty device.
  assert.ok(out.includes('_tty=$(tty 2>/dev/null)'));
  assert.ok(out.includes('"$_tty" == /dev/*'));
});

test('every hidden command the snippet calls is handled by bin/atris.js', () => {
  const out = snippet();
  const called = new Set();
  for (const m of out.matchAll(/command atris (_[a-z-]+)/g)) called.add(m[1]);
  assert.deepEqual([...called].sort(), ['_activate', '_profile-email', '_resolve', '_switch-session']);

  const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'atris.js'), 'utf8');
  for (const name of called) {
    assert.ok(bin.includes(`command === '${name}'`), `bin/atris.js has no handler for ${name}`);
  }
  assert.ok(bin.includes("command === 'shell-init'"));
});

test('the shell text is balanced: braces match and every if has a fi', () => {
  const out = snippet();
  const code = out.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.equal(count(code, /\{/g), count(code, /\}/g));
  assert.equal(count(code, /\bif\b/g), count(code, /\bfi\b/g));
  assert.equal(count(code, /\bthen\b/g), count(code, /\bif\b|\belif\b/g));
  assert.equal(count(code, /"/g) % 2, 0);
});

test('output is the same on every call and ignores any arguments passed in', () => {
  const first = snippet();
  const second = snippet();
  assert.equal(first, second);

  const { calls } = captureShellInit('--bogus', null, { switch: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], first);
});

test('printing the snippet writes nothing under HOME and has no stray text', () => {
  const out = snippet();
  assert.deepEqual(fs.readdirSync(tmpHome), []);
  assert.equal(out.includes('undefined'), false);
  assert.equal(out.includes('[object'), false);
  assert.equal(out.includes('\t'), false);
  assert.equal(out.includes('\r'), false);
  assert.equal(out.split('\n').some((l) => l !== l.trimEnd()), false);
});
