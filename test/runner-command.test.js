'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_RUNNER_MODEL,
  DEFAULT_RUNNER_BIN,
  DEFAULT_CLAUDE_RUNNER_MODEL,
  DEFAULT_CLAUDE_RUNNER_BIN,
  RUNNER_PROFILES,
  resolveRunnerProfile,
  resolveRunnerModel,
  resolveRunnerBin,
  resolveRunnerCommandTemplate,
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  resolveClaudeRunnerCommandTemplate,
  buildRunnerAvailabilityCommand,
  buildRunnerCommand,
} = require('../lib/runner-command');

const RUNNER_ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function withRunnerEnv(values, fn) {
  const prev = new Map(RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RUNNER_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of RUNNER_ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withEnv(value, fn) {
  withRunnerEnv({ ATRIS_CLAUDE_MODEL: value }, fn);
}

function withBinEnv(value, fn) {
  withRunnerEnv({ ATRIS_CLAUDE_BIN: value }, fn);
}

function withTemplateEnv(value, fn) {
  withRunnerEnv({ ATRIS_CLAUDE_COMMAND_TEMPLATE: value }, fn);
}

// --- resolveClaudeRunnerModel: precedence explicit > env > default alias ---

test('generic runner resolver names are canonical while legacy aliases stay compatible', () => {
  assert.equal(DEFAULT_RUNNER_MODEL, DEFAULT_CLAUDE_RUNNER_MODEL);
  assert.equal(DEFAULT_RUNNER_BIN, DEFAULT_CLAUDE_RUNNER_BIN);
  assert.equal(resolveRunnerModel, resolveClaudeRunnerModel);
  assert.equal(resolveRunnerBin, resolveClaudeRunnerBin);
  assert.equal(resolveRunnerCommandTemplate, resolveClaudeRunnerCommandTemplate);
});

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

test('resolveClaudeRunnerModel prefers ATRIS_RUNNER_MODEL over legacy env', () => {
  withRunnerEnv({ ATRIS_RUNNER_MODEL: 'glm-5.2', ATRIS_CLAUDE_MODEL: 'opus' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'glm-5.2');
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

test('resolveClaudeRunnerBin prefers ATRIS_RUNNER_BIN over legacy env', () => {
  withRunnerEnv({ ATRIS_RUNNER_BIN: '/opt/glm/runner', ATRIS_CLAUDE_BIN: '/opt/claude' }, () => {
    assert.equal(resolveClaudeRunnerBin(), '/opt/glm/runner');
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

test('resolveClaudeRunnerCommandTemplate prefers ATRIS_RUNNER_COMMAND_TEMPLATE over legacy env', () => {
  withRunnerEnv({
    ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} --model {model} --prompt-file {promptFile}',
    ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} -p {prompt} {modelFlag}',
  }, () => {
    assert.equal(resolveClaudeRunnerCommandTemplate(), '{bin} --model {model} --prompt-file {promptFile}');
  });
});

test('resolveRunnerProfile exposes the Atris Fast profile', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'atris-fast' }, () => {
    assert.deepEqual(resolveRunnerProfile(), RUNNER_PROFILES['atris-fast']);
  });
});

test('Atris Fast runner profile resolves to ax --fast and atris:fast', () => {
  withRunnerEnv({
    ATRIS_RUNNER_PROFILE: 'atris-fast',
    ATRIS_CLAUDE_BIN: '/opt/claude',
    ATRIS_CLAUDE_MODEL: 'opus',
    ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} -p {prompt} {modelFlag}',
  }, () => {
    assert.equal(resolveClaudeRunnerBin(), 'ax');
    assert.equal(resolveClaudeRunnerModel({}), 'atris:fast');
    assert.equal(resolveClaudeRunnerCommandTemplate(), '{bin} --fast {prompt}');
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), 'ax --fast "$(cat /tmp/p.tmp)"');
  });
});

test('generic runner env overrides the Atris Fast profile', () => {
  withRunnerEnv({
    ATRIS_RUNNER_PROFILE: 'atris-fast',
    ATRIS_RUNNER_BIN: '/opt/glm/runner',
    ATRIS_RUNNER_MODEL: 'glm-5.2',
    ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} --model {model} --prompt-file {promptFile}',
  }, () => {
    assert.equal(resolveRunnerBin(), '/opt/glm/runner');
    assert.equal(resolveRunnerModel({}), 'glm-5.2');
    assert.equal(resolveRunnerCommandTemplate(), '{bin} --model {model} --prompt-file {promptFile}');
  });
});

test('unknown runner profile throws a clear config error', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'atris-9' }, () => {
    assert.throws(() => resolveRunnerProfile(), /Unknown ATRIS_RUNNER_PROFILE "atris-9"/);
    assert.throws(() => buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), /Unknown ATRIS_RUNNER_PROFILE "atris-9"/);
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
      assert.match(cmd, /--allowedTools 'Bash,Read'/);
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

test('buildRunnerCommand shell-quotes allowedTools in the default command shape', () => {
  const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', allowedTools: "Bash,Read,O'Reilly" });
  assert.match(cmd, /--allowedTools 'Bash,Read,O'\\''Reilly'/);
});

test('buildRunnerCommand can replace the claude -p command shape by template', () => {
  withRunnerEnv({
    ATRIS_CLAUDE_BIN: '/opt/atris/bin/claude-nightly',
    ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} --print-file {promptFile} {modelFlag} {allowedToolsFlag}',
  }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'sonnet', allowedTools: 'Bash,Read' });
    assert.equal(cmd, "/opt/atris/bin/claude-nightly --print-file /tmp/p.tmp --model sonnet --allowedTools 'Bash,Read'");
  });
});

test('buildRunnerCommand can target a GLM-style runner through ATRIS_RUNNER_*', () => {
  withRunnerEnv({
    ATRIS_RUNNER_BIN: '/opt/glm/runner',
    ATRIS_RUNNER_MODEL: 'glm-5.2',
    ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} --model {model} --prompt-file {promptFile} {allowedToolsFlag}',
    ATRIS_CLAUDE_BIN: '/opt/claude',
    ATRIS_CLAUDE_MODEL: 'opus',
    ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} -p {prompt} {modelFlag}',
  }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', allowedTools: 'Bash,Read' });
    assert.equal(cmd, "/opt/glm/runner --model glm-5.2 --prompt-file /tmp/p.tmp --allowedTools 'Bash,Read'");
  });
});

test('buildRunnerCommand template supports prompt substitution and optional tools', () => {
  withTemplateEnv('{bin} --prompt {prompt} {modelFlag} {allowedToolsFlag}', () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus' });
    assert.equal(cmd, 'claude --prompt "$(cat /tmp/p.tmp)" --model opus');
  });
});

test('buildRunnerCommand template shell-quotes substituted values', () => {
  withRunnerEnv({
    ATRIS_CLAUDE_BIN: '/Applications/Claude Nightly/bin/claude',
    ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} --file {promptFile} {modelFlag}',
  }, () => {
    const cmd = buildRunnerCommand({ promptFile: "/tmp/it's.tmp", model: 'opus' });
    assert.equal(cmd, "'/Applications/Claude Nightly/bin/claude' --file '/tmp/it'\\''s.tmp' --model opus");
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
