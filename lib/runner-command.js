'use strict';

// Shared worker-spawn builder for the autonomous loops (missions, autopilot, run).
//
// Autonomous ticks must target a LIVE model. Inheriting the CLI's persisted
// selection is fragile: a *versioned* id (e.g. claude-fable-5) silently dies
// when that version is retired, and every tick then errors as a generic
// 'claude-error' with no clue why (lesson: retired-model-kills-loop-silently,
// CLI-245). Precedence: explicit model -> ATRIS_RUNNER_MODEL env ->
// ATRIS_RUNNER_PROFILE -> legacy ATRIS_CLAUDE_MODEL env -> 'opus' alias. The
// CLI resolves aliases to the latest live model, so an alias never retires out
// from under the loop.
const DEFAULT_RUNNER_MODEL = 'opus';
const DEFAULT_RUNNER_BIN = 'claude';
const DEFAULT_CLAUDE_RUNNER_MODEL = DEFAULT_RUNNER_MODEL;
const DEFAULT_CLAUDE_RUNNER_BIN = DEFAULT_RUNNER_BIN;
const RUNNER_PROFILES = Object.freeze({
  'atris-fast': Object.freeze({
    bin: 'ax',
    model: 'atris:fast',
    commandTemplate: '{bin} --fast {prompt}',
  }),
  'atris2-fast': Object.freeze({
    bin: 'ax',
    model: 'atris:fast',
    commandTemplate: '{bin} --fast {prompt}',
  }),
  'atris-2-fast': Object.freeze({
    bin: 'ax',
    model: 'atris:fast',
    commandTemplate: '{bin} --fast {prompt}',
  }),
});

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
    throw new Error(`Unknown ATRIS_RUNNER_PROFILE "${name}". Known profiles: ${Object.keys(RUNNER_PROFILES).join(', ')}`);
  }
  return profile;
}

function runnerProfileValue(key) {
  const profile = resolveRunnerProfile();
  return profile && profile[key] ? profile[key] : '';
}

function resolveRunnerModel(mission) {
  const explicit = mission && mission.model != null ? String(mission.model).trim() : '';
  if (explicit) return explicit;
  const env = firstConfiguredEnv(['ATRIS_RUNNER_MODEL']);
  if (env) return env;
  const profileModel = runnerProfileValue('model');
  if (profileModel) return profileModel;
  const legacyEnv = firstConfiguredEnv(['ATRIS_CLAUDE_MODEL']);
  if (legacyEnv) return legacyEnv;
  return DEFAULT_RUNNER_MODEL;
}

function resolveRunnerBin() {
  const env = firstConfiguredEnv(['ATRIS_RUNNER_BIN']);
  if (env) return env;
  const profileBin = runnerProfileValue('bin');
  if (profileBin) return profileBin;
  const legacyEnv = firstConfiguredEnv(['ATRIS_CLAUDE_BIN']);
  if (legacyEnv) return legacyEnv;
  return DEFAULT_RUNNER_BIN;
}

function resolveRunnerCommandTemplate() {
  const env = firstConfiguredEnv(['ATRIS_RUNNER_COMMAND_TEMPLATE']);
  if (env) return env;
  const profileTemplate = runnerProfileValue('commandTemplate');
  if (profileTemplate) return profileTemplate;
  return firstConfiguredEnv(['ATRIS_CLAUDE_COMMAND_TEMPLATE']);
}

const resolveClaudeRunnerModel = resolveRunnerModel;
const resolveClaudeRunnerBin = resolveRunnerBin;
const resolveClaudeRunnerCommandTemplate = resolveRunnerCommandTemplate;

function buildRunnerAvailabilityCommand() {
  return `command -v ${shellWord(resolveRunnerBin())}`;
}

function renderRunnerCommandTemplate(template, { promptFile, allowedTools, model }) {
  const allowedToolsFlag = allowedTools ? `--allowedTools ${shellWord(allowedTools)}` : '';
  const promptFileWord = shellWord(promptFile);
  const values = {
    bin: shellWord(resolveRunnerBin()),
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
// ALWAYS injected (resolved via resolveRunnerModel) so no spawn path can
// fall back to the CLI's mutable persisted selection. The default command shape
// remains Claude-compatible, but ATRIS_RUNNER_COMMAND_TEMPLATE can replace it
// for GLM/OpenAI/other local runners. The old ATRIS_CLAUDE_* env vars remain
// aliases for existing installs. allowedTools is optional: some call sites
// (e.g. horizon proposal) run without a tool allowlist.
function buildRunnerCommand({ promptFile, allowedTools, model } = {}) {
  if (!promptFile) {
    throw new Error('buildRunnerCommand: promptFile is required');
  }
  const resolved = resolveRunnerModel({ model });
  const template = resolveRunnerCommandTemplate();
  if (template) {
    return renderRunnerCommandTemplate(template, { promptFile, allowedTools, model: resolved });
  }
  const safePath = String(promptFile).replace(/'/g, "'\\''");
  let cmd = `${shellWord(resolveRunnerBin())} -p "$(cat '${safePath}')" --model ${shellWord(resolved)}`;
  if (allowedTools) {
    cmd += ` --allowedTools ${shellWord(allowedTools)}`;
  }
  return cmd;
}

module.exports = {
  DEFAULT_RUNNER_MODEL,
  DEFAULT_RUNNER_BIN,
  DEFAULT_CLAUDE_RUNNER_MODEL,
  DEFAULT_CLAUDE_RUNNER_BIN,
  RUNNER_PROFILES,
  resolveRunnerProfileName,
  resolveRunnerProfile,
  resolveRunnerModel,
  resolveRunnerBin,
  resolveRunnerCommandTemplate,
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  resolveClaudeRunnerCommandTemplate,
  buildRunnerAvailabilityCommand,
  buildRunnerCommand,
};
