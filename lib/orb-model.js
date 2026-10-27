'use strict';

// Which model the orb thinks with, one pick per workspace.
//
// The pick is saved in <workspace>/.atris/state/orb-model.json as a tool
// (an engine in the registry) and a model on it, so it survives a restart
// and anything that knows the folder can read it (the desktop app, the
// phone page's /model, `atris gm phone model --json`). With no file the orb
// thinks on claude opus, the way it always has.
//
// What is offered is built from the engine registry and each tool's own
// models: every tool the registry says runs on this computer (never a hosted
// one, never grok) that its own status command says is signed in with a
// subscription, and every model that tool offers. Claude's models come from
// the names the claude program takes, codex's from codex's own model list,
// the rest from the registry. A tool with no login check atris knows is not
// offered, since nothing can say it is signed in.
//
// The pick goes first; when it fails or never answers, the orb's lineup
// (lib/gm-bet.js think) moves on to the next model signed in here.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const SCHEMA = 'atris.orb_model.v1';
const DEFAULT_PICK = Object.freeze({ engine: 'claude', model: 'opus' });

// tools and models the orb never thinks on: grok bills a paid balance
const NEVER_ENGINES = new Set(['grok']);
const NEVER_MODEL = /grok/i;
// the claude program runs all three; the orb offers them as one tool
const CLAUDE_FAMILY = new Set(['claude', 'fable', 'haiku']);
// the claude program's own short names, offered first
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];
// codex models that are not for talking to (its own review model)
const CODEX_SKIP = /auto-review/i;
// short names a person types at the terminal for one model
const SHORT_NAMES = Object.freeze({ terra: { engine: 'codex', model: 'gpt-5.6-terra' }, sol: { engine: 'codex', model: 'gpt-5.6-sol' } });

// The word each tool goes by on the page.
const TOOL_WORDS = Object.freeze({ claude: 'claude', codex: 'codex', cursor: 'cursor', devin: 'devin', agy: 'antigravity', opencode: 'opencode', commandcode: 'command code' });
const toolWord = engine => TOOL_WORDS[engine] || engine;

// Signed in, by each tool's own status command, run with no api key in its
// environment. ok reads the answer; only a subscription login counts.
const LOGIN_CHECKS = Object.freeze({
  claude: { args: ['auth', 'status'], ok: (out) => {
    try {
      const s = JSON.parse(out);
      return s.loggedIn === true && !/api/i.test(String(s.authMethod || ''));
    } catch {
      return false;
    }
  } },
  codex: { args: ['login', 'status'], ok: out => /logged in using chatgpt/i.test(out) },
  cursor: { args: ['status'], ok: out => /logged in/i.test(out) && !/api key/i.test(out) },
  devin: { args: ['auth', 'status'], ok: out => /logged in/i.test(out) && !/api key/i.test(out) },
  // agy lists its models only for a signed-in account
  agy: { args: ['models'], ok: out => /^\S+\t/m.test(out) },
});

function keyFor(engine, model) {
  return `${engine}:${model || ''}`;
}

function orbModelFile(root) {
  return path.join(path.resolve(String(root || '.')), '.atris', 'state', 'orb-model.json');
}

// The saved pick, { engine, model }, or null when none is saved or the file
// does not name a tool and a model the orb could think with.
function readSavedPick(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(orbModelFile(root), 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.engine !== 'string' || !raw.engine) return null;
    const model = typeof raw.model === 'string' ? raw.model : '';
    if (NEVER_ENGINES.has(raw.engine) || NEVER_MODEL.test(model) || /[^\w.:/[\] -]/.test(`${raw.engine}${model}`)) return null;
    return { engine: raw.engine, model };
  } catch {
    return null;
  }
}

// The pick the orb leads with: the saved one, else claude opus.
function readPick(root) {
  return readSavedPick(root) || { ...DEFAULT_PICK };
}

function writePick(root, pick) {
  const file = orbModelFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: SCHEMA, engine: pick.engine, model: pick.model || '', label: pick.label || null, set_at: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ---- signed in here -------------------------------------------------------------------

// No api key in the environment of anything the orb starts or asks: a key in
// the shell never counts as signed in and is never billed.
const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
function keylessEnv(env = process.env) {
  const out = { ...env };
  for (const k of KEY_VARS) delete out[k];
  return out;
}

// cursor and antigravity take about ten seconds each, longer when all run at once
const LOGIN_TIMEOUT_MS = 30000;
function defaultRun(bin, args) {
  return new Promise((resolve) => {
    childProcess.execFile(bin, args, { encoding: 'utf8', timeout: LOGIN_TIMEOUT_MS, env: keylessEnv(), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// One tool's answer is kept this long, so opening the card again probes nothing.
const LOGIN_MS = 10 * 60 * 1000;
const LOGINS = new Map();

async function signedIn(engine, bin, { run = defaultRun, fresh = false } = {}) {
  const check = LOGIN_CHECKS[engine];
  if (!check) return false;
  const hit = LOGINS.get(engine);
  if (!fresh && hit && Date.now() - hit.at < LOGIN_MS) return hit.ok;
  let ok = false;
  try {
    const r = await run(bin || engine, check.args);
    ok = Boolean(r && r.status === 0 && check.ok(`${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`));
  } catch {
    ok = false;
  }
  LOGINS.set(engine, { ok, at: Date.now() });
  return ok;
}

function forgetSignedIn() {
  LOGINS.clear();
}

// ---- what this computer offers ------------------------------------------------------------

// The tools the registry says run here, one per program: { engine, bin, models }.
function localTools(root, { registry = require('./engine-registry') } = {}) {
  let engines = [];
  try {
    engines = registry.readEngineRegistry(root).engines;
  } catch {
    engines = [];
  }
  const out = new Map();
  for (const e of engines) {
    const engine = CLAUDE_FAMILY.has(e.id) ? 'claude' : e.id;
    if (NEVER_ENGINES.has(engine) || registry.engineHosted(e) || out.has(engine)) continue;
    if (!LOGIN_CHECKS[engine]) continue;
    if (e.installed === true || registry.binInstalled(e.bin)) out.set(engine, { engine, bin: e.bin, models: Array.isArray(e.models) ? e.models : [] });
  }
  return [...out.values()].sort((a, b) => order(a.engine) - order(b.engine));
}
const TOOL_ORDER = ['claude', 'codex', 'cursor', 'devin', 'agy'];
const order = engine => (TOOL_ORDER.includes(engine) ? TOOL_ORDER.indexOf(engine) : TOOL_ORDER.length);

// Every model one tool offers, each { engine, model, label }; model '' is the
// tool's own default.
function toolModels(tool, { availableModels } = {}) {
  const list = availableModels || ((engines) => require('./roster-models').availableModels(engines));
  const label = model => require('./roster-models').modelLabel(model);
  const out = [];
  const seen = new Set();
  const add = (model, words) => {
    if (NEVER_MODEL.test(model) || seen.has(model)) return;
    seen.add(model);
    out.push({ engine: tool.engine, model, label: words || label(model) || 'its default' });
  };
  if (tool.engine === 'claude') {
    const names = require('./model-names');
    for (const a of CLAUDE_ALIASES) add(a, a);
    for (const known of (list([{ id: 'claude' }])[0] || {}).models || []) {
      try { add(names.normalizeRosterModel('claude', known)); } catch { /* a name the claude program would refuse */ }
    }
    return out;
  }
  if (tool.engine === 'codex') {
    const slugs = ((list([{ id: 'codex' }])[0] || {}).models || []).filter(m => !CODEX_SKIP.test(m));
    add('', 'its default');
    for (const s of slugs) add(s, s);
    return out;
  }
  add('', 'its default');
  // a registry name that is not a model id ("built-in router", "machine default") is the default
  for (const m of tool.models) if (m && !/\s(router|default)$/.test(m)) add(m, m);
  return out;
}

// Everything on offer and the pick. Resolves
// { pick, saved, groups: [{ engine, label, models: [{ engine, model, label, key, current }] }], line }.
// options: registry, run, availableModels, fresh (tests and the CLI)
async function offer(root, options = {}) {
  const tools = options.tools || localTools(root, options);
  const logins = await Promise.all(tools.map(t => signedIn(t.engine, t.bin, options)));
  const saved = readSavedPick(root);
  const pick = saved || { ...DEFAULT_PICK };
  const groups = [];
  tools.forEach((t, i) => {
    if (!logins[i]) return;
    const models = toolModels(t, options).map(m => ({ ...m, key: keyFor(m.engine, m.model), current: m.engine === pick.engine && m.model === pick.model }));
    if (models.length) groups.push({ engine: t.engine, label: toolWord(t.engine), models });
  });
  const all = groups.flatMap(g => g.models);
  const on = all.find(m => m.current) || null;
  const lead = on || all.find(m => m.engine === DEFAULT_PICK.engine && m.model === DEFAULT_PICK.model) || all[0] || null;
  const named = `${toolWord(pick.engine)} ${pickWords(pick)}`;
  let line = null;
  if (!on) {
    line = lead
      ? `${named} is not signed in on this computer, so the orb thinks with ${toolWord(lead.engine)} ${lead.label} until it is.`
      : `${named} is not signed in on this computer, and no other model here is either.`;
  }
  return { pick, saved, groups, lead: lead ? { engine: lead.engine, model: lead.model, label: lead.label } : null, line };
}

function pickWords(pick) {
  if (!pick.model) return 'with its default model';
  return pick.label || require('./roster-models').modelLabel(pick.model) || pick.model;
}

// The short words for the pick, from the saved file alone (no login check).
function pickLabel(root) {
  const p = readPick(root);
  if (!p.model) return toolWord(p.engine);
  return require('./roster-models').modelLabel(p.model) || p.model;
}

// The pick the orb asks first when it thinks: { engine, model } or null when
// none is saved (then the orb runs exactly as it always has).
function leadFor(root) {
  return readSavedPick(root);
}

// What a person typed ("terra", "codex gpt-5.6-sol", "claude sonnet",
// "opus 5.5", "cursor") as { engine, model }, or null when it names nothing.
function parseWords(words) {
  const text = String(words || '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const lower = text.toLowerCase();
  if (SHORT_NAMES[lower]) return { ...SHORT_NAMES[lower] };
  const reg = require('./engine-registry');
  const names = require('./model-names');
  const [first, ...rest] = text.split(' ');
  const tool = reg.canonicalEngineName(first.toLowerCase());
  const engine = tool && CLAUDE_FAMILY.has(tool) ? 'claude' : tool;
  if (engine) {
    const model = rest.join(' ');
    if (!model) return { engine, model: tool === 'haiku' || tool === 'fable' ? tool : (engine === 'claude' ? 'opus' : '') };
    if (engine === 'claude') {
      try { return { engine, model: names.normalizeRosterModel('claude', model) }; } catch { return null; }
    }
    return { engine, model: SHORT_NAMES[model.toLowerCase()] && SHORT_NAMES[model.toLowerCase()].engine === engine ? SHORT_NAMES[model.toLowerCase()].model : model };
  }
  // a model alone: claude's names, else whichever tool offers it
  try {
    const m = names.normalizeRosterModel('claude', text);
    if (m) return { engine: 'claude', model: m };
  } catch { /* not a claude name */ }
  return { engine: null, model: text };
}

// Set the pick from the page, the server, or the terminal: { engine, model }
// or words. Only a model on offer here (signed in, from the list above) is
// taken; anything else is refused in plain words and nothing is saved.
async function setPick(root, want, options = {}) {
  const asked = typeof want === 'string' ? parseWords(want) : (want && typeof want === 'object' ? { engine: String(want.engine || ''), model: String(want.model || '') } : null);
  const read = await offer(root, options);
  const all = read.groups.flatMap(g => g.models);
  const hit = asked && all.find(m => (asked.engine ? m.engine === asked.engine : true) && m.model === asked.model);
  if (!hit) {
    const what = typeof want === 'string' ? `"${String(want).slice(0, 60)}"` : 'that model';
    return { ok: false, reason: 'not_offered', message: `${what} is not a model signed in on this computer, so nothing changed. see the list with: atris gm phone model` };
  }
  const before = read.pick;
  writePick(root, hit);
  const named = `${toolWord(hit.engine)} ${hit.label}`;
  return { ok: true, engine: hit.engine, model: hit.model, label: named, changed: before.engine !== hit.engine || before.model !== hit.model, line: `the orb thinks with ${named} now. if it does not answer, the next model signed in here does.` };
}

// What the server and the CLI hand out: plain fields only.
async function publicStatus(root, options = {}) {
  const s = await offer(root, options);
  return {
    schema: SCHEMA,
    pick: s.pick,
    saved: s.saved,
    lead: s.lead,
    line: s.line,
    file: orbModelFile(root),
    groups: s.groups.map(g => ({ engine: g.engine, label: g.label, models: g.models.map(m => ({ model: m.model, label: m.label, current: m.current })) })),
  };
}

module.exports = {
  SCHEMA,
  DEFAULT_PICK,
  LOGIN_CHECKS,
  KEY_VARS,
  keylessEnv,
  keyFor,
  toolWord,
  orbModelFile,
  readSavedPick,
  readPick,
  pickLabel,
  writePick,
  signedIn,
  forgetSignedIn,
  localTools,
  toolModels,
  offer,
  leadFor,
  parseWords,
  setPick,
  publicStatus,
};
