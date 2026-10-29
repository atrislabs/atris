'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  DEFAULT_FABLE_RUNNER_MODEL,
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
  runnerModelFor,
} = require('../lib/runner-command');

const RUNNER_ENV_KEYS = [
  'ATRIS_SPEND_OK',
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

function testResolution(name, env, check) {
  test(name, () => withRunnerEnv(env, check));
}

testResolution('resolveClaudeRunnerModel honors explicit model first', { ATRIS_CLAUDE_MODEL: 'sonnet', ATRIS_SPEND_OK: 'claude-opus-5-5' }, () => {
  assert.equal(resolveClaudeRunnerModel({ model: 'claude-opus-5-5' }), 'claude-opus-5-5');
  assert.equal(resolveClaudeRunnerModel({ model: 'opus 5.5' }), 'claude-opus-5-5');
});

testResolution('resolveClaudeRunnerModel falls back to ATRIS_CLAUDE_MODEL env', { ATRIS_CLAUDE_MODEL: 'sonnet', ATRIS_SPEND_OK: 'sonnet' }, () => {
  assert.equal(resolveClaudeRunnerModel({}), 'sonnet');
  assert.equal(resolveClaudeRunnerModel({ model: null }), 'sonnet');
  assert.equal(resolveClaudeRunnerModel(null), 'sonnet');
});

testResolution('resolveClaudeRunnerModel prefers ATRIS_RUNNER_MODEL over legacy env', { ATRIS_RUNNER_MODEL: 'glm-5.2', ATRIS_CLAUDE_MODEL: 'opus' }, () => {
  assert.equal(resolveClaudeRunnerModel({}), 'glm-5.2');
});

testResolution('resolveClaudeRunnerModel defaults to pinned Haiku 5.5', {}, () => {
  assert.equal(resolveClaudeRunnerModel({}), 'claude-haiku-5-5');
  assert.equal(resolveClaudeRunnerModel({ model: null }), 'claude-haiku-5-5');
  assert.equal(resolveClaudeRunnerModel({ model: '   ' }), 'claude-haiku-5-5');
  assert.equal(resolveClaudeRunnerModel({}), DEFAULT_CLAUDE_RUNNER_MODEL);
});

// --- resolveClaudeRunnerBin: runner swap is config-only ---

testResolution('resolveClaudeRunnerBin defaults to claude', {}, () => {
  assert.equal(resolveClaudeRunnerBin(), 'claude');
  assert.equal(resolveClaudeRunnerBin(), DEFAULT_CLAUDE_RUNNER_BIN);
});

testResolution('resolveClaudeRunnerBin honors ATRIS_CLAUDE_BIN', { ATRIS_CLAUDE_BIN: '/opt/atris/bin/claude-nightly' }, () => {
  assert.equal(resolveClaudeRunnerBin(), '/opt/atris/bin/claude-nightly');
});

testResolution('resolveClaudeRunnerBin prefers ATRIS_RUNNER_BIN over legacy env', { ATRIS_RUNNER_BIN: '/opt/glm/runner', ATRIS_CLAUDE_BIN: '/opt/claude' }, () => {
  assert.equal(resolveClaudeRunnerBin(), '/opt/glm/runner');
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
  // Operator-facing list = canonical defs minus hidden profiles, no aliases.
  assert.deepEqual(
    RUNNER_PROFILE_NAMES,
    Object.keys(RUNNER_PROFILE_DEFS).filter((name) => !RUNNER_PROFILE_DEFS[name].hidden)
  );
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

// Hidden profiles are private engines: fully resolvable and spawnable, but
// absent from every operator-facing list.
test('commandcode profile resolves but stays out of operator-facing lists', () => {
  assert.ok(RUNNER_PROFILE_DEFS.commandcode, 'commandcode def exists');
  assert.equal(RUNNER_PROFILE_DEFS.commandcode.hidden, true);
  assert.ok(!RUNNER_PROFILE_NAMES.includes('commandcode'), 'hidden profile must not appear in RUNNER_PROFILE_NAMES');
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'commandcode' }, () => {
    assert.deepEqual(resolveRunnerProfile(), RUNNER_PROFILE_DEFS.commandcode);
    assert.equal(resolveClaudeRunnerBin(), 'cmd');
    // No pinned model: the profile template omits {modelFlag} entirely, so
    // the run rides this machine's configured Command Code default.
    assert.equal(resolveClaudeRunnerModel({}), DEFAULT_CLAUDE_RUNNER_MODEL);
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), 'cmd -p "$(cat /tmp/p.tmp)"');
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

test('compat runner profiles resolve to concrete runner configs', () => {
  const cases = [
    {
      profile: 'fable',
      bin: 'claude',
      model: DEFAULT_FABLE_RUNNER_MODEL,
      template: '',
      command: /claude -p .*--model claude-fable-5-1\b/,
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
      model: 'claude-haiku-5-5',
      template: '',
      command: /claude -p .*--model claude-haiku-5-5\b/,
    },
  ];
  for (const entry of cases) {
    // fable is a gated model: its profile runs it only with the owner's yes.
    withRunnerEnv({ ATRIS_RUNNER_PROFILE: entry.profile, ATRIS_SPEND_OK: DEFAULT_FABLE_RUNNER_MODEL }, () => {
      assert.deepEqual(resolveRunnerProfile(), RUNNER_PROFILE_DEFS[entry.profile]);
      assert.equal(resolveClaudeRunnerBin(), entry.bin);
      assert.equal(resolveClaudeRunnerModel({}), entry.model);
      assert.equal(resolveClaudeRunnerCommandTemplate(), entry.template);
      assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), entry.command);
    });
  }
});

test('grok runner profile uses grok --always-approve and rides the grok cli default model', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'grok' }, () => {
    assert.deepEqual(resolveRunnerProfile(), RUNNER_PROFILE_DEFS.grok);
    assert.equal(resolveClaudeRunnerBin(), 'grok');
    assert.equal(RUNNER_PROFILE_DEFS.grok.model, '');
    assert.equal(resolveClaudeRunnerCommandTemplate(), '{bin} --always-approve {pinnedModelFlag} {pinnedEffortFlag} -p {prompt}');
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), 'grok --always-approve -p "$(cat /tmp/p.tmp)"');
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'grok-4.7-build-fast' }), 'grok --always-approve --model grok-4.7-build-fast -p "$(cat /tmp/p.tmp)"');
  });
});

test('devin runner profile takes --model only when a model is pinned', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'devin', ATRIS_RUNNER_MODEL: 'claude-opus-5-5' }, () => {
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), 'devin -p -- "$(cat /tmp/p.tmp)"');
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'swe-2-max' }), 'devin -p --model swe-2-max -- "$(cat /tmp/p.tmp)"');
  });
});

test('agy runner profile uses Antigravity accept-edits print mode and rides its own model unless one is pinned', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'agy' }, () => {
    assert.deepEqual(resolveRunnerProfile(), RUNNER_PROFILE_DEFS.agy);
    assert.equal(resolveClaudeRunnerBin(), 'agy');
    assert.equal(resolveClaudeRunnerCommandTemplate(), '{bin} --mode accept-edits --dangerously-skip-permissions --add-dir "$PWD" {pinnedModelFlag} {pinnedEffortFlag} -p "You are running headless with edit permission already granted. Apply changes directly and never ask for confirmation. "{prompt}');
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), 'agy --mode accept-edits --dangerously-skip-permissions --add-dir "$PWD" -p "You are running headless with edit permission already granted. Apply changes directly and never ask for confirmation. ""$(cat /tmp/p.tmp)"');
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'gemini-3.8-flash-high' }), 'agy --mode accept-edits --dangerously-skip-permissions --add-dir "$PWD" --model gemini-3.8-flash-high -p "You are running headless with edit permission already granted. Apply changes directly and never ask for confirmation. ""$(cat /tmp/p.tmp)"');
  });
});

test('antigravity is an alias for the canonical agy profile', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'antigravity' }, () => {
    assert.strictEqual(resolveRunnerProfile(), RUNNER_PROFILE_DEFS.agy);
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
test('default model is pinned to Haiku 5.5, the cheap model', () => {
  assert.equal(DEFAULT_CLAUDE_RUNNER_MODEL, 'claude-haiku-5-5');
  assert.equal(DEFAULT_FABLE_RUNNER_MODEL, 'claude-fable-5-1');
});

// --- buildRunnerCommand: --model always injected ---

test('buildRunnerCommand always emits --model', () => {
  withTemplateEnv(undefined, () => {
    withEnv(undefined, () => {
      const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', allowedTools: 'Bash,Read' });
      assert.match(cmd, /--model claude-haiku-5-5\b/);
      assert.match(cmd, /claude -p "\$\(cat '\/tmp\/p\.tmp'\)"/);
      assert.match(cmd, /--allowedTools 'Bash,Read'/);
    });
  });
});

test('buildRunnerCommand uses ATRIS_CLAUDE_BIN without changing call sites', () => {
  withRunnerEnv({ ATRIS_CLAUDE_BIN: '/opt/atris/bin/claude-nightly', ATRIS_SPEND_OK: 'opus' }, () => {
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
    ATRIS_SPEND_OK: 'sonnet',
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
  withRunnerEnv({ ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} --prompt {prompt} {modelFlag} {allowedToolsFlag}', ATRIS_SPEND_OK: 'opus' }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus' });
    assert.equal(cmd, 'claude --prompt "$(cat /tmp/p.tmp)" --model opus');
  });
});

test('buildRunnerCommand template shell-quotes substituted values', () => {
  withRunnerEnv({
    ATRIS_CLAUDE_BIN: '/Applications/Claude Nightly/bin/claude',
    ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} --file {promptFile} {modelFlag}',
    ATRIS_SPEND_OK: 'opus',
  }, () => {
    const cmd = buildRunnerCommand({ promptFile: "/tmp/it's.tmp", model: 'opus' });
    assert.equal(cmd, "'/Applications/Claude Nightly/bin/claude' --file '/tmp/it'\\''s.tmp' --model opus");
  });
});

test('buildRunnerCommand omits --allowedTools when not given', () => {
  const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'haiku' });
  assert.match(cmd, /--model haiku\b/);
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

test('the fable profile runs Fable 5.1, not the stale claude-fable-5', () => {
  assert.equal(RUNNER_PROFILE_DEFS.fable.model, 'claude-fable-5-1');
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'fable', ATRIS_SPEND_OK: 'claude-fable-5-1' }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp' });
    assert.match(cmd, /--model claude-fable-5-1(\s|$)/);
    assert.doesNotMatch(cmd, /claude-fable-5(\s|$)/);
  });
});

test('a display name with a space becomes the id the claude cli accepts', () => {
  for (const [typed, id] of [
    ['opus 5.5', 'claude-opus-5-5'],
    ['Opus 5.5', 'claude-opus-5-5'],
    ['fable 5.1', 'claude-fable-5-1'],
    ['haiku 5.5', 'claude-haiku-5-5'],
    ['sonnet 5', 'claude-sonnet-5'],
    ['opus 5.5[1m]', 'claude-opus-5-5[1m]'],
  ]) {
    assert.equal(runnerModelFor('claude', typed), id, typed);
    assert.equal(runnerModelFor('', typed), id, typed);
    withRunnerEnv({ ATRIS_SPEND_OK: id }, () => {
      assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: typed }), new RegExp(`--model '?${id.replace(/[[\]]/g, '\\$&')}'?(\\s|$)`), typed);
    });
  }
  assert.equal(runnerModelFor('fable', 'fable 5.1'), 'claude-fable-5-1');
  assert.equal(runnerModelFor('haiku', 'haiku 4.5'), 'claude-haiku-5-5', 'a retired version still upgrades');
});

test('ids, aliases and other engines model names pass through unchanged', () => {
  for (const same of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-4-6[1m]', 'opus', 'sonnet', 'opusplan', 'default']) {
    assert.equal(runnerModelFor('claude', same), same, same);
  }
  assert.equal(runnerModelFor('devin', 'swe-2-max'), 'swe-2-max');
  assert.equal(runnerModelFor('grok', 'grok-4.7-build-fast'), 'grok-4.7-build-fast');
  assert.equal(runnerModelFor('agy', 'gemini 3.8 flash'), 'gemini 3.8 flash');
  assert.equal(runnerModelFor('opencode', 'anthropic/claude-opus-5-5'), 'anthropic/claude-opus-5-5');
  // an engine that is not the claude cli never reads "opus 5.5" as a claude id
  assert.equal(runnerModelFor('devin', 'opus 5.5'), 'opus 5.5');
  assert.equal(runnerModelFor('cursor', 'sonnet 5'), 'sonnet 5');
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'devin', ATRIS_SPEND_OK: 'opus 5.5' }, () => {
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus 5.5' }), /--model 'opus 5\.5'/);
  });
});

test('a roster pick or mission model still saved as claude-fable-5 runs as Fable 5.1', () => {
  assert.equal(runnerModelFor('fable', 'claude-fable-5'), 'claude-fable-5-1');
  assert.equal(runnerModelFor('claude', 'claude-fable-5[1m]'), 'claude-fable-5-1[1m]');
  assert.equal(runnerModelFor('claude', 'claude-fable-5-1'), 'claude-fable-5-1');
  withRunnerEnv({ ATRIS_SPEND_OK: 'claude-fable-5-1' }, () => {
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'claude-fable-5' }), /--model claude-fable-5-1(\s|$)/);
  });
});

test('mercury runner profile resolves to the pinned test model and ax flag', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'mercury' }, () => {
    assert.equal(resolveClaudeRunnerBin(), 'ax');
    assert.equal(resolveClaudeRunnerModel({}), 'inception:mercury-3-preview-1002');
    assert.equal(resolveClaudeRunnerCommandTemplate(), '{bin} --mercury {prompt}');
    assert.equal(buildRunnerCommand({ promptFile: '/tmp/p.tmp' }), 'ax --mercury "$(cat /tmp/p.tmp)"');
  });
});
