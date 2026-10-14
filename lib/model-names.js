'use strict';

// Friendly model names to the ids each engine's cli accepts. This is the ONE
// table of spellings: engine-registry checks roster picks with it and
// runner-command normalizes launch models with it. "opus 5.5" is
// claude-opus-5-5, "grok 4.7 fast" is grok-4.7-build-fast. Kept free of
// requires so both files can load it without a circular dependency.

// Claude-family engines run through the claude CLI, which rejects loose
// spellings like "opus-5.5". Assign saves the id the CLI accepts, and every
// read normalizes again, so older saved picks and hand edits work too.
const CLAUDE_FAMILY_ENGINES = Object.freeze(['claude', 'fable', 'haiku']);
const CLAUDE_MODEL_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'default']);
// A retired model runs as its replacement, so a saved pick keeps working
// after the upgrade. Retiring the next one is one line here.
const RETIRED_CLAUDE_MODELS = Object.freeze({
  'claude-fable-5': 'claude-fable-5-1',
  'claude-haiku-4-5': 'claude-haiku-5-5',
  'claude-haiku-4-5-20251001': 'claude-haiku-5-5',
});
const CLAUDE_MODEL_SPELLING = /^(opus|sonnet|haiku|fable)[\s_-]*(\d+)(?:[\s._-]+(\d+))?$/;
const CLAUDE_LONG_CONTEXT = /\s*\[1m\]$/;

// Grok takes friendly names too: "grok 4.7 fast" is grok-4.7-build-fast and
// "grok 4.7" is grok-4.7. Any full grok- id passes through as typed.
const GROK_MODEL_SPELLING = /^grok[\s_-]*(\d+(?:\.\d+)?)(?:[\s_-]+(?:build[\s_-]+)?(fast))?$/;

function normalizeGrokModel(raw) {
  const match = GROK_MODEL_SPELLING.exec(raw.toLowerCase());
  if (match) return `grok-${match[1]}${match[2] ? '-build-fast' : ''}`;
  if (/^grok-[a-z0-9][a-z0-9._-]*$/i.test(raw)) return raw;
  throw new Error(`grok does not know the model "${raw}". use grok 4.7 fast, grok 4.7, or a full grok- id`);
}

// The model to run for a claude id: its replacement when it is retired,
// else the id as given. Keeps a "[1m]" tail.
function currentClaudeModel(value) {
  const raw = String(value || '').trim();
  const suffix = CLAUDE_LONG_CONTEXT.test(raw) ? '[1m]' : '';
  const base = raw.replace(CLAUDE_LONG_CONTEXT, '').trim();
  const next = RETIRED_CLAUDE_MODELS[base.toLowerCase()];
  return next ? `${next}${suffix}` : raw;
}

// The id the claude cli accepts for a display name typed with a space:
// "opus 5.5" is claude-opus-5-5, "fable 5.1" is claude-fable-5-1. A full id,
// a bare alias ("opus"), a "[1m]" tail and anything else pass through as given
// (a retired id still becomes its replacement).
const CLAUDE_DISPLAY_NAME = /^(opus|sonnet|haiku|fable)\s+(\d+)(?:\.(\d+))?$/i;

function claudeModelId(value) {
  const raw = String(value || '').trim();
  const suffix = CLAUDE_LONG_CONTEXT.test(raw) ? '[1m]' : '';
  const base = raw.replace(CLAUDE_LONG_CONTEXT, '').trim();
  const match = CLAUDE_DISPLAY_NAME.exec(base);
  if (!match) return currentClaudeModel(raw);
  return currentClaudeModel(`claude-${match[1].toLowerCase()}-${match[2]}${match[3] ? `-${match[3]}` : ''}${suffix}`);
}

// The retired models a roster file's text still names, by id or spelled
// out, each once, so the roster can say they were upgraded.
function retiredModelsNamed(text) {
  const found = [];
  for (const id of Object.keys(RETIRED_CLAUDE_MODELS)) {
    const [, family, major, minor] = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id) || [];
    if (!family) continue;
    const spelled = new RegExp(`\\b(?:claude[\\s_-]*)?${family}[\\s_-]*${major}[\\s._-]+${minor}(?![\\d.])`, 'i');
    const base = `claude-${family}-${major}-${minor}`;
    if (spelled.test(String(text || '')) && !found.includes(base)) found.push(base);
  }
  return found;
}

function normalizeRosterModel(engineId, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (engineId === 'grok') return normalizeGrokModel(raw);
  if (!CLAUDE_FAMILY_ENGINES.includes(engineId)) return raw;
  // "[1m]" asks the claude cli for the long context window; keep it on
  // whatever name it follows.
  const suffix = CLAUDE_LONG_CONTEXT.test(raw) ? '[1m]' : '';
  const base = raw.replace(CLAUDE_LONG_CONTEXT, '').trim();
  const lower = base.toLowerCase();
  if (CLAUDE_MODEL_ALIASES.includes(lower)) return `${lower}${suffix}`;
  const match = CLAUDE_MODEL_SPELLING.exec(lower.replace(/^claude[\s_-]*/, ''));
  if (match) {
    const id = `claude-${match[1]}-${match[2]}${match[3] ? `-${match[3]}` : ''}`;
    return currentClaudeModel(`${id}${suffix}`);
  }
  if (lower.startsWith('claude-')) return currentClaudeModel(`${base}${suffix}`);
  throw new Error(`${engineId} does not know the model "${raw}". use opus, sonnet, haiku, fable, opusplan, default, a version like opus 5.5, sonnet 5, haiku 5.5, or fable 5.1, or a full claude- id; add [1m] for the long context window`);
}

// A saved pick's model, normalized the same way assign does. null means the
// saved name is one the claude cli would reject, so the pick cannot run.
function savedRosterModel(engineId, value) {
  try {
    return normalizeRosterModel(engineId, value);
  } catch {
    return null;
  }
}

module.exports = {
  CLAUDE_FAMILY_ENGINES,
  CLAUDE_MODEL_ALIASES,
  RETIRED_CLAUDE_MODELS,
  CLAUDE_MODEL_SPELLING,
  CLAUDE_LONG_CONTEXT,
  GROK_MODEL_SPELLING,
  currentClaudeModel,
  claudeModelId,
  retiredModelsNamed,
  normalizeRosterModel,
  savedRosterModel,
};
