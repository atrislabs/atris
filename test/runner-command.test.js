'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  DEFAULT_CLAUDE_RUNNER_BIN,
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  resolveClaudeRunnerCommandTemplate,
  buildRunnerAvailabilityCommand,
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

function withBinEnv(value, fn) {
  const prev = process.env.ATRIS_CLAUDE_BIN;
  if (value === undefined) delete process.env.ATRIS_CLAUDE_BIN;
  else process.env.ATRIS_CLAUDE_BIN = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.ATRIS_CLAUDE_BIN;
    else process.env.ATRIS_CLAUDE_BIN = prev;
  }
}

function withTemplateEnv(value, fn) {
  const prev = process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
  if (value === undefined) delete process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
  else process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
    else process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE = prev;
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

// --- resolveClaudeRunnerBin: runner swap is config-only ---

test('resolveClaudeRunnerBin defaults to claude', () => {
  withBinEnv(undefined, () => {
    assert.equal(resolveClaudeRunnerBin(), 'claude');
    assert.equal(resolveClaudeRunnerBin(), DEFAULT_CLAUDE_RUNNER_BIN);
  });
});

test('resolveClaudeRunnerBin honors ATRIS_CLAUDE_BIN', () => {
  withBinEnv('/opt/atris/bin/claude-nightly', () => {
    assert.equal(resolveClaudeRunnerBin(), '/opt/atris/bin/claude-nightly');
  });
});

test('resolveClaudeRunnerCommandTemplate honors ATRIS_CLAUDE_COMMAND_TEMPLATE', () => {
  withTemplateEnv('{bin} --print-file {promptFile} {modelFlag}', () => {
    assert.equal(resolveClaudeRunnerCommandTemplate(), '{bin} --print-file {promptFile} {modelFlag}');
  });
  withTemplateEnv(undefined, () => {
    assert.equal(resolveClaudeRunnerCommandTemplate(), '');
  });
});

test('buildRunnerAvailabilityCommand checks the configured runner binary', () => {
  withBinEnv('/opt/atris/bin/claude-nightly', () => {
    assert.equal(buildRunnerAvailabilityCommand(), 'command -v /opt/atris/bin/claude-nightly');
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
  withTemplateEnv(undefined, () => {
    withEnv(undefined, () => {
      const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', allowedTools: 'Bash,Read' });
      assert.match(cmd, /--model opus\b/);
      assert.match(cmd, /claude -p "\$\(cat '\/tmp\/p\.tmp'\)"/);
      assert.match(cmd, /--allowedTools "Bash,Read"/);
    });
  });
});

test('buildRunnerCommand uses ATRIS_CLAUDE_BIN without changing call sites', () => {
  withBinEnv('/opt/atris/bin/claude-nightly', () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus' });
    assert.match(cmd, /^\/opt\/atris\/bin\/claude-nightly -p/);
    assert.match(cmd, /--model opus\b/);
  });
});

test('buildRunnerCommand shell-quotes runner binaries with spaces', () => {
  withBinEnv('/Applications/Claude Nightly/bin/claude', () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus' });
    assert.match(cmd, /^'\/Applications\/Claude Nightly\/bin\/claude' -p/);
  });
});

test('buildRunnerCommand shell-quotes model values in the default command shape', () => {
  const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'nightly model' });
  assert.match(cmd, /--model 'nightly model'/);
});

test('buildRunnerCommand can replace the claude -p command shape by template', () => {
  withBinEnv('/opt/atris/bin/claude-nightly', () => {
    withTemplateEnv('{bin} --print-file {promptFile} {modelFlag} {allowedToolsFlag}', () => {
      const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'sonnet', allowedTools: 'Bash,Read' });
      assert.equal(cmd, "/opt/atris/bin/claude-nightly --print-file /tmp/p.tmp --model sonnet --allowedTools 'Bash,Read'");
    });
  });
});

test('buildRunnerCommand template supports prompt substitution and optional tools', () => {
  withTemplateEnv('{bin} --prompt {prompt} {modelFlag} {allowedToolsFlag}', () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus' });
    assert.equal(cmd, 'claude --prompt "$(cat /tmp/p.tmp)" --model opus');
  });
});

test('buildRunnerCommand template shell-quotes substituted values', () => {
  withBinEnv('/Applications/Claude Nightly/bin/claude', () => {
    withTemplateEnv('{bin} --file {promptFile} {modelFlag}', () => {
      const cmd = buildRunnerCommand({ promptFile: "/tmp/it's.tmp", model: 'opus' });
      assert.equal(cmd, "'/Applications/Claude Nightly/bin/claude' --file '/tmp/it'\\''s.tmp' --model opus");
    });
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
