'use strict';

// Shared worker-spawn builder for the autonomous loops (missions, autopilot, run).
//
// Autonomous ticks must target a LIVE model. Inheriting the CLI's persisted
// selection is fragile: the local Claude Code `opus` alias can resolve to
// different Opus releases across machines and account rollouts. Pin the default
// so autonomous runs are reproducible, while keeping explicit per-run/env knobs
// first in precedence. Precedence: explicit model -> ATRIS_RUNNER_MODEL env ->
// ATRIS_RUNNER_PROFILE -> legacy ATRIS_CLAUDE_MODEL env -> pinned default.
// The default is the cheap model: an unattended loop must never land on a
// costly one by accident (2026-10-28: loops spent about $900 in one day).
// Opus, Fable and Sonnet run unattended only through the spend gate below.
const DEFAULT_CLAUDE_RUNNER_MODEL = 'claude-haiku-5-5';
const DEFAULT_FABLE_RUNNER_MODEL = 'claude-fable-5-1';
const DEFAULT_CLAUDE_RUNNER_BIN = 'claude';
// Effort words a roster line may carry after the model. Each engine lists the
// ones its CLI takes; an engine with no list takes none.
const EFFORT_WORDS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EFFORTS = EFFORT_WORDS;

// The one model-name table lives in model-names.js, shared with
// engine-registry. Friendly names become the ids the claude cli accepts;
// anything it does not know passes through unchanged (runners like glm and
// swe name their own models here, so this never throws).
const { claudeModelId, currentClaudeModel, normalizeRosterModel } = require('./model-names');

function normalizeClaudeModelName(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    return normalizeRosterModel('claude', trimmed);
  } catch {
    return trimmed;
  }
}

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
  mercury: Object.freeze({
    bin: 'ax',
    model: 'inception:mercury-3-preview-1002',
    commandTemplate: '{bin} --mercury {prompt}',
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
  // ~/.codex/config.toml, which is what the roster view reports. Codex runs
  // only OpenAI models, so a claude model name never reaches it.
  codex: Object.freeze({
    bin: 'codex',
    model: '',
    ownModelsOnly: true,
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
    model: 'claude-haiku-5-5',
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
  // Grok runs only xAI models, so a claude model name never reaches it.
  grok: Object.freeze({
    bin: 'grok',
    model: '',
    ownModelsOnly: true,
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

// Every reader below takes the environment it reads from and defaults to this process's. A launch is built in
// this process, so it reads process.env; a caller that wants to know what a launch would carry (launchFor) hands
// in the environment the launch would be built in, and nothing here looks at this process then.
function firstConfiguredEnv(names, env = process.env) {
  for (const name of names) {
    const value = String(env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function resolveRunnerProfileName(env = process.env) {
  return String(env.ATRIS_RUNNER_PROFILE || '').trim();
}

function resolveRunnerProfile(env = process.env) {
  const name = resolveRunnerProfileName(env);
  if (!name) return null;
  const profile = RUNNER_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown ATRIS_RUNNER_PROFILE "${name}". Known profiles: ${RUNNER_PROFILE_NAMES.join(', ')}`);
  }
  return profile;
}

function runnerProfileValue(key, env = process.env) {
  const profile = resolveRunnerProfile(env);
  return profile && profile[key] ? profile[key] : '';
}

// The spend gate. Every model an unattended run is about to launch passes
// through here. Opus, Fable and Sonnet need the owner's yes, given as
// ATRIS_CLAUDE_SPEND_OK=<that exact model id>, so one yes covers one model. Without
// it the run drops to the cheap model, which keeps loops alive but stops the
// spend. The warning prints once per model per process.
const SPEND_GATED_MODEL = /opus|fable|sonnet/i;
const SPEND_FALLBACK_MODEL = DEFAULT_CLAUDE_RUNNER_MODEL;
const spendGateWarned = new Set();

function isSpendGatedModel(model) {
  return SPEND_GATED_MODEL.test(String(model || ''));
}

// `fallback` is the model to run instead. An engine that is not the claude cli
// cannot take a claude model id, so it passes '' and rides its own default.
function applySpendGate(model, { silent = false, fallback = SPEND_FALLBACK_MODEL, env = process.env } = {}) {
  const value = String(model || '').trim();
  if (!value || !isSpendGatedModel(value)) return value;
  if (String(env.ATRIS_CLAUDE_SPEND_OK || '').trim() === value) return value;
  if (!silent && !spendGateWarned.has(`${value}>${fallback}`)) {
    spendGateWarned.add(`${value}>${fallback}`);
    const instead = fallback || "that engine's own default model";
    process.stderr.write(`atris: unattended run on ${value} needs the owner's yes; running on ${instead}. To allow it for this run: ATRIS_CLAUDE_SPEND_OK=${value}\n`);
  }
  return fallback;
}

function resetSpendGateWarnings() {
  spendGateWarned.clear();
}

// Engines that run only their own vendor's models drop any claude model name
// later, so the gate has nothing to stop there and stays quiet.
function runnerDropsClaudeModels(env = process.env) {
  const name = resolveRunnerProfileName(env);
  const def = name ? RUNNER_PROFILE_DEFS[RUNNER_PROFILE_ALIASES[name] || name] : null;
  if (def && def.ownModelsOnly) return true;
  return Boolean(ownModelsOnlyEngineForBin(resolveClaudeRunnerBin(env)));
}

// Whether the launch goes through the claude cli, the only engine that can take
// the cheap claude fallback by name.
function runnerRidesClaudeCli(env = process.env) {
  const name = resolveRunnerProfileName(env);
  const canonical = name ? (RUNNER_PROFILE_ALIASES[name] || name) : '';
  return !canonical || canonical === 'claude' || canonical === 'fable' || canonical === 'haiku';
}

// The choke point: every unattended Claude launch (mission, autopilot, run,
// pulse, fleet) resolves its model here, directly or via buildRunnerCommand.
function resolveClaudeRunnerModel(mission, { env = process.env, silent = false } = {}) {
  const model = resolveClaudeRunnerModelUngated(mission, env);
  if (!isSpendGatedModel(model) || runnerDropsClaudeModels(env)) return model;
  return applySpendGate(model, { fallback: runnerRidesClaudeCli(env) ? SPEND_FALLBACK_MODEL : '', env, silent });
}

function resolveClaudeRunnerModelUngated(mission, env = process.env) {
  const explicit = mission && mission.model != null ? normalizeClaudeModelName(mission.model) : '';
  if (explicit) return explicit;
  const fromEnv = normalizeClaudeModelName(firstConfiguredEnv(['ATRIS_RUNNER_MODEL'], env));
  if (fromEnv) return fromEnv;
  const profileModel = normalizeClaudeModelName(runnerProfileValue('model', env));
  if (profileModel) return profileModel;
  const legacyEnv = normalizeClaudeModelName(firstConfiguredEnv(['ATRIS_CLAUDE_MODEL'], env));
  if (legacyEnv) return legacyEnv;
  return DEFAULT_CLAUDE_RUNNER_MODEL;
}

// The model chosen for this launch: an explicit model (a roster pick, a
// mission model) or the profile's own pin. ATRIS_RUNNER_MODEL is left out on
// purpose: it usually names a claude model, which devin or grok would reject.
// '' means nothing is pinned, so the engine's CLI picks its own default.
function resolvePinnedRunnerModel(mission, { env = process.env, silent = false } = {}) {
  const explicit = mission && mission.model != null ? String(mission.model).trim() : '';
  const pinned = explicit || runnerProfileValue('model', env);
  // Cheap check first: an ungated pin never needs the profile looked up.
  if (!isSpendGatedModel(pinned) || runnerDropsClaudeModels(env)) return pinned;
  return applySpendGate(pinned, { fallback: runnerRidesClaudeCli(env) ? SPEND_FALLBACK_MODEL : '', env, silent });
}

// The own-models-only engine a runner bin launches ("codex", "/opt/bin/grok"),
// or '' when the program is not one of them.
function ownModelsOnlyEngineForBin(bin) {
  const name = String(bin || '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
  if (!name) return '';
  return Object.keys(RUNNER_PROFILE_DEFS).find((id) => {
    const def = RUNNER_PROFILE_DEFS[id];
    return def.ownModelsOnly && def.bin === name;
  }) || '';
}

// The model an engine is launched with. An engine that runs only its own
// vendor's models drops a claude model name (a mission's stored default, a
// claude env pin) and rides its own default instead.
function runnerModelFor(engineId, model) {
  // Required here, not at the top: engine-registry requires this file.
  const { isClaudeFamilyModel } = require('./engine-registry');
  const name = String(engineId || '').trim().toLowerCase();
  // A display name like "opus 5.5" only becomes an id for the claude cli (or
  // an unnamed engine). Any other engine's model name is handed over as is.
  const canonical = RUNNER_PROFILE_ALIASES[name] || name;
  const claudeCli = !canonical || canonical === 'claude' || canonical === 'fable' || canonical === 'haiku';
  const value = claudeCli ? claudeModelId(String(model || '').trim()) : currentClaudeModel(String(model || '').trim());
  const def = RUNNER_PROFILE_DEFS[RUNNER_PROFILE_ALIASES[name] || name];
  if (!value || !def || !def.ownModelsOnly) return value;
  return isClaudeFamilyModel(value) ? '' : value;
}

function resolveClaudeRunnerBin(env = process.env) {
  const fromEnv = firstConfiguredEnv(['ATRIS_RUNNER_BIN'], env);
  if (fromEnv) return fromEnv;
  const profileBin = runnerProfileValue('bin', env);
  if (profileBin) return profileBin;
  const legacyEnv = firstConfiguredEnv(['ATRIS_CLAUDE_BIN'], env);
  if (legacyEnv) return legacyEnv;
  return DEFAULT_CLAUDE_RUNNER_BIN;
}

function resolveClaudeRunnerCommandTemplate(env = process.env) {
  const fromEnv = firstConfiguredEnv(['ATRIS_RUNNER_COMMAND_TEMPLATE'], env);
  if (fromEnv) return fromEnv;
  const profileTemplate = runnerProfileValue('commandTemplate', env);
  if (profileTemplate) return profileTemplate;
  return firstConfiguredEnv(['ATRIS_CLAUDE_COMMAND_TEMPLATE'], env);
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
  // A model dropped for an engine that cannot run it leaves no gap either,
  // and a literal "--model {model}", "-m{model}" or a quoted "{model}" goes
  // with it, quotes and all.
  if (!model) {
    template = template
      .replace(/\s*\{modelFlag\}/g, '')
      .replace(/\s*(?:--model|-m)(?:\s+|=)?(["']?)\{model\}\1/g, '');
  }
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
  // Both the profile and the program that actually runs count: a runner bin
  // named codex or grok (or a path ending in one) is that engine under any
  // profile, with or without a template.
  const profile = resolveRunnerProfileName();
  const binEngine = ownModelsOnlyEngineForBin(resolveClaudeRunnerBin());
  // The second pass only matters for an own-models-only program; skipping it
  // otherwise keeps a name that is not the claude cli's from being read as one.
  const modelFor = (value) => {
    const forProfile = runnerModelFor(profile, value);
    return binEngine ? runnerModelFor(binEngine, forProfile) : forProfile;
  };
  if (template) {
    return renderRunnerCommandTemplate(template, {
      promptFile,
      allowedTools,
      model: modelFor(resolved),
      pinnedModel: modelFor(resolvePinnedRunnerModel({ model })),
      effort,
    });
  }
  const safePath = String(promptFile).replace(/'/g, "'\\''");
  const launchModel = modelFor(resolved);
  let cmd = `${shellWord(resolveClaudeRunnerBin())} -p "$(cat '${safePath}')"`;
  if (launchModel) cmd += ` --model ${shellWord(launchModel)}`;
  const effortFlag = runnerEffortFlag(effort);
  if (effortFlag) cmd += ` ${effortFlag}`;
  if (allowedTools) {
    cmd += ` --allowedTools ${shellWord(allowedTools)}`;
  }
  return cmd;
}

// What the launch of one engine would carry, decided from `env` (this process's by default) and without launching
// anything or saying anything: { engine, bin, model }, or null for an engine nobody knows. `model` is the pin a
// caller would hand buildRunnerCommand (a roster pick). The model is the --model of the command buildRunnerCommand
// builds for this engine under ATRIS_RUNNER_PROFILE=<engine>, the way the fleet builds it: the same precedence,
// the same spend gate, and a claude model dropped by an engine that cannot take one. '' means the launch carries
// none. A caller that must judge the launch (the builder picker asks the Claude spend guard about it) asks here
// and never works the model out for itself.
//
// Only the fleet's own launch is read. A command template somebody wrote (ATRIS_RUNNER_COMMAND_TEMPLATE, or the
// older ATRIS_CLAUDE_COMMAND_TEMPLATE) can start anything with anything: a model in it may be a flag, a word of the
// prompt, another command's, or one the shell works out only when it runs. It is never read for its model. The
// answer is { engine, bin, model: '', custom: true }, and a caller that has to judge it counts the model as one it
// cannot tell. A template that is the engine's own is the fleet's launch like any other.
function launchFor(engineId, { env = process.env, model } = {}) {
  const asked = String(engineId || '').trim().toLowerCase();
  const name = RUNNER_PROFILE_ALIASES[asked] || asked;
  if (!name || !RUNNER_PROFILE_DEFS[name]) return null;
  const scoped = { ...env, ATRIS_RUNNER_PROFILE: name };
  const bin = resolveClaudeRunnerBin(scoped);
  const template = resolveClaudeRunnerCommandTemplate(scoped);
  if (template && template !== runnerProfileValue('commandTemplate', scoped)) {
    return { engine: name, bin, model: '', custom: true };
  }
  const mission = { model };
  const binEngine = ownModelsOnlyEngineForBin(bin);
  const modelFor = (value) => {
    const forProfile = runnerModelFor(name, value);
    return binEngine ? runnerModelFor(binEngine, forProfile) : forProfile;
  };
  const hasModelSlot = !template || /\{(?:model|modelFlag)\}/.test(template);
  const hasPinSlot = Boolean(template) && /\{pinnedModelFlag\}/.test(template);
  const resolved = hasModelSlot ? resolveClaudeRunnerModel(mission, { env: scoped, silent: true }) : '';
  const pinned = hasPinSlot ? resolvePinnedRunnerModel(mission, { env: scoped, silent: true }) : '';
  return { engine: name, bin, model: modelFor(hasModelSlot ? resolved : pinned) };
}

// Whether the installed codex prints JSONL events and can write its final
// answer to a file. Asked once per program; an older codex without the flags
// keeps today's plain launch.
const codexJsonSupport = new Map();
function codexSupportsJsonEvents(bin) {
  if (codexJsonSupport.has(bin)) return codexJsonSupport.get(bin);
  let supported = false;
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync(bin, ['exec', '--help'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    const help = `${res.stdout || ''}${res.stderr || ''}`;
    supported = res.status === 0 && /--json\b/.test(help) && /--output-last-message\b/.test(help);
  } catch {}
  codexJsonSupport.set(bin, supported);
  return supported;
}

// The codex launch with live JSONL events on stdout and the final answer in
// lastMessageFile, or null when this runner is not a codex exec that takes them.
function codexJsonEventsCommand(cmd, lastMessageFile) {
  const bin = resolveClaudeRunnerBin();
  if (ownModelsOnlyEngineForBin(bin) !== 'codex') return null;
  const lead = `${shellWord(bin)} exec`;
  if (!String(cmd).startsWith(`${lead} `)) return null;
  if (!codexSupportsJsonEvents(bin)) return null;
  return `${lead} --json --output-last-message ${shellWord(lastMessageFile)}${cmd.slice(lead.length)}`;
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
  codexJsonEventsCommand,
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
  applySpendGate,
  resetSpendGateWarnings,
  resolvePinnedRunnerModel,
  runnerModelFor,
  resolveClaudeRunnerBin,
  resolveClaudeRunnerCommandTemplate,
  buildRunnerAvailabilityCommand,
  runnerAvailabilityFailureMessage,
  buildRunnerCommand,
  launchFor,
};
