'use strict';

// The spend gate: nothing unattended runs on Opus, Fable or Sonnet without the
// owner's yes, given as ATRIS_SPEND_OK=<that exact model id>. Without it the run
// drops to the cheap model and says so on stderr, once.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  resolveClaudeRunnerModel,
  buildRunnerCommand,
  applySpendGate,
  resetSpendGateWarnings,
} = require('../lib/runner-command');

const ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE',
  'ATRIS_SPEND_OK',
];

// Runs fn with a clean runner env plus `values`, and returns what it wrote to stderr.
function gated(values, fn) {
  const prev = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) process.env[key] = value;
  resetSpendGateWarnings();
  const realWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = realWrite;
    for (const key of ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return stderr;
}

test('the unattended default is haiku and prints nothing', () => {
  const stderr = gated({}, () => {
    assert.equal(DEFAULT_CLAUDE_RUNNER_MODEL, 'claude-haiku-5-5');
    assert.equal(resolveClaudeRunnerModel({}), 'claude-haiku-5-5');
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /--model claude-haiku-5-5$/);
  });
  assert.equal(stderr, '');
});

test('opus without the owner yes falls back to haiku and says so once', () => {
  const stderr = gated({ ATRIS_RUNNER_MODEL: 'claude-opus-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-haiku-5-5');
    assert.equal(resolveClaudeRunnerModel({}), 'claude-haiku-5-5');
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /--model claude-haiku-5-5$/);
  });
  assert.equal(
    stderr,
    "atris: unattended run on claude-opus-5-5 needs the owner's yes; running on claude-haiku-5-5. To allow it for this run: ATRIS_SPEND_OK=claude-opus-5-5\n"
  );
});

test('opus with ATRIS_SPEND_OK naming it runs opus, quietly', () => {
  const stderr = gated({ ATRIS_RUNNER_MODEL: 'claude-opus-5-5', ATRIS_SPEND_OK: 'claude-opus-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-opus-5-5');
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /--model claude-opus-5-5$/);
  });
  assert.equal(stderr, '');
});

test('a yes for another model does not unlock opus', () => {
  const stderr = gated({ ATRIS_SPEND_OK: 'claude-sonnet-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-opus-5-5' }), 'claude-haiku-5-5');
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-sonnet-5-5' }), 'claude-sonnet-5-5');
  });
  assert.match(stderr, /claude-opus-5-5 needs the owner's yes/);
  assert.doesNotMatch(stderr, /claude-sonnet-5-5 needs/);
});

test('a yes of 1 or a prefix unlocks nothing', () => {
  for (const yes of ['1', 'true', 'opus', 'claude-opus']) {
    gated({ ATRIS_SPEND_OK: yes }, () => {
      assert.equal(resolveClaudeRunnerModel({ model: 'claude-opus-5-5' }), 'claude-haiku-5-5');
    });
  }
});

test('fable and sonnet are gated too, whatever the case', () => {
  const stderr = gated({}, () => {
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-fable-5-1' }), 'claude-haiku-5-5');
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-sonnet-5-5' }), 'claude-haiku-5-5');
    assert.equal(applySpendGate('CLAUDE-OPUS-5-5'), 'claude-haiku-5-5');
  });
  assert.match(stderr, /claude-fable-5-1 needs/);
  assert.match(stderr, /claude-sonnet-5-5 needs/);
});

test('the fable profile and the legacy env both go through the gate', () => {
  gated({ ATRIS_RUNNER_PROFILE: 'fable' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-haiku-5-5');
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /--model claude-haiku-5-5$/);
  });
  gated({ ATRIS_CLAUDE_MODEL: 'claude-opus-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-haiku-5-5');
  });
  gated({ ATRIS_RUNNER_PROFILE: 'fable', ATRIS_SPEND_OK: 'claude-fable-5-1' }, () => {
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /--model claude-fable-5-1$/);
  });
});

test('a pinned model in a command template is gated too', () => {
  gated({
    ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} -p {prompt} {pinnedModelFlag}',
  }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'claude-opus-5-5' });
    assert.match(cmd, /--model claude-haiku-5-5/);
    assert.doesNotMatch(cmd, /opus/);
  });
});

test('haiku always runs, with or without a yes', () => {
  gated({ ATRIS_RUNNER_MODEL: 'claude-haiku-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-haiku-5-5');
  });
  const stderr = gated({ ATRIS_SPEND_OK: 'claude-opus-5-5' }, () => {
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-haiku-5-5' }), 'claude-haiku-5-5');
  });
  assert.equal(stderr, '');
});

test('an engine that runs only its own models is not told about claude spend', () => {
  const stderr = gated({ ATRIS_RUNNER_PROFILE: 'codex' }, () => {
    buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'claude-opus-5-5' });
  });
  assert.equal(stderr, '');
});
