'use strict';

// Shared worker-spawn builder for the autonomous loops (missions, autopilot, run).
//
// Autonomous ticks must target a LIVE model. Inheriting the CLI's persisted
// selection is fragile: the local Claude Code `opus` alias can resolve to
// different Opus releases across machines and account rollouts. Pin the default
// so autonomous runs are reproducible, while keeping explicit per-run/env knobs
// first in precedence. Precedence: explicit model -> ATRIS_RUNNER_MODEL env ->
// ATRIS_RUNNER_PROFILE -> legacy ATRIS_CLAUDE_MODEL env -> pinned default.
const DEFAULT_CLAUDE_RUNNER_MODEL = 'claude-opus-4-8';
const DEFAULT_CLAUDE_RUNNER_BIN = 'claude';

// Canonical runner profiles. Each entry is the config an operator would pick
// on purpose. Aliases (spelling variants of the same profile) resolve to the
// canonical config but are kept OUT of operator-facing lists so config errors
// stay honest: "one of: atris-fast", not three duplicate spellings.
const RUNNER_PROFILE_DEFS = Object.freeze({
  // House engine first: the default intelligence is our own.
  'atris-fast': Object.freeze({
    bin: 'ax',
    model: 'atris:fast',
    commandTemplate: '{bin} --fast {prompt}',
  }),
  // Guest engines: any installed headless coding CLI is a swappable worker.
  // No commandTemplate on claude — the default spawn shape is already
  // claude-compatible (bin -p prompt --model X --allowedTools ...).
  claude: Object.freeze({
    bin: 'claude',
    model: '',
    commandTemplate: '',
  }),
  codex: Object.freeze({
    bin: 'codex',
    model: '',
    commandTemplate: '{bin} exec {prompt}',
  }),
  cursor: Object.freeze({
    bin: 'cursor-agent',
    model: '',
    commandTemplate: '{bin} --trust -p {prompt}',
  }),
  devin: Object.freeze({
    bin: 'devin',
    model: '',
    commandTemplate: '{bin} -p -- {prompt}',
  }),
  hermes: Object.freeze({
    bin: 'hermes',
    model: '',
    commandTemplate: '{bin} -p -- {prompt}',
  }),
});

// Alias -> canonical profile name. Every alias resolves to the same config as
// its canonical target; adding a spelling variant here is a config change, not
// a duplicated profile body that can drift.
const RUNNER_PROFILE_ALIASES = Object.freeze({
  'atris2-fast': 'atris-fast',
  'atris-2-fast': 'atris-fast',
  'hermes-agent': 'hermes',
});

// Back-compat surface: RUNNER_PROFILES still resolves every accepted name
// (canonical + alias) to its frozen config, so existing lookups by any spelling
// keep working.
const RUNNER_PROFILES = Object.freeze(
  Object.fromEntries([
    ...Object.entries(RUNNER_PROFILE_DEFS),
    ...Object.entries(RUNNER_PROFILE_ALIASES).map(([alias, target]) => [alias, RUNNER_PROFILE_DEFS[target]]),
  ])
);

// Operator-facing list: canonical profile names only (no alias noise).
const RUNNER_PROFILE_NAMES = Object.freeze(Object.keys(RUNNER_PROFILE_DEFS));

function shellWord(value) {
  const s = String(value || '');
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function firstConfiguredEnv(names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function resolveRunnerProfileName() {
  return String(process.env.ATRIS_RUNNER_PROFILE || '').trim();
}

function resolveRunnerProfile() {
  const name = resolveRunnerProfileName();
  if (!name) return null;
  const profile = RUNNER_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown ATRIS_RUNNER_PROFILE "${name}". Known profiles: ${RUNNER_PROFILE_NAMES.join(', ')}`);
  }
  return profile;
}

function runnerProfileValue(key) {
  const profile = resolveRunnerProfile();
  return profile && profile[key] ? profile[key] : '';
}

function resolveClaudeRunnerModel(mission) {
  const explicit = mission && mission.model != null ? String(mission.model).trim() : '';
  if (explicit) return explicit;
  const env = firstConfiguredEnv(['ATRIS_RUNNER_MODEL']);
  if (env) return env;
  const profileModel = runnerProfileValue('model');
  if (profileModel) return profileModel;
  const legacyEnv = firstConfiguredEnv(['ATRIS_CLAUDE_MODEL']);
  if (legacyEnv) return legacyEnv;
  return DEFAULT_CLAUDE_RUNNER_MODEL;
}

function resolveClaudeRunnerBin() {
  const env = firstConfiguredEnv(['ATRIS_RUNNER_BIN']);
  if (env) return env;
  const profileBin = runnerProfileValue('bin');
  if (profileBin) return profileBin;
  const legacyEnv = firstConfiguredEnv(['ATRIS_CLAUDE_BIN']);
  if (legacyEnv) return legacyEnv;
  return DEFAULT_CLAUDE_RUNNER_BIN;
}

function resolveClaudeRunnerCommandTemplate() {
  const env = firstConfiguredEnv(['ATRIS_RUNNER_COMMAND_TEMPLATE']);
  if (env) return env;
  const profileTemplate = runnerProfileValue('commandTemplate');
  if (profileTemplate) return profileTemplate;
  return firstConfiguredEnv(['ATRIS_CLAUDE_COMMAND_TEMPLATE']);
}

function buildRunnerAvailabilityCommand() {
  return `command -v ${shellWord(resolveClaudeRunnerBin())}`;
}

function runnerAvailabilityFailureMessage(error) {
  const message = error && error.message ? String(error.message).trim() : '';
  if (message.startsWith('Unknown ATRIS_RUNNER_PROFILE')) {
    return `${message}. Set ATRIS_RUNNER_PROFILE to one of: ${RUNNER_PROFILE_NAMES.join(', ')}.`;
  }

  let runnerBin = 'configured runner';
  try {
    runnerBin = resolveClaudeRunnerBin();
  } catch {}
  return `${runnerBin} CLI not found. Set ATRIS_RUNNER_BIN (or legacy ATRIS_CLAUDE_BIN), or install the configured runner first.`;
}

function renderRunnerCommandTemplate(template, { promptFile, allowedTools, model }) {
  const allowedToolsFlag = allowedTools ? `--allowedTools ${shellWord(allowedTools)}` : '';
  const promptFileWord = shellWord(promptFile);
  const values = {
    bin: shellWord(resolveClaudeRunnerBin()),
    promptFile: promptFileWord,
    prompt: `"$(cat ${promptFileWord})"`,
    model: shellWord(model),
    modelFlag: `--model ${shellWord(model)}`,
    allowedTools: allowedTools ? shellWord(allowedTools) : '',
    allowedToolsFlag,
  };
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    return match;
  }).trim();
}

// Build the shell command that spawns one headless worker tick. `--model` is
// ALWAYS injected (resolved via resolveClaudeRunnerModel) so no spawn path can
// fall back to the CLI's mutable persisted selection. The default command shape
// remains Claude-compatible, but ATRIS_RUNNER_COMMAND_TEMPLATE can replace it
// for GLM/OpenAI/other local runners. The old ATRIS_CLAUDE_* env vars remain
// aliases for existing installs. allowedTools is optional: some call sites
// (e.g. horizon proposal) run without a tool allowlist.
function buildRunnerCommand({ promptFile, allowedTools, model } = {}) {
  if (!promptFile) {
    throw new Error('buildRunnerCommand: promptFile is required');
  }
  const resolved = resolveClaudeRunnerModel({ model });
  const template = resolveClaudeRunnerCommandTemplate();
  if (template) {
    return renderRunnerCommandTemplate(template, { promptFile, allowedTools, model: resolved });
  }
  const safePath = String(promptFile).replace(/'/g, "'\\''");
  let cmd = `${shellWord(resolveClaudeRunnerBin())} -p "$(cat '${safePath}')" --model ${shellWord(resolved)}`;
  if (allowedTools) {
    cmd += ` --allowedTools ${shellWord(allowedTools)}`;
  }
  return cmd;
}

module.exports = {
  DEFAULT_CLAUDE_RUNNER_MODEL,
  DEFAULT_CLAUDE_RUNNER_BIN,
  RUNNER_PROFILES,
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
  resolveRunnerProfileName,
  resolveRunnerProfile,
  resolveRunnerModel: resolveClaudeRunnerModel,
  resolveRunnerBin: resolveClaudeRunnerBin,
  resolveRunnerCommandTemplate: resolveClaudeRunnerCommandTemplate,
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  resolveClaudeRunnerCommandTemplate,
  buildRunnerAvailabilityCommand,
  runnerAvailabilityFailureMessage,
  buildRunnerCommand,
};
