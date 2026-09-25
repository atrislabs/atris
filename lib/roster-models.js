'use strict';

// What model and effort each roster line really runs, and where each came
// from, so the roster view never shows an engine with a blank model. A pin
// on the line wins; with no pin, codex reads the top of its own settings
// file, claude-family engines run the atris default, and every other engine
// rides its own default. Nothing here spawns an engine or goes online.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  DEFAULT_CLAUDE_RUNNER_MODEL,
} = require('./runner-command');

const CLAUDE_FAMILY = Object.freeze(['claude', 'fable', 'haiku']);
const ATRIS_PINNED = Object.freeze(['atris-fast', 'composer']);

// ~/.codex/config.toml unless a path is given. Test runs never read the real
// file unless they point at one on purpose.
function codexConfigFile(options = {}) {
  if (options.codexConfigPath) return options.codexConfigPath;
  if (process.env.ATRIS_CODEX_CONFIG_PATH) return process.env.ATRIS_CODEX_CONFIG_PATH;
  if (process.env.NODE_TEST_CONTEXT) return '';
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}

// The top-level model and model_reasoning_effort, the lines before the first
// [section]. A tiny line reader, not a toml parser: anything else is ignored.
function readCodexSettings(options = {}) {
  const file = codexConfigFile(options);
  if (!file) return {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const settings = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const match = /^(model|model_reasoning_effort)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (match) settings[match[1]] = (match[2] !== undefined ? match[2] : match[3]).trim();
  }
  return settings;
}

// claude-opus-5-5 reads as "opus 5.5"; anything else as written.
function modelLabel(model) {
  const text = String(model || '').trim();
  const grok = /^grok-(\d+(?:\.\d+)?)(-build-fast)?$/.exec(text);
  if (grok) return `grok ${grok[1]}${grok[2] ? ' fast' : ''}`;
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(text);
  if (!match) return text;
  return `${match[1]} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

const SOURCE_TAIL = Object.freeze({ 'codex settings': 'from codex settings', 'atris default': 'atris default' });
const SOURCE_INLINE = Object.freeze({ 'codex settings': 'from codex settings', 'atris default': 'by atris default' });

// One engine's real model and effort. Sources: roster (pinned on the line),
// codex settings, atris default, or own default (the engine decides).
function engineRunsView(engineId, { model = '', effort = '' } = {}, options = {}) {
  const id = RUNNER_PROFILE_ALIASES[engineId] || engineId;
  const def = RUNNER_PROFILE_DEFS[id] || {};
  const view = { engine: id, model: '', model_source: 'own default', effort: '', effort_source: '' };
  if (model) {
    view.model = model;
    view.model_source = 'roster';
  } else if (id === 'codex') {
    const settings = readCodexSettings(options);
    if (settings.model) {
      view.model = settings.model;
      view.model_source = 'codex settings';
    }
  } else if (CLAUDE_FAMILY.includes(id)) {
    view.model = String(process.env.ATRIS_RUNNER_MODEL || '').trim() || def.model || DEFAULT_CLAUDE_RUNNER_MODEL;
    view.model_source = 'atris default';
  } else if (ATRIS_PINNED.includes(id) && def.model) {
    view.model = def.model;
    view.model_source = 'atris default';
  }
  if (effort) {
    view.effort = effort;
    view.effort_source = 'roster';
  } else if (id === 'codex') {
    const settings = readCodexSettings(options);
    if (settings.model_reasoning_effort) {
      view.effort = settings.model_reasoning_effort;
      view.effort_source = 'codex settings';
    }
  }
  view.text = `${id} (${runsDetail(view)})`;
  return view;
}

function runsDetail(view) {
  const items = [{ text: view.model ? modelLabel(view.model) : 'its own default', source: view.model ? view.model_source : 'roster' }];
  if (view.effort) items.push({ text: view.effort, source: view.effort_source });
  const sourced = [...new Set(items.map((item) => item.source).filter((source) => SOURCE_TAIL[source]))];
  // Every item shares one source: say it once at the end.
  if (sourced.length === 1 && items.every((item) => item.source === sourced[0])) {
    return [...items.map((item) => item.text), SOURCE_TAIL[sourced[0]]].join(', ');
  }
  return items.map((item) => (SOURCE_INLINE[item.source] ? `${item.text} ${SOURCE_INLINE[item.source]}` : item.text)).join(', ');
}

module.exports = {
  modelLabel,
  readCodexSettings,
  engineRunsView,
};
