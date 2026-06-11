const { test } = require('node:test');
const assert = require('node:assert');

const { isPhaseTimeoutError, executePhaseDetailed, lessonSlug } = require('../commands/autopilot');

// T31 (RSI audit, endgame atris2-chat-reliable-everywhere): execSync timeout
// errors carry `code: 'ETIMEDOUT'` / `signal`, never `killed` — the old
// `if (err.killed)` guard was dead code and the raw `spawnSync /bin/sh
// ETIMEDOUT` message leaked to the halt handler 13 times in one endgame.

test('isPhaseTimeoutError types the real execSync ETIMEDOUT shape', () => {
  assert.strictEqual(isPhaseTimeoutError({ code: 'ETIMEDOUT' }), true);
  assert.strictEqual(isPhaseTimeoutError({ signal: 'SIGTERM' }), true);
  assert.strictEqual(isPhaseTimeoutError({ killed: true }), true);
  assert.strictEqual(isPhaseTimeoutError(new Error('Command failed: exit 1')), false);
  assert.strictEqual(isPhaseTimeoutError({ code: 1 }), false);
  assert.strictEqual(isPhaseTimeoutError(null), false);
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
