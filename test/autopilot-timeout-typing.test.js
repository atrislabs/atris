const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { isPhaseTimeoutError, isPhaseKillError, executePhaseDetailed, lessonSlug } = require('../commands/autopilot');

// T31 (RSI audit, endgame atris2-chat-reliable-everywhere): execSync timeout
// errors carry `code: 'ETIMEDOUT'` / `signal`, never `killed` — the old
// `if (err.killed)` guard was dead code and the raw `spawnSync /bin/sh
// ETIMEDOUT` message leaked to the halt handler 13 times in one endgame.

test('isPhaseTimeoutError types the real execSync ETIMEDOUT shape', () => {
  assert.strictEqual(isPhaseTimeoutError({ code: 'ETIMEDOUT' }), true);
  assert.strictEqual(isPhaseTimeoutError({ code: 'ETIMEDOUT', signal: 'SIGTERM' }), true);
  // a bare signal is an OOM/external kill, not the timeout wall (CLI-231)
  assert.strictEqual(isPhaseTimeoutError({ signal: 'SIGKILL' }), false);
  assert.strictEqual(isPhaseTimeoutError({ killed: true }), false);
  assert.strictEqual(isPhaseTimeoutError(new Error('Command failed: exit 1')), false);
  assert.strictEqual(isPhaseTimeoutError({ code: 1 }), false);
  assert.strictEqual(isPhaseTimeoutError(null), false);
});

test('isPhaseKillError casts the wider net for the group sweep', () => {
  assert.strictEqual(isPhaseKillError({ code: 'ETIMEDOUT' }), true);
  assert.strictEqual(isPhaseKillError({ signal: 'SIGKILL' }), true);
  assert.strictEqual(isPhaseKillError({ killed: true }), true);
  assert.strictEqual(isPhaseKillError({ code: 1 }), false);
  assert.strictEqual(isPhaseKillError(null), false);
});

test('a signal kill throws a kill message, never "timed out"', () => {
  // sh kills its own child with SIGKILL before the 5s wall: signal, no ETIMEDOUT
  let thrown;
  try {
    executePhaseDetailed(
      'do',
      { task: 'fixture', kind: 'endgame' },
      { verbose: false, timeout: 5000, cmdOverride: 'sh -c "kill -KILL $$"' }
    );
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected the signal kill to throw');
  assert.match(thrown.message, /^do phase killed by SIGKILL/);
  assert.doesNotMatch(thrown.message, /timed out/);
});

test('forced phase timeout throws the named phase message, not raw spawnSync', () => {
  // Drive the real executePhaseDetailed catch path: a command that outlives
  // the wall. cmdOverride keeps the test off the network/claude binary.
  let thrown;
  try {
    executePhaseDetailed(
      'do',
      { task: 'fixture', kind: 'endgame' },
      { verbose: false, timeout: 300, cmdOverride: 'sleep 5' }
    );
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected the forced timeout to throw');
  assert.match(thrown.message, /^do phase timed out after 0\.3s/);
  assert.doesNotMatch(thrown.message, /spawnSync|ETIMEDOUT/);
});

// T32 (endgame loop-self-repair): execSync's timeout kills only the /bin/sh
// wrapper pid — claude grandchildren kept running 160–296s past the 600s wall.
// The fix pairs `detached: true` (wrapper becomes group leader) with a
// `process.kill(-pid, 'SIGKILL')` group sweep in the timeout catch.
test('phase timeout kills the whole process group, not just the shell', () => {
  const pidFile = path.join(os.tmpdir(), `autopilot-grandchild-${process.pid}.pid`);
  try { fs.unlinkSync(pidFile); } catch {}

  // The grandchild (`sleep 30`) records its pid before the 500ms wall hits.
  let thrown;
  try {
    executePhaseDetailed(
      'do',
      { task: 'fixture', kind: 'endgame' },
      {
        verbose: false,
        timeout: 500,
        cmdOverride: `sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`
      }
    );
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected the forced timeout to throw');
  assert.match(thrown.message, /^do phase timed out after 0\.5s/, 'T31 named-message contract must survive the sweep');

  const grandchildPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'grandchild pid was not recorded');

  // The "gap closes" proof: signal 0 must throw ESRCH — the grandchild died
  // with the group instead of outliving the wall. Allow a short reap window.
  const deadline = Date.now() + 2000;
  let dead = false;
  while (Date.now() < deadline) {
    try {
      process.kill(grandchildPid, 0);
    } catch (err) {
      assert.strictEqual(err.code, 'ESRCH');
      dead = true;
      break;
    }
    execSync('sleep 0.05');
  }
  try { fs.unlinkSync(pidFile); } catch {}
  assert.ok(dead, `grandchild ${grandchildPid} survived the phase timeout — process group was not swept`);
});

test('non-timeout failure with stdout still returns partial output', () => {
  const result = executePhaseDetailed(
    'do',
    { task: 'fixture', kind: 'endgame' },
    { verbose: false, timeout: 5000, cmdOverride: 'echo partial; exit 1' }
  );
  assert.match(result.output, /partial/);
});

// Slug mangling: em-dashes leaked verbatim and `.slice(0, 40)` cut mid-word,
// e.g. `verify-fail-per-member-model-selection-—-the-member-`.
test('lessonSlug strips em-dashes and truncates at a word boundary', () => {
  const slug = lessonSlug('Per-member model selection — the member definition carries its model');
  assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `slug "${slug}" must be clean kebab-case`);
  assert.ok(slug.length <= 40);
  assert.ok(!slug.endsWith('-'));
  assert.strictEqual(slug, 'per-member-model-selection-the-member');
});

test('lessonSlug keeps short titles intact and survives degenerate input', () => {
  assert.strictEqual(lessonSlug('Fix the parser'), 'fix-the-parser');
  assert.strictEqual(lessonSlug(''), 'unknown');
  assert.strictEqual(lessonSlug('———'), 'unknown');
  assert.strictEqual(lessonSlug(undefined), 'unknown');
});
