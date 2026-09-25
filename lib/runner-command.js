'use strict';

// Shared worker-spawn builder for the autonomous loops (missions, autopilot, run).
//
// Autonomous ticks must target a LIVE model. Inheriting the CLI's persisted
// selection is fragile: the local Claude Code `opus` alias can resolve to
// different Opus releases across machines and account rollouts. Pin the default
// so autonomous runs are reproducible, while keeping explicit per-run/env knobs
// first in precedence. Precedence: explicit model -> ATRIS_RUNNER_MODEL env ->
// ATRIS_RUNNER_PROFILE -> legacy ATRIS_CLAUDE_MODEL env -> pinned default.
const DEFAULT_CLAUDE_RUNNER_MODEL = 'claude-opus-5-5';
const DEFAULT_FABLE_RUNNER_MODEL = 'claude-fable-5';
const DEFAULT_CLAUDE_RUNNER_BIN = 'claude';
// Effort words a roster line may carry after the model. Each engine lists the
// ones its CLI takes; an engine with no list takes none.
const EFFORT_WORDS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EFFORTS = EFFORT_WORDS;

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
  // No commandTemplate on claude, the default spawn shape is already
  // claude-compatible (bin -p prompt --model X --allowedTools ...).
  claude: Object.freeze({
    bin: 'claude',
    model: '',
    commandTemplate: '',
    effortFlag: '--effort',
    efforts: CLAUDE_EFFORTS,
  }),
  // No -m or effort unless the roster pins one: codex then reads its own
  // ~/.codex/config.toml, which is what the roster view reports.
  codex: Object.freeze({
    bin: 'codex',
    model: '',
    commandTemplate: '{bin} exec {pinnedModelFlag} {pinnedEffortFlag} {prompt}',
    effortFlag: '-c model_reasoning_effort=',
    efforts: Object.freeze(['low', 'medium', 'high', 'xhigh']),
  }),
  // cursor-agent takes effort only inside a bracketed model name some models
  // accept, so a roster effort on cursor is refused rather than guessed.
  cursor: Object.freeze({
    bin: 'cursor-agent',
    model: '',
    commandTemplate: '{bin} --trust {pinnedModelFlag} -p {prompt}',
  }),
  // Fable is a distinct Claude Code model, not a friendly name for whatever
  // Claude model happens to be selected locally.
  fable: Object.freeze({
    bin: 'claude',
    model: DEFAULT_FABLE_RUNNER_MODEL,
    commandTemplate: '',
    effortFlag: '--effort',
    efforts: CLAUDE_EFFORTS,
  }),
  composer: Object.freeze({
    bin: 'ax',
    model: 'composer-2-5-fast',
    commandTemplate: '{bin} --fast {prompt}',
  }),
  haiku: Object.freeze({
    bin: 'claude',
    model: 'claude-haiku-4-5',
    commandTemplate: '',
    effortFlag: '--effort',
    efforts: CLAUDE_EFFORTS,
  }),
  // Every engine with a model flag takes --model only when one is pinned (a
  // roster pick or a mission model); otherwise it rides its own CLI default.
  // {pinnedModelFlag} and {pinnedEffortFlag} render to nothing when unpinned.
  // devin has no effort flag, so a roster effort on devin is refused.
  devin: Object.freeze({
    bin: 'devin',
    model: '',
    commandTemplate: '{bin} -p {pinnedModelFlag} -- {prompt}',
  }),
  // No hard pin: a pinned grok-4.6 went stale when the grok CLI moved its
  // own default to grok-4.7-build-fast, so an unpinned run rides the CLI.
  grok: Object.freeze({
    bin: 'grok',
    model: '',
    commandTemplate: '{bin} --always-approve {pinnedModelFlag} {pinnedEffortFlag} -p {prompt}',
    effortFlag: '--reasoning-effort',
    efforts: Object.freeze(['low', 'medium', 'high']),
  }),
  agy: Object.freeze({
    bin: 'agy',
    // No hard pin: the agy CLI keeps its own session model, so an unpinned
    // run rides that and a roster line names gemini 3.8 flash (the 2026-09-04
    // bake-off pick) when it wants it. --add-dir or agy edits its own scratch
    // folder; the headless note or gemini stops to ask "may I edit?" and
    // exits 0 having changed nothing.
    model: '',
    commandTemplate: '{bin} --mode accept-edits --dangerously-skip-permissions --add-dir "$PWD" {pinnedModelFlag} {pinnedEffortFlag} -p "You are running headless with edit permission already granted. Apply changes directly and never ask for confirmation. "{prompt}',
    effortFlag: '--effort',
    efforts: Object.freeze(['low', 'medium', 'high']),
  }),
  // opencode names models provider/model; --variant is its effort knob.
  opencode: Object.freeze({
    bin: 'opencode',
    model: '',
    commandTemplate: '{bin} run {pinnedModelFlag} {pinnedEffortFlag} {prompt}',
    effortFlag: '--variant',
    efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  }),
  // Private engine: fully functional (routable, selectable, probeable) but
  // kept out of every operator-facing list. For engines an operator wants to
  // use without advertising them on the roster. No pinned model: headless
  // print mode rides whatever this machine's Command Code default is.
  commandcode: Object.freeze({
    bin: 'cmd',
    model: '',
    commandTemplate: '{bin} -p {prompt}',
    hidden: true,
  }),
});

// Alias -> canonical profile name. Every alias resolves to the same config as
// its canonical target; adding a spelling variant here is a config change, not
// a duplicated profile body that can drift.
const RUNNER_PROFILE_ALIASES = Object.freeze({
  'atris2-fast': 'atris-fast',
  'atris-2-fast': 'atris-fast',
  antigravity: 'agy',
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

// Operator-facing list: canonical profile names only (no alias noise), and no
// hidden profiles. Hidden profiles stay resolvable through RUNNER_PROFILES and
// canonicalEngineName; they just never appear in help text, error hints, or
// rosters.
const HIDDEN_PROFILE_NAMES = Object.freeze(
  Object.entries(RUNNER_PROFILE_DEFS)
    .filter(([, def]) => def.hidden === true)
    .map(([name]) => name)
);

const RUNNER_PROFILE_NAMES = Object.freeze(
  Object.keys(RUNNER_PROFILE_DEFS).filter((name) => !HIDDEN_PROFILE_NAMES.includes(name))
);

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

// The model chosen for this launch: an explicit model (a roster pick, a
// mission model) or the profile's own pin. ATRIS_RUNNER_MODEL is left out on
// purpose: it usually names a claude model, which devin or grok would reject.
// '' means nothing is pinned, so the engine's CLI picks its own default.
function resolvePinnedRunnerModel(mission) {
  const explicit = mission && mission.model != null ? String(mission.model).trim() : '';
  return explicit || runnerProfileValue('model');
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

// The effort flag for the active profile, or '' when no effort is pinned.
// Throws a plain sentence when the engine cannot take that effort, so a bad
// pin never launches silently at the wrong effort.
function runnerEffortFlag(effort) {
  const word = String(effort || '').trim().toLowerCase();
  if (!word) return '';
  const profile = resolveRunnerProfile();
  const flag = profile ? profile.effortFlag : RUNNER_PROFILE_DEFS.claude.effortFlag;
  const allowed = profile ? profile.efforts : RUNNER_PROFILE_DEFS.claude.efforts;
  const name = resolveRunnerProfileName() || 'claude';
  if (!flag || !allowed || !allowed.includes(word)) throw new Error(`${name} cannot take the effort "${word}"`);
  return flag.endsWith('=') ? `${flag}${word}` : `${flag} ${word}`;
}

function renderRunnerCommandTemplate(template, { promptFile, allowedTools, model, pinnedModel = '', effort = '' }) {
  const allowedToolsFlag = allowedTools ? `--allowedTools ${shellWord(allowedTools)}` : '';
  // The pinned flags take their leading space with them, so an unpinned
  // launch reads exactly like the template without the placeholders.
  template = template.replace(/\s*\{pinnedModelFlag\}/g, pinnedModel ? ` --model ${shellWord(pinnedModel)}` : '');
  // Checked even when the template has no slot, so an engine that cannot
  // take effort refuses instead of running at its default.
  const effortFlag = runnerEffortFlag(effort);
  template = template.replace(/\s*\{pinnedEffortFlag\}/g, effortFlag ? ` ${effortFlag}` : '');
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
function buildRunnerCommand({ promptFile, allowedTools, model, effort } = {}) {
  if (!promptFile) {
    throw new Error('buildRunnerCommand: promptFile is required');
  }
  const resolved = resolveClaudeRunnerModel({ model });
  const template = resolveClaudeRunnerCommandTemplate();
  if (template) {
    return renderRunnerCommandTemplate(template, { promptFile, allowedTools, model: resolved, pinnedModel: resolvePinnedRunnerModel({ model }), effort });
  }
  const safePath = String(promptFile).replace(/'/g, "'\\''");
  let cmd = `${shellWord(resolveClaudeRunnerBin())} -p "$(cat '${safePath}')" --model ${shellWord(resolved)}`;
  const effortFlag = runnerEffortFlag(effort);
  if (effortFlag) cmd += ` ${effortFlag}`;
  if (allowedTools) {
    cmd += ` --allowedTools ${shellWord(allowedTools)}`;
  }
  return cmd;
}

// Whether this engine's launch can carry a pinned model, and which effort
// words it takes. The roster checks both when it reads a line.
function engineTakesModel(engineId) {
  const def = RUNNER_PROFILE_DEFS[RUNNER_PROFILE_ALIASES[engineId] || engineId];
  if (!def) return false;
  return !def.commandTemplate || def.commandTemplate.includes('{pinnedModelFlag}');
}

function engineEffortLevels(engineId) {
  const def = RUNNER_PROFILE_DEFS[RUNNER_PROFILE_ALIASES[engineId] || engineId];
  return def && def.efforts ? def.efforts : [];
}

module.exports = {
  EFFORT_WORDS,
  engineTakesModel,
  engineEffortLevels,
  DEFAULT_CLAUDE_RUNNER_MODEL,
  DEFAULT_FABLE_RUNNER_MODEL,
  DEFAULT_CLAUDE_RUNNER_BIN,
  RUNNER_PROFILES,
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
  HIDDEN_PROFILE_NAMES,
  resolveRunnerProfile,
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  resolveClaudeRunnerCommandTemplate,
  buildRunnerAvailabilityCommand,
  runnerAvailabilityFailureMessage,
  buildRunnerCommand,
};
