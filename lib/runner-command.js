'use strict';

// Shared worker-spawn builder for the autonomous loops (missions, autopilot, run).
//
// Autonomous ticks must target a LIVE model. Inheriting the CLI's persisted
// selection is fragile: a *versioned* id (e.g. claude-fable-5) silently dies
// when that version is retired, and every tick then errors as a generic
// 'claude-error' with no clue why (lesson: retired-model-kills-loop-silently,
// CLI-245). Precedence: explicit model -> ATRIS_RUNNER_MODEL env -> legacy
// ATRIS_CLAUDE_MODEL env -> 'opus' alias. The CLI resolves aliases to the
// latest live model, so an alias never retires out from under the loop.
const DEFAULT_CLAUDE_RUNNER_MODEL = 'opus';
const DEFAULT_CLAUDE_RUNNER_BIN = 'claude';

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

function resolveClaudeRunnerModel(mission) {
  const explicit = mission && mission.model != null ? String(mission.model).trim() : '';
  if (explicit) return explicit;
  const env = firstConfiguredEnv(['ATRIS_RUNNER_MODEL', 'ATRIS_CLAUDE_MODEL']);
  if (env) return env;
  return DEFAULT_CLAUDE_RUNNER_MODEL;
}

function resolveClaudeRunnerBin() {
  const env = firstConfiguredEnv(['ATRIS_RUNNER_BIN', 'ATRIS_CLAUDE_BIN']);
  if (env) return env;
  return DEFAULT_CLAUDE_RUNNER_BIN;
}

function resolveClaudeRunnerCommandTemplate() {
  return firstConfiguredEnv(['ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_COMMAND_TEMPLATE']);
}

function buildRunnerAvailabilityCommand() {
  return `command -v ${shellWord(resolveClaudeRunnerBin())}`;
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
  resolveRunnerModel: resolveClaudeRunnerModel,
  resolveRunnerBin: resolveClaudeRunnerBin,
  resolveRunnerCommandTemplate: resolveClaudeRunnerCommandTemplate,
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  resolveClaudeRunnerCommandTemplate,
  buildRunnerAvailabilityCommand,
  buildRunnerCommand,
};
