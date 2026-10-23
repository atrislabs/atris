'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { terminalAtris } = require('../commands/terminal');

const SESSION_ENV_VARS = [
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'TMUX_PANE',
  'WT_SESSION',
  'WEZTERM_PANE',
];

function useSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-terminal-test-'));
  const originalCwd = process.cwd();
  const savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_') || SESSION_ENV_VARS.includes(key) || key === 'HOME') {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  process.env.HOME = root;
  process.chdir(root);
  t.after(() => {
    process.chdir(originalCwd);
    delete process.env.HOME;
    for (const [key, value] of Object.entries(savedEnv)) {
      process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

async function runTerminal(args) {
  const stdout = [];
  const stderr = [];
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  let exitCode = null;
  process.argv = ['node', 'atris', 'terminal', ...args];
  process.exit = (code) => { throw new ExitSignal(code === undefined ? 0 : code); };
  console.log = (...parts) => stdout.push(parts.join(' '));
  console.error = (...parts) => stderr.push(parts.join(' '));
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };

  try {
    await terminalAtris();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exitCode = error.code;
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

test('no args prints usage and exits 2', async (t) => {
  useSandbox(t);
  const result = await runTerminal([]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /Usage: atris terminal \[business\] <command> \[--timeout N\]/);
  assert.equal(result.stderr, '');
});

test('--json prints a JSON usage error and exits 2', async (t) => {
  useSandbox(t);
  const result = await runTerminal(['--json']);
  assert.equal(result.exitCode, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.command, 'terminal');
  assert.equal(payload.error, 'usage');
  assert.equal(payload.usage, 'Usage: atris terminal [business] <command> [--timeout N]');
});

test('outside a bound workspace it refuses account-global without --account', async (t) => {
  useSandbox(t);
  const result = await runTerminal(['my-co', 'ls', '/workspace']);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /account-global; pass --account to continue/);
});

test('a lone slug with no command exits 1', async (t) => {
  useSandbox(t);
  const result = await runTerminal(['--account', 'my-co']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Missing command/);
});

test('non-slug input outside a workspace cannot determine the business', async (t) => {
  useSandbox(t);
  const result = await runTerminal(['--account', 'hello world']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Cannot determine business/);
});

test('commands longer than 10000 chars are refused before any network', async (t) => {
  useSandbox(t);
  const result = await runTerminal(['--account', 'my-co', 'x'.repeat(10001)]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Command too long \(10001 chars, max 10000\)/);
});

test('--timeout is stripped before slug detection', async (t) => {
  useSandbox(t);
  // '--timeout 5 ls' reduces to the lone slug 'ls', which is a missing-command
  // error. If the flag pair were not spliced, '--timeout' would fail the slug
  // check and this would read 'Cannot determine business' instead.
  const result = await runTerminal(['--account', '--timeout', '5', 'ls']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Missing command/);
});

test('business slug auto-detects from .atris/business.json in a bound workspace', async (t) => {
  const root = useSandbox(t);
  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ slug: 'detected-co' }));
  fs.mkdirSync(path.join(root, 'atris'));
  // 'echo hello' is not slug-shaped (space), so the slug must come from
  // business.json. Reaching the login check proves auto-detection worked.
  const result = await runTerminal(['echo hello']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Not logged in\. Run: atris login/);
});
