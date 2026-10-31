'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { modelFromArgv } = require('../lib/claude-spend-guard');
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
  launchFor,
} = require('../lib/runner-command');

const RUNNER_ENV_KEYS = [
  'ATRIS_CLAUDE_SPEND_OK',
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

testResolution('resolveClaudeRunnerModel honors explicit model first', { ATRIS_CLAUDE_MODEL: 'sonnet', ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' }, () => {
  assert.equal(resolveClaudeRunnerModel({ model: 'claude-opus-5-5' }), 'claude-opus-5-5');
  assert.equal(resolveClaudeRunnerModel({ model: 'opus 5.5' }), 'claude-opus-5-5');
});

testResolution('resolveClaudeRunnerModel falls back to ATRIS_CLAUDE_MODEL env', { ATRIS_CLAUDE_MODEL: 'sonnet', ATRIS_CLAUDE_SPEND_OK: 'sonnet' }, () => {
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
    withRunnerEnv({ ATRIS_RUNNER_PROFILE: entry.profile, ATRIS_CLAUDE_SPEND_OK: DEFAULT_FABLE_RUNNER_MODEL }, () => {
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
  withRunnerEnv({ ATRIS_CLAUDE_BIN: '/opt/atris/bin/claude-nightly', ATRIS_CLAUDE_SPEND_OK: 'opus' }, () => {
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
    ATRIS_CLAUDE_SPEND_OK: 'sonnet',
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
  withRunnerEnv({ ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} --prompt {prompt} {modelFlag} {allowedToolsFlag}', ATRIS_CLAUDE_SPEND_OK: 'opus' }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus' });
    assert.equal(cmd, 'claude --prompt "$(cat /tmp/p.tmp)" --model opus');
  });
});

test('buildRunnerCommand template shell-quotes substituted values', () => {
  withRunnerEnv({
    ATRIS_CLAUDE_BIN: '/Applications/Claude Nightly/bin/claude',
    ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} --file {promptFile} {modelFlag}',
    ATRIS_CLAUDE_SPEND_OK: 'opus',
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
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'fable', ATRIS_CLAUDE_SPEND_OK: 'claude-fable-5-1' }, () => {
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
    withRunnerEnv({ ATRIS_CLAUDE_SPEND_OK: id }, () => {
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
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'devin', ATRIS_CLAUDE_SPEND_OK: 'opus 5.5' }, () => {
    assert.match(buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus 5.5' }), /--model 'opus 5\.5'/);
  });
});

test('a roster pick or mission model still saved as claude-fable-5 runs as Fable 5.1', () => {
  assert.equal(runnerModelFor('fable', 'claude-fable-5'), 'claude-fable-5-1');
  assert.equal(runnerModelFor('claude', 'claude-fable-5[1m]'), 'claude-fable-5-1[1m]');
  assert.equal(runnerModelFor('claude', 'claude-fable-5-1'), 'claude-fable-5-1');
  withRunnerEnv({ ATRIS_CLAUDE_SPEND_OK: 'claude-fable-5-1' }, () => {
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

// ---------------------------------------------------------------------------
// launchFor: the model an engine's launch will carry, decided from the environment it is given. The builder
// picker uses it to ask the Claude spend guard about the engine the way the launch will really be made.

test('launchFor reads the model from the environment it is given, never from this process', () => {
  withRunnerEnv({ ATRIS_RUNNER_MODEL: 'claude-opus-5-5', ATRIS_CLAUDE_MODEL: 'claude-sonnet-5-5', ATRIS_RUNNER_PROFILE: 'devin' }, () => {
    assert.equal(launchFor('claude', { env: {} }).model, DEFAULT_CLAUDE_RUNNER_MODEL, 'this process says Opus; the environment asked about says nothing');
    assert.equal(launchFor('claude', { env: { ATRIS_CLAUDE_MODEL: 'claude-mystery-9' } }).model, 'claude-mystery-9');
    assert.equal(launchFor('claude', { env: { PATH: '/usr/bin' } }).bin, 'claude', 'and the process\'s runner profile is not the engine\'s');
  });
});

test('launchFor follows the launch\'s precedence: explicit, ATRIS_RUNNER_MODEL, the engine\'s own pin, the legacy ATRIS_CLAUDE_MODEL, the cheap default', () => {
  const both = { ATRIS_RUNNER_MODEL: 'claude-mystery-8', ATRIS_CLAUDE_MODEL: 'claude-mystery-9' };
  assert.equal(launchFor('claude', { env: both, model: 'claude-mystery-7' }).model, 'claude-mystery-7', 'an explicit model first');
  assert.equal(launchFor('claude', { env: both }).model, 'claude-mystery-8', 'then ATRIS_RUNNER_MODEL');
  assert.equal(launchFor('claude', { env: { ATRIS_CLAUDE_MODEL: 'claude-mystery-9' } }).model, 'claude-mystery-9', 'the legacy variable alone is a model too');
  assert.equal(launchFor('haiku', { env: { ATRIS_CLAUDE_MODEL: 'claude-mystery-9' } }).model, DEFAULT_CLAUDE_RUNNER_MODEL, 'the engine\'s own pin beats the legacy variable');
  assert.equal(launchFor('claude', { env: {} }).model, DEFAULT_CLAUDE_RUNNER_MODEL, 'and nothing at all is the cheap default');
  assert.equal(launchFor('claude').model, launchFor('claude', { env: process.env }).model, 'the default environment is this process\'s');
});

test('launchFor applies the spend gate with the approval in the environment it is given', () => {
  const opus = { ATRIS_RUNNER_MODEL: 'claude-opus-5-5' };
  assert.equal(launchFor('claude', { env: opus }).model, DEFAULT_CLAUDE_RUNNER_MODEL, 'no yes, so the launch drops to the cheap model');
  assert.equal(launchFor('claude', { env: { ...opus, ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' } }).model, 'claude-opus-5-5');
  assert.equal(launchFor('claude', { env: { ...opus, ATRIS_CLAUDE_SPEND_OK: 'claude-sonnet-5-5' } }).model, DEFAULT_CLAUDE_RUNNER_MODEL, 'a yes for another model is not a yes for this one');
  assert.equal(launchFor('fable', { env: {} }).model, DEFAULT_CLAUDE_RUNNER_MODEL, 'fable is a paid model');
  assert.equal(launchFor('fable', { env: { ATRIS_CLAUDE_SPEND_OK: DEFAULT_FABLE_RUNNER_MODEL } }).model, DEFAULT_FABLE_RUNNER_MODEL);
  // A model the gate does not name by family passes it, and the guard\'s hook is what stops it later.
  assert.equal(launchFor('claude', { env: { ATRIS_RUNNER_MODEL: 'claude-mystery-9' } }).model, 'claude-mystery-9');
});

test('launchFor says nothing and starts nothing: asking is not launching', () => {
  const realWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    launchFor('claude', { env: { ATRIS_RUNNER_MODEL: 'claude-opus-5-5' } });
    launchFor('fable', { env: {} });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(stderr, '', 'the warning belongs to the launch, once, when it is made');
});

test('launchFor names the program and the model, null for an engine nobody knows, and no claude model for an engine that cannot take one', () => {
  assert.deepEqual(launchFor('claude', { env: {} }), { engine: 'claude', bin: 'claude', model: DEFAULT_CLAUDE_RUNNER_MODEL });
  assert.equal(launchFor('nobody-at-all', { env: {} }), null);
  assert.equal(launchFor('', { env: {} }), null);
  const codex = launchFor('codex', { env: { ATRIS_RUNNER_MODEL: 'claude-mystery-9' } });
  assert.equal(codex.bin, 'codex');
  assert.equal(codex.model, '', 'codex runs only its own models, so a claude model name never reaches it');
});

test('launchFor agrees with buildRunnerCommand: the model it names is the --model the launch carries', () => {
  const cases = [
    {},
    { ATRIS_CLAUDE_MODEL: 'claude-mystery-9' },
    { ATRIS_RUNNER_MODEL: 'claude-mystery-8', ATRIS_CLAUDE_MODEL: 'claude-mystery-9' },
    { ATRIS_RUNNER_MODEL: 'claude-opus-5-5' },
    { ATRIS_RUNNER_MODEL: 'claude-opus-5-5', ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' },
    { ATRIS_RUNNER_MODEL: 'opus 5.5', ATRIS_CLAUDE_SPEND_OK: 'opus 5.5' },
    { ATRIS_RUNNER_MODEL: 'claude-fable-5', ATRIS_CLAUDE_SPEND_OK: 'claude-fable-5' },
    { ATRIS_RUNNER_BIN: 'codex', ATRIS_RUNNER_MODEL: 'claude-mystery-9' },
  ];
  for (const engine of ['claude', 'fable', 'haiku', 'codex']) {
    for (const env of cases) {
      let launched = '';
      withRunnerEnv({ ...env, ATRIS_RUNNER_PROFILE: engine }, () => {
        launched = buildRunnerCommand({ promptFile: '/tmp/p.tmp' });
      });
      const named = /--model (\S+)/.exec(launched);
      const said = launchFor(engine, { env });
      assert.equal(said.model, named ? named[1] : '', `${engine} with ${JSON.stringify(env)}: ${launched}`);
    }
  }
});

// ---------------------------------------------------------------------------
// launchFor and a command template somebody wrote (ATRIS_RUNNER_COMMAND_TEMPLATE, or the older
// ATRIS_CLAUDE_COMMAND_TEMPLATE). It can start anything with anything, so it is never read for its model: a model in
// it may be a flag, a word of the prompt, another command's, or one the shell works out only when it runs. launchFor
// says custom and carries no model, and a caller that has to judge the launch counts the model as one it cannot tell.

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const CUSTOM = { engine: 'claude', bin: 'claude', model: '', custom: true };

// A stand-in for the claude program that writes the arguments it was started with (NUL after each), so a test sees
// what the shell really hands a launch and holds launchFor's answer up against it.
function argvPrinter(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-for-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'argv.log');
  const bin = path.join(dir, 'claude');
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\0' "$@" > '${log}'\n`, { mode: 0o755 });
  fs.writeFileSync(prompt, `Fix the bug. Never pass --model ${OPUS} to anything.`);
  return {
    bin,
    prompt,
    argvOf(command) {
      fs.rmSync(log, { force: true });
      const run = spawnSync('bash', ['-c', command], { encoding: 'utf8', cwd: dir });
      assert.equal(run.status, 0, `${command}: ${run.stderr}`);
      const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      return text ? text.split('\0').slice(0, -1) : [];
    },
  };
}

// The command buildRunnerCommand makes for an engine in an environment, the way a launch makes it.
function launchCommand(engine, env, { promptFile = '/tmp/p.tmp', model } = {}) {
  let command = '';
  withRunnerEnv({ ...env, ATRIS_RUNNER_PROFILE: engine }, () => {
    command = buildRunnerCommand({ promptFile, model });
  });
  return command;
}

test('launchFor never reads a custom template for its model: it says custom and carries none', () => {
  const ask = (template, extra = {}) => launchFor('claude', { env: { ATRIS_RUNNER_COMMAND_TEMPLATE: template, ...extra } });
  // The shell works out this one's model when it runs, and it is Opus. The environment says Haiku.
  assert.deepEqual(ask('{bin} -p x --model $(printf %s op us)', { ANTHROPIC_MODEL: 'haiku' }), CUSTOM);
  // The word after -p is the prompt, not a model.
  assert.deepEqual(ask('{bin} -p {model}'), CUSTOM);
  // No model flag anywhere in it.
  assert.deepEqual(ask('{bin} -p {prompt}'), CUSTOM);
  // A model typed into it is no different: paid or Haiku, either spelling, in one command or several.
  for (const template of [
    `{bin} -p {prompt} --model ${HAIKU}`, `{bin} -p {prompt} --model=${OPUS}`, `{bin} -p {prompt} --model '${OPUS}'`,
    `{bin} -p {prompt} --model ${OPUS} {modelFlag}`, '{bin} {modelFlag} -p {prompt}', '{bin} -p {prompt} {pinnedModelFlag}',
    `{bin} -p {prompt}; echo --model ${HAIKU}`, `cd /tmp && {bin} -p {prompt} --model ${OPUS}`, '{bin} -p {prompt} --model "$MODEL"',
  ]) {
    assert.deepEqual(ask(template), CUSTOM, template);
  }
  // Nothing around it moves the answer: not the models the launch would have picked, not an approval, not a roster pick.
  const everywhere = { ATRIS_RUNNER_MODEL: OPUS, ATRIS_CLAUDE_MODEL: OPUS, ANTHROPIC_MODEL: OPUS, ATRIS_CLAUDE_SPEND_OK: OPUS };
  assert.deepEqual(ask(`{bin} -p {prompt} --model ${HAIKU}`, everywhere), CUSTOM);
  assert.deepEqual(launchFor('claude', { env: { ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} -p {prompt} {pinnedModelFlag}' }, model: OPUS }), CUSTOM);
  // The older variable is a custom template as well, and the program is still the one the launch names.
  assert.deepEqual(launchFor('claude', { env: { ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} -p {prompt}' } }), CUSTOM);
  assert.deepEqual(launchFor('fable', { env: { ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} -p {prompt}', ATRIS_RUNNER_BIN: '/opt/my tools/claude' } }),
    { engine: 'fable', bin: '/opt/my tools/claude', model: '', custom: true });
  // Every engine's launch is custom under a template that is not its own, whether or not it can take a claude model.
  for (const engine of [...RUNNER_PROFILE_NAMES, ...Object.keys(RUNNER_PROFILE_ALIASES), 'commandcode']) {
    const said = launchFor(engine, { env: { ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} --nothing-of-the-fleets {prompt}' } });
    assert.deepEqual([said.custom, said.model], [true, ''], engine);
  }
});

test('launchFor does not call a template custom when it is the engine\'s own: that is the fleet\'s launch like any other', () => {
  const ownEngines = Object.keys(RUNNER_PROFILE_DEFS).filter((engine) => RUNNER_PROFILE_DEFS[engine].commandTemplate);
  assert.ok(ownEngines.includes('codex') && ownEngines.includes('commandcode'));
  for (const engine of ownEngines) {
    const fleets = launchFor(engine, { env: {}, model: 'gpt-6.1-terra' });
    const typed = launchFor(engine, { env: { ATRIS_RUNNER_COMMAND_TEMPLATE: RUNNER_PROFILE_DEFS[engine].commandTemplate }, model: 'gpt-6.1-terra' });
    assert.deepEqual(typed, fleets, engine);
    assert.equal(typed.custom, undefined, engine);
  }
  // At the launch the engine's own template beats the older variable, so the older variable changes nothing for it.
  assert.deepEqual(launchFor('codex', { env: { ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} -p {prompt}' } }), launchFor('codex', { env: {} }));
  // Another engine's template is not this one's.
  assert.equal(launchFor('devin', { env: { ATRIS_RUNNER_COMMAND_TEMPLATE: RUNNER_PROFILE_DEFS.codex.commandTemplate } }).custom, true);
});

test('launchFor calls a launch custom exactly when the real launch is built from a template that is not the engine\'s own', () => {
  const MARK = '--nothing-of-the-fleets';
  const template = `{bin} ${MARK} {prompt}`;
  for (const engine of [...RUNNER_PROFILE_NAMES, ...Object.keys(RUNNER_PROFILE_ALIASES), 'commandcode']) {
    for (const variable of ['ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', null]) {
      const env = variable ? { [variable]: template } : {};
      const command = launchCommand(engine, env);
      assert.equal(Boolean(launchFor(engine, { env }).custom), command.includes(MARK), `${engine} ${variable}: ${command}`);
    }
  }
});

test('launchFor reads a template from the environment it is given, never from this process', () => {
  withRunnerEnv({ ATRIS_RUNNER_COMMAND_TEMPLATE: `{bin} -p {prompt} --model ${OPUS}` }, () => {
    assert.deepEqual(launchFor('claude', { env: {} }), { engine: 'claude', bin: 'claude', model: DEFAULT_CLAUDE_RUNNER_MODEL }, 'this process\'s template is not the environment asked about');
  });
  withRunnerEnv({}, () => {
    assert.deepEqual(launchFor('claude', { env: { ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} -p {prompt}' } }), CUSTOM, 'and the environment asked about is');
  });
});

test('launchFor agrees with the real launch for every engine and every spelling of it, with and without a pin', (t) => {
  const printer = argvPrinter(t);
  const names = [...RUNNER_PROFILE_NAMES, ...Object.keys(RUNNER_PROFILE_ALIASES), 'commandcode'];
  const cases = [
    { env: {}, model: undefined },
    { env: { ATRIS_RUNNER_MODEL: 'claude-mystery-9' }, model: undefined },
    { env: { ATRIS_CLAUDE_MODEL: 'claude-mystery-8' }, model: 'gpt-6.1-terra' },
    { env: { ATRIS_RUNNER_MODEL: OPUS }, model: OPUS },
    { env: { ATRIS_RUNNER_MODEL: OPUS, ATRIS_CLAUDE_SPEND_OK: OPUS }, model: OPUS },
    { env: { ATRIS_CLAUDE_SPEND_OK: DEFAULT_FABLE_RUNNER_MODEL }, model: undefined },
    { env: {}, model: 'gemini 3.8 flash' },
  ];
  for (const name of names) {
    for (const { env: extra, model } of cases) {
      const env = { ...extra, ATRIS_RUNNER_BIN: printer.bin };
      const argv = printer.argvOf(launchCommand(name, env, { promptFile: printer.prompt, model }));
      const said = launchFor(name, { env, model });
      assert.equal(said.model, modelFromArgv(argv), `${name} ${JSON.stringify(extra)} pin ${model}: started with ${JSON.stringify(argv)}`);
    }
  }
});
