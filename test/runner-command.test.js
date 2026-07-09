'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  DEFAULT_CLAUDE_RUNNER_BIN,
  RUNNER_PROFILES,
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
  resolveRunnerProfile,
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  resolveClaudeRunnerCommandTemplate,
  buildRunnerAvailabilityCommand,
  runnerAvailabilityFailureMessage,
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

// --- resolveClaudeRunnerModel: precedence explicit > env > pinned default ---

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

test('resolveClaudeRunnerModel defaults to pinned Opus 4.8', () => {
  withEnv(undefined, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'claude-opus-4-8');
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

// Regression guard for profile-body-drift: aliases must reuse the ONE canonical
// config object, and the operator-facing list must stay canonical-only. This
// keeps a runner swap a config edit (one alias line / one def) rather than a
// copied profile body that can silently diverge.
test('runner profile aliases reuse the canonical config, not duplicated bodies', () => {
  assert.deepEqual(RUNNER_PROFILE_NAMES, Object.keys(RUNNER_PROFILE_DEFS));
  for (const [alias, target] of Object.entries(RUNNER_PROFILE_ALIASES)) {
    // alias resolves to the SAME frozen object as its canonical target
    assert.strictEqual(RUNNER_PROFILES[alias], RUNNER_PROFILE_DEFS[target]);
    // aliases never leak into the operator-facing list
    assert.ok(!RUNNER_PROFILE_NAMES.includes(alias), `${alias} must not appear in RUNNER_PROFILE_NAMES`);
  }
  // every alias spelling still resolves via the env-driven path
  for (const alias of Object.keys(RUNNER_PROFILE_ALIASES)) {
    withRunnerEnv({ ATRIS_RUNNER_PROFILE: alias }, () => {
      assert.deepEqual(resolveRunnerProfile(), RUNNER_PROFILE_DEFS[RUNNER_PROFILE_ALIASES[alias]]);
    });
  }
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

test('compat runner profiles resolve to concrete runner configs', () => {
  const cases = [
    {
      profile: 'fable',
      bin: 'claude',
      model: DEFAULT_CLAUDE_RUNNER_MODEL,
      template: '',
      command: /claude -p .*--model claude-opus-4-8\b/,
    },
    {
      profile: 'composer',
      bin: 'ax',
      model: 'composer-2-5-fast',
      template: '{bin} --fast {prompt}',
      command: /^ax --fast "\$\(cat \/tmp\/p\.tmp\)"$/,
    },
    {
      profile: 'haiku',
      bin: 'claude',
      model: 'claude-haiku-4-5',
      template: '',
      command: /claude -p .*--model claude-haiku-4-5\b/,
    },
  ];
  for (const entry of cases) {
    withRunnerEnv({ ATRIS_RUNNER_PROFILE: entry.profile }, () => {
      assert.deepEqual(resolveRunnerProfile(), RUNNER_PROFILE_DEFS[entry.profile]);
      assert.equal(resolveClaudeRunnerBin(), entry.bin);
      assert.equal(resolveClaudeRunnerModel({}), entry.model);
      assert.equal(resolveClaudeRunnerCommandTemplate(), entry.template);
      assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), entry.command);
    });
  }
});

test('grok runner profile uses grok --always-approve and pins grok-4.5', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'grok' }, () => {
    assert.deepEqual(resolveRunnerProfile(), RUNNER_PROFILE_DEFS.grok);
    assert.equal(resolveClaudeRunnerBin(), 'grok');
    assert.equal(resolveClaudeRunnerModel({}), 'grok-4.5');
    assert.equal(resolveClaudeRunnerCommandTemplate(), '{bin} --always-approve -p {prompt}');
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), 'grok --always-approve -p "$(cat /tmp/p.tmp)"');
  });
});

test('generic runner env overrides the Atris Fast profile', () => {
  withRunnerEnv({
    ATRIS_RUNNER_PROFILE: 'atris-fast',
    ATRIS_RUNNER_BIN: '/opt/glm/runner',
    ATRIS_RUNNER_MODEL: 'glm-5.2',
    ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} --model {model} --prompt-file {promptFile}',
  }, () => {
    assert.equal(resolveClaudeRunnerBin(), '/opt/glm/runner');
    assert.equal(resolveClaudeRunnerModel({}), 'glm-5.2');
    assert.equal(resolveClaudeRunnerCommandTemplate(), '{bin} --model {model} --prompt-file {promptFile}');
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

test('runnerAvailabilityFailureMessage reports unknown profiles without rethrowing', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'atris-9' }, () => {
    let err = null;
    try {
      buildRunnerAvailabilityCommand();
    } catch (caught) {
      err = caught;
    }
    assert.match(err && err.message, /Unknown ATRIS_RUNNER_PROFILE "atris-9"/);
    assert.match(
      runnerAvailabilityFailureMessage(err),
      /Unknown ATRIS_RUNNER_PROFILE "atris-9".*Set ATRIS_RUNNER_PROFILE to one of: atris-fast/
    );
  });
});

// Regression guard for local-alias-drift: the default must be pinned so `opus`
// does not resolve differently across Claude Code versions or account rollouts.
test('default model is pinned to Opus 4.8', () => {
  assert.equal(DEFAULT_CLAUDE_RUNNER_MODEL, 'claude-opus-4-8');
});

// --- buildRunnerCommand: --model always injected ---

test('buildRunnerCommand always emits --model', () => {
  withTemplateEnv(undefined, () => {
    withEnv(undefined, () => {
      const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', allowedTools: 'Bash,Read' });
      assert.match(cmd, /--model claude-opus-4-8\b/);
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
