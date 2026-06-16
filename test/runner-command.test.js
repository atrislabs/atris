'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  resolveClaudeRunnerModel,
  buildRunnerCommand,
} = require('../lib/runner-command');

function withEnv(value, fn) {
  const prev = process.env.ATRIS_CLAUDE_MODEL;
  if (value === undefined) delete process.env.ATRIS_CLAUDE_MODEL;
  else process.env.ATRIS_CLAUDE_MODEL = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.ATRIS_CLAUDE_MODEL;
    else process.env.ATRIS_CLAUDE_MODEL = prev;
  }
}

// --- resolveClaudeRunnerModel: precedence explicit > env > default alias ---

test('resolveClaudeRunnerModel honors explicit model first', () => {
  withEnv('sonnet', () => {
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-opus-4-8' }), 'claude-opus-4-8');
  });
});

test('resolveClaudeRunnerModel falls back to ATRIS_CLAUDE_MODEL env', () => {
  withEnv('sonnet', () => {
    assert.equal(resolveClaudeRunnerModel({}), 'sonnet');
    assert.equal(resolveClaudeRunnerModel(null), 'sonnet');
  });
});

test('resolveClaudeRunnerModel defaults to the opus alias', () => {
  withEnv(undefined, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'opus');
    assert.equal(resolveClaudeRunnerModel({}), DEFAULT_CLAUDE_RUNNER_MODEL);
  });
});

// Regression guard for retired-model-kills-loop-silently: the default must be a
// bare alias, never a versioned claude-* id that can retire out from under the loop.
test('default model is an alias, not a versioned claude-* id', () => {
  assert.equal(DEFAULT_CLAUDE_RUNNER_MODEL, 'opus');
  assert.doesNotMatch(DEFAULT_CLAUDE_RUNNER_MODEL, /^claude-/);
  assert.doesNotMatch(DEFAULT_CLAUDE_RUNNER_MODEL, /\d/);
});

// --- buildRunnerCommand: --model always injected ---

test('buildRunnerCommand always emits --model', () => {
  withEnv(undefined, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', allowedTools: 'Bash,Read' });
    assert.match(cmd, /--model opus\b/);
    assert.match(cmd, /claude -p "\$\(cat '\/tmp\/p\.tmp'\)"/);
    assert.match(cmd, /--allowedTools "Bash,Read"/);
  });
});

test('buildRunnerCommand omits --allowedTools when not given', () => {
  const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'sonnet' });
  assert.match(cmd, /--model sonnet\b/);
  assert.doesNotMatch(cmd, /--allowedTools/);
});

test('buildRunnerCommand resolves model via the same precedence', () => {
  withEnv('haiku', () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp' });
    assert.match(cmd, /--model haiku\b/);
  });
});

test('buildRunnerCommand escapes single quotes in the prompt path', () => {
  const cmd = buildRunnerCommand({ promptFile: "/tmp/it's.tmp", model: 'opus' });
  assert.ok(cmd.includes("'\\''"), 'single quote should be shell-escaped');
});

test('buildRunnerCommand requires a promptFile', () => {
  assert.throws(() => buildRunnerCommand({ allowedTools: 'Bash' }), /promptFile is required/);
  assert.throws(() => buildRunnerCommand(), /promptFile is required/);
});
