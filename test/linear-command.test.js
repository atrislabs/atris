const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { linearCommand } = require('../commands/linear');

const posix = process.platform !== 'win32';

let tmpRoot;
let emptyBin;
let fakeBin;
let logFile;
const savedEnv = {};
const ENV_KEYS = ['HOME', 'PATH', 'LINEAR_FAKE_LOG', 'LINEAR_FAKE_AUTH_EXIT', 'LINEAR_FAKE_EXIT'];

function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function capture(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  let code;
  try {
    code = fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function readLog() {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-linear-test-'));
  emptyBin = path.join(tmpRoot, 'empty-bin');
  fakeBin = path.join(tmpRoot, 'fake-bin');
  fs.mkdirSync(emptyBin);
  fs.mkdirSync(fakeBin);
  logFile = path.join(tmpRoot, 'linear-calls.log');

  // A stand-in `linear` that only records its arguments and exits.
  const script = [
    '#!/bin/sh',
    'echo "$*" >> "$LINEAR_FAKE_LOG"',
    'if [ "$1" = "--version" ]; then echo "linear 9.8.7"; exit 0; fi',
    'if [ "$1" = "auth" ]; then exit "${LINEAR_FAKE_AUTH_EXIT:-0}"; fi',
    'exit "${LINEAR_FAKE_EXIT:-0}"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(fakeBin, 'linear'), script, { mode: 0o755 });

  process.env.HOME = tmpRoot;
  process.env.LINEAR_FAKE_LOG = logFile;
});

after(() => {
  for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('exports linearCommand as a function', () => {
  assert.strictEqual(typeof linearCommand, 'function');
});

test('no args prints help with usage, every subcommand, binary and install hint', () => {
  const { code, out, err } = capture(() => linearCommand([]));
  assert.strictEqual(code, 0);
  assert.strictEqual(err, '');
  assert.match(out, /usage: atris linear <command> \[args\]/);
  assert.match(out, /doctor\s+detect the cli binary and auth state/);
  assert.match(out, /auth\s+check auth state/);
  assert.match(out, /issue list\s+list issues/);
  assert.match(out, /issue create\s+create an issue/);
  assert.match(out, /issue view\s+show issue details/);
  assert.match(out, /issue update\s+update an issue/);
  assert.match(out, /binary: linear/);
  assert.match(out, /install: install the linear cli and ensure `linear` is on PATH/);
  assert.doesNotMatch(out, /--raw/);
});

test('--help, -h and help all print help and never touch the binary', () => {
  // empty PATH: if help tried to spawn `linear` this would report a missing binary
  setEnv('PATH', emptyBin);
  const baseline = capture(() => linearCommand([])).out;
  for (const flag of [['--help'], ['-h'], ['help'], ['issue', 'list', '--help']]) {
    const { code, out, err } = capture(() => linearCommand(flag));
    assert.strictEqual(code, 0, `exit code for ${flag.join(' ')}`);
    assert.strictEqual(err, '', `stderr for ${flag.join(' ')}`);
    assert.strictEqual(out, baseline, `output for ${flag.join(' ')}`);
  }
});

test('accepts bare string arguments instead of an array', () => {
  const { code, out } = capture(() => linearCommand('--help'));
  assert.strictEqual(code, 0);
  assert.match(out, /usage: atris linear <command> \[args\]/);
});

test('unknown subcommands exit 1 and point back at help', () => {
  setEnv('PATH', emptyBin);
  for (const args of [['issue', 'delete', 'ENG-1'], ['issue'], ['project', 'list'], ['list']]) {
    const { code, out, err } = capture(() => linearCommand(args));
    assert.strictEqual(code, 1, args.join(' '));
    assert.strictEqual(out, '');
    assert.ok(err.includes(`unknown linear command: ${args.join(' ')}`), err);
    assert.ok(err.includes('run: atris linear --help'), err);
  }
});

test('missing linear binary: doctor, status, auth and passthrough all fail with the install hint', () => {
  setEnv('PATH', emptyBin);
  for (const args of [['doctor'], ['status'], ['auth'], ['issue', 'list']]) {
    const { code, out, err } = capture(() => linearCommand(args));
    assert.strictEqual(code, 1, args.join(' '));
    assert.strictEqual(out, '', args.join(' '));
    assert.ok(err.includes('linear cli not found.'), err);
    assert.ok(err.includes('install: install the linear cli and ensure `linear` is on PATH'), err);
  }
});

test('doctor reports binary, lowercased version and auth ok', { skip: !posix }, () => {
  setEnv('PATH', fakeBin);
  setEnv('LINEAR_FAKE_AUTH_EXIT', '0');
  fs.rmSync(logFile, { force: true });

  const { code, out, err } = capture(() => linearCommand(['doctor']));
  assert.strictEqual(code, 0);
  assert.strictEqual(err, '');
  assert.deepStrictEqual(out.split('\n'), [
    'linear integration',
    'binary: found linear',
    'version: linear 9.8.7',
    'auth: ok',
  ]);
  assert.deepStrictEqual(readLog(), ['--version', 'auth status']);
});

test('status is an alias for doctor', { skip: !posix }, () => {
  setEnv('PATH', fakeBin);
  setEnv('LINEAR_FAKE_AUTH_EXIT', '0');
  const doctor = capture(() => linearCommand(['doctor']));
  const status = capture(() => linearCommand(['status']));
  assert.strictEqual(status.code, doctor.code);
  assert.strictEqual(status.out, doctor.out);
});

test('failed auth exits 1 and prints the login hint', { skip: !posix }, () => {
  setEnv('PATH', fakeBin);
  setEnv('LINEAR_FAKE_AUTH_EXIT', '1');

  for (const args of [['doctor'], ['auth']]) {
    const { code, out, err } = capture(() => linearCommand(args));
    assert.strictEqual(code, 1, args.join(' '));
    assert.doesNotMatch(out, /auth: ok/);
    assert.ok(err.includes('auth: failed'), err);
    assert.ok(err.includes('login: linear auth login'), err);
  }
});

test('auth prints ok when the linear cli reports a logged-in session', { skip: !posix }, () => {
  setEnv('PATH', fakeBin);
  setEnv('LINEAR_FAKE_AUTH_EXIT', '0');
  const { code, out, err } = capture(() => linearCommand(['auth']));
  assert.strictEqual(code, 0);
  assert.strictEqual(out, 'auth: ok');
  assert.strictEqual(err, '');
});

test('issue subcommands forward their arguments to the linear cli', { skip: !posix }, () => {
  setEnv('PATH', fakeBin);
  setEnv('LINEAR_FAKE_EXIT', undefined);
  fs.rmSync(logFile, { force: true });

  const cases = [
    [['issue', 'list', '--team', 'ENG'], 'issue list --team ENG'],
    [['issue', 'create', '--title', 'bug'], 'issue create --title bug'],
    [['issue', 'view', 'ENG-12'], 'issue view ENG-12'],
    [['issue', 'update', 'ENG-12', '--state', 'done'], 'issue update ENG-12 --state done'],
  ];
  for (const [args] of cases) {
    const { code } = capture(() => linearCommand(args));
    assert.strictEqual(code, 0, args.join(' '));
  }

  // each passthrough is preceded by the --version probe
  const expected = cases.flatMap(([, forwarded]) => ['--version', forwarded]);
  assert.deepStrictEqual(readLog(), expected);
});

test('passthrough strips --raw and forwards the cli exit code', { skip: !posix }, () => {
  setEnv('PATH', fakeBin);
  setEnv('LINEAR_FAKE_EXIT', '3');
  fs.rmSync(logFile, { force: true });

  const { code, out } = capture(() => linearCommand(['issue', 'view', 'ENG-7', '--raw']));
  assert.strictEqual(code, 3);
  // linear has no summarizer, so no summary text is printed either way
  assert.strictEqual(out, '');
  assert.deepStrictEqual(readLog(), ['--version', 'issue view ENG-7']);
});
