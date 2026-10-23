'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runVerifyCommandCached } = require('../lib/auto-accept-certified');

// Each check here spawns a real child process, so every fixture is a tiny
// script inside a fresh temp workspace. Both scripts log one line to runs.log,
// which lets a test count how many times the verify really ran.
const ATRIS_ENV_KEYS = ['ATRIS_VERIFY_IN_PROGRESS', 'ATRIS_VERIFY_SPAWN_CAP', 'ATRIS_VERIFY_TIMEOUT_MS'];

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-cached-'));
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  const logLine = "require('fs').appendFileSync(require('path').join(__dirname, '..', 'runs.log'), '%s\\n');\n";
  fs.writeFileSync(path.join(scripts, 'pass.js'), logLine.replace('%s', 'pass') + 'process.exit(0);\n');
  fs.writeFileSync(path.join(scripts, 'fail.js'), logLine.replace('%s', 'fail') + "console.error('boom');\nprocess.exit(3);\n");
  return root;
}

function runCount(root) {
  const log = path.join(root, 'runs.log');
  if (!fs.existsSync(log)) return 0;
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
}

// Runs fn with the ATRIS_* knobs cleared and returns the temp roots it made to
// the caller's cleanup. Env is restored and roots are removed even if fn throws.
function withWorkspaces(fn) {
  const saved = {};
  for (const key of ATRIS_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const roots = [];
  const makeRoot = () => {
    const root = makeWorkspace();
    roots.push(root);
    return root;
  };
  try {
    return fn({ makeRoot });
  } finally {
    for (const key of ATRIS_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a passing verify runs once, then a repeat with the same cache is reused', () => withWorkspaces(({ makeRoot }) => {
  const root = makeRoot();
  const cache = new Map();

  const first = runVerifyCommandCached('node scripts/pass.js', root, cache);
  assert.deepStrictEqual(
    { ok: first.ok, reason: first.reason, status: first.status, stderr: first.stderr, reused: first.reused },
    { ok: true, reason: 'verify_passed', status: 0, stderr: '', reused: false },
  );

  const second = runVerifyCommandCached('node scripts/pass.js', root, cache);
  assert.deepStrictEqual(
    { ok: second.ok, reason: second.reason, status: second.status, reused: second.reused },
    { ok: true, reason: 'verify_passed', status: 0, reused: true },
  );

  assert.strictEqual(runCount(root), 1, 'the second call must not spawn the verify again');
  assert.strictEqual(cache.size, 1);
}));

test('a failing verify reports its exit status and the failure is cached too', () => withWorkspaces(({ makeRoot }) => {
  const root = makeRoot();
  const cache = new Map();

  const first = runVerifyCommandCached('node scripts/fail.js', root, cache);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.reason, 'verify_failed');
  assert.strictEqual(first.status, 3);
  assert.match(first.stderr, /boom/);
  assert.strictEqual(first.reused, false);

  const second = runVerifyCommandCached('node scripts/fail.js', root, cache);
  assert.strictEqual(second.reason, 'verify_failed');
  assert.strictEqual(second.status, 3);
  assert.strictEqual(second.reused, true);
  assert.strictEqual(runCount(root), 1);
}));

test('the cache key ignores surrounding whitespace in the command', () => withWorkspaces(({ makeRoot }) => {
  const root = makeRoot();
  const cache = new Map();

  runVerifyCommandCached('node scripts/pass.js', root, cache);
  const padded = runVerifyCommandCached('   node scripts/pass.js  \n', root, cache);

  assert.strictEqual(padded.reused, true);
  assert.strictEqual(padded.ok, true);
  assert.strictEqual(runCount(root), 1);
  assert.strictEqual(cache.size, 1);
}));

test('the same command in a different workspace root is a separate cache entry', () => withWorkspaces(({ makeRoot }) => {
  const rootA = makeRoot();
  const rootB = makeRoot();
  const cache = new Map();

  const inA = runVerifyCommandCached('node scripts/pass.js', rootA, cache);
  const inB = runVerifyCommandCached('node scripts/pass.js', rootB, cache);

  assert.strictEqual(inA.reused, false);
  assert.strictEqual(inB.reused, false);
  assert.strictEqual(runCount(rootA), 1);
  assert.strictEqual(runCount(rootB), 1);
  assert.strictEqual(cache.size, 2);
}));

test('without a cache map, every call runs the verify and no reused flag is set', () => withWorkspaces(({ makeRoot }) => {
  const root = makeRoot();

  const first = runVerifyCommandCached('node scripts/pass.js', root);
  const second = runVerifyCommandCached('node scripts/pass.js', root);

  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.strictEqual('reused' in first, false);
  assert.strictEqual('reused' in second, false);
  assert.strictEqual(runCount(root), 2);
}));

test('an empty command is refused without spawning, and the refusal is cached', () => withWorkspaces(({ makeRoot }) => {
  const root = makeRoot();
  const cache = new Map();

  const first = runVerifyCommandCached('   ', root, cache);
  assert.deepStrictEqual(
    { ok: first.ok, reason: first.reason, reused: first.reused },
    { ok: false, reason: 'no_verify_command', reused: false },
  );

  const second = runVerifyCommandCached('   ', root, cache);
  assert.deepStrictEqual(
    { ok: second.ok, reason: second.reason, reused: second.reused },
    { ok: false, reason: 'no_verify_command', reused: true },
  );
  assert.strictEqual(runCount(root), 0);
}));

test('a command outside the verify allowlist is refused and never runs', () => withWorkspaces(({ makeRoot }) => {
  const root = makeRoot();
  const cache = new Map();

  const result = runVerifyCommandCached('rm scripts/pass.js', root, cache);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'verify_command_not_allowed');
  assert.strictEqual(result.reused, false);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'pass.js')), 'the refused command must not delete anything');
  assert.strictEqual(runCount(root), 0);
}));

test('a verify chain stops at the first failing step and names it', () => withWorkspaces(({ makeRoot }) => {
  const root = makeRoot();

  const result = runVerifyCommandCached('node scripts/fail.js && node scripts/pass.js', root, new Map());

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'verify_failed');
  assert.strictEqual(result.failed_step, 'node scripts/fail.js');
  assert.strictEqual(runCount(root), 1, 'the step after the failure must not run');
}));

test('a verify started inside another verify is refused as re-entrant without spawning', () => withWorkspaces(({ makeRoot }) => {
  const root = makeRoot();
  process.env.ATRIS_VERIFY_IN_PROGRESS = '1';

  const result = runVerifyCommandCached('node scripts/pass.js', root, new Map());

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'verify_unrunnable');
  assert.strictEqual(result.unrunnable_cause, 'verify_reentrant');
  assert.strictEqual(result.alarm, true);
  assert.strictEqual(runCount(root), 0);
}));
