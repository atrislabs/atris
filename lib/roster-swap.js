'use strict';

// Swap the model behind a job or one member. `atris engine roster set` and
// the phone's engine card both come through here, so a tap and a typed
// command check the same things and write ROSTER.md the same way.
//
// What counts as a real choice is what this machine offers, read from the
// same local source as `atris engine roster --available` (the engine
// registry, codex's models cache, the known names). No list of models lives
// here, and nothing here goes online.

const reg = require('./engine-registry');
const { HIDDEN_PROFILE_NAMES } = require('./runner-command');
const { availableModels } = require('./roster-models');
const { readRosterRuns, workerRuns, summarizeRuns, DEFAULT_DAYS } = require('./roster-runs');

// Installed tools and the models each offers, with the registry they came
// from (callers check roles against it).
function machineOffer(root = process.cwd(), options = {}) {
  const registry = reg.readEngineRegistry(root, { persist: false });
  const engines = registry.engines
    .filter((engine) => !HIDDEN_PROFILE_NAMES.includes(engine.id))
    .filter((engine) => engine.installed || (engine.health && engine.health.status === 'ready'));
  const tools = availableModels(engines, options).map((row) => ({ ...row, tool: reg.rosterToolLabel(row.engine) }));
  return { registry, tools };
}

function availableTools(root = process.cwd(), options = {}) {
  return machineOffer(root, options).tools;
}

// The saved id for a model name, or the name as written when it has none.
function modelId(engine, name) {
  try {
    return reg.normalizeRosterModel(engine, name) || '';
  } catch {
    return String(name || '').trim();
  }
}

function sameModel(engine, a, b) {
  return modelId(engine, a).toLowerCase() === modelId(engine, b).toLowerCase();
}

function modelText(model) {
  return model ? String(reg.rosterModelLabel(model) || model).trim() : '';
}

// The tool then the model's label, the way the team table says it (never
// the tool twice when the label already starts with it), or the tool alone
// when no model is pinned.
function workerText(engine, model = '') {
  const label = modelText(model);
  if (!label) return String(engine || '');
  return label.toLowerCase().startsWith(`${String(engine).toLowerCase()} `) ? label : `${engine} ${label}`;
}

// One engine and model checked against what this machine offers. Throws a
// plain sentence that lists the valid choices.
function checkChoice(root, engineWords, modelWords, options = {}) {
  const { registry, tools } = options.offer || machineOffer(root, options);
  const engine = reg.rosterToolName(engineWords);
  const row = tools.find((item) => item.engine === engine);
  if (!row) {
    const names = tools.map((item) => item.tool);
    throw new Error(`${String(engineWords || '').trim() || 'that'} is not on this machine. pick one of: ${names.join(', ') || 'none found, run atris engine doctor'}`);
  }
  const words = String(modelWords || '').trim();
  if (!row.models.length) {
    if (words) throw new Error(`${row.tool} picks its own model here, so leave "${words}" off`);
    return { engine, model: '', name: '', tool: row.tool, registry };
  }
  if (!words) throw new Error(`pick a model for ${row.tool}: ${row.models.join(', ')}`);
  const name = row.models.find((item) => sameModel(engine, item, words));
  if (!name) throw new Error(`${row.tool} has no model "${words}" on this machine. pick one of: ${row.models.join(', ')}`);
  return { engine, model: modelId(engine, name), name, tool: row.tool, registry };
}

function layerOptions(scope) {
  if (scope === 'session') return { session: true };
  if (scope === 'machine') return { everywhere: true };
  return {};
}

// Write where the job's pick already lives, so the swap is the one that
// counts; a job no file names yet goes in the all-projects roster
// (~/.atris/ROSTER.md), or this project's when that one is off.
function jobScope(state, key) {
  for (const scope of reg.ROSTER_LAYERS) {
    if (state[scope] && state[scope].picks && state[scope].picks[key]) return scope;
  }
  return state.machine && state.machine.path ? 'machine' : 'project';
}

function teamScope(state, member) {
  for (const scope of reg.ROSTER_LAYERS) {
    const team = state[scope] && Array.isArray(state[scope].team) ? state[scope].team : [];
    if (team.some((line) => line.member === member)) return scope;
  }
  return state.machine && state.machine.path ? 'machine' : 'project';
}

// The first good worker of a job's pick in one layer, or null.
function jobLead(state, scope, key) {
  const pick = state[scope] && state[scope].picks ? state[scope].picks[key] : null;
  if (!pick) return null;
  const workers = Array.isArray(pick.workers) ? pick.workers.filter((worker) => !worker.error) : [pick];
  return workers[0] || null;
}

// The command a person would type for this swap.
function setCommand({ job = '', member = '', engine, name }) {
  const quote = (text) => (/\s/.test(text) ? `"${text}"` : text);
  const who = member ? `--member ${member}` : quote(job);
  return ['atris engine roster set', who, engine, name].filter(Boolean).join(' ');
}

// Swap a job's lead. The old lead stays as the first backup. Returns the
// one plain line to show.
function swapJob(root, jobWords, engineWords, modelWords, options = {}) {
  const key = reg.rosterJobKey(jobWords);
  if (!key) throw new Error(reg.rosterJobNameError(jobWords));
  const label = reg.rosterJobLabel(key);
  const choice = checkChoice(root, engineWords, modelWords, options);
  const state = reg.readRosterState(root, options);
  const scope = jobScope(state, key);
  const lead = jobLead(state, scope, key);
  const now = workerText(choice.engine, choice.model);
  const command = setCommand({ job: label, engine: choice.engine, name: choice.name });
  if (lead && lead.engine === choice.engine && sameModel(choice.engine, lead.model || '', choice.model)) {
    return { changed: false, job: label, key, engine: choice.engine, model: choice.model, scope, command, line: `${label} already runs on ${now}.` };
  }
  reg.setRosterPick(jobWords, choice.engine, { ...layerOptions(scope), model: choice.name || undefined, keepLead: true }, root);
  const backup = lead ? workerText(lead.engine, lead.model || '') : '';
  return {
    changed: true,
    job: label,
    key,
    engine: choice.engine,
    model: choice.model,
    backup,
    scope,
    command,
    line: backup ? `${label} now runs on ${now}. ${backup} is the backup.` : `${label} now runs on ${now}.`,
  };
}

// A member on this team: a card in atris/team or a team line.
function teamMember(root, memberName, options = {}) {
  const { resolveEngineForMember, readMemberCard, autoJobForMember } = require('./member-engine');
  const member = String(memberName || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(member)) throw new Error(`"${memberName}" is not a member name`);
  const picked = resolveEngineForMember(member, root, options);
  if (!picked.found) throw new Error(`there is no team member named ${member}`);
  const kind = autoJobForMember(member, readMemberCard(root, member).role);
  return { member, picked, kind, role: reg.ENGINE_JOBS[kind] };
}

// Give one member its own engine and model; every other job stays put.
function swapMember(root, memberName, engineWords, modelWords, options = {}) {
  const { member, picked, kind, role } = teamMember(root, memberName, options);
  const choice = checkChoice(root, engineWords, modelWords, options);
  const now = workerText(choice.engine, choice.model);
  const command = setCommand({ member, engine: choice.engine, name: choice.name });
  const state = reg.readRosterState(root, options);
  const scope = teamScope(state, member);
  const current = picked.engine && picked.engine.id === choice.engine && sameModel(choice.engine, picked.model || '', choice.model);
  if (current && picked.pick_source === 'team') {
    return { changed: false, member, engine: choice.engine, model: choice.model, scope, command, line: `${member} already runs on ${now}.` };
  }
  reg.setTeamPick(member, choice.engine, { ...layerOptions(scope), model: choice.name || undefined, role }, root);
  const key = role;
  const lead = jobLead(state, jobScope(state, key), key);
  const rest = lead ? ` every other ${kind} job stays on ${workerText(lead.engine, lead.model || '')}.` : '';
  return { changed: true, member, engine: choice.engine, model: choice.model, scope, command, line: `${member} now runs on ${now}.${rest}` };
}

// The phone's engine card for one member: what it runs on now, and every
// model this machine offers that can do the member's work, grouped by tool.
// The current model is on top; models with a record in the last 7 days come
// next, most landed first; the rest keep --available's order.
function memberEngineChoices(root, memberName, options = {}) {
  const { member, picked } = teamMember(root, memberName, options);
  const { registry, tools } = machineOffer(root, options);
  const jobKey = picked.job_key;
  const role = picked.role;
  const runs = readRosterRuns(root, { now: options.now, days: DEFAULT_DAYS });
  const record = (engine, model) => summarizeRuns(workerRuns(runs, { job: jobKey, engine, model }), { days: DEFAULT_DAYS });
  const curEngine = picked.engine ? picked.engine.id : '';
  const curModel = picked.model || '';
  const fits = (engineId) => reg.jobTakesAnyEngine(jobKey) || reg.engineHasRole(registry.engines.find((entry) => entry.id === engineId), role);
  const groups = [];
  tools.forEach((row, order) => {
    if (!fits(row.engine) && row.engine !== curEngine) return;
    const names = row.models.length ? row.models : [''];
    const models = names.map((name, index) => {
      const id = modelId(row.engine, name);
      const seen = record(row.engine, id);
      return {
        engine: row.engine,
        model: name,
        label: name ? modelText(id) || name : 'its own model',
        current: row.engine === curEngine && sameModel(row.engine, id, curModel),
        record: seen ? `${seen.landed} of ${seen.runs} landed` : null,
        landed: seen ? seen.landed : -1,
        runs: seen ? seen.runs : 0,
        index,
      };
    });
    if (row.engine === curEngine && curModel && !models.some((item) => item.current)) {
      models.push({ engine: row.engine, model: curModel, label: modelText(curModel), current: true, record: null, landed: -1, runs: 0, index: -1 });
    }
    models.sort((a, b) => (b.current - a.current) || (b.landed - a.landed) || (b.runs - a.runs) || (a.index - b.index));
    groups.push({
      engine: row.engine,
      tool: row.tool,
      models: models.map(({ landed, runs: count, index, ...item }) => item),
      current: models.some((item) => item.current),
      recorded: models.some((item) => item.record),
      order,
    });
  });
  if (curEngine && !groups.some((group) => group.engine === curEngine)) {
    groups.push({ engine: curEngine, tool: reg.rosterToolLabel(curEngine), models: [{ engine: curEngine, model: curModel, label: modelText(curModel) || 'its own model', current: true, record: null }], current: true, recorded: false, order: -1 });
  }
  groups.sort((a, b) => (b.current - a.current) || (b.recorded - a.recorded) || (a.order - b.order));
  return {
    member,
    job: picked.job,
    job_key: jobKey,
    line: curEngine ? `${member} runs on ${workerText(curEngine, curModel)}.` : `${member} has no engine yet.`,
    scopes: [{ id: 'member', label: `just ${member}` }, { id: 'job', label: `for every ${picked.job} job` }],
    groups: groups.map(({ current, recorded, order, ...group }) => group),
  };
}

// One tap from the engine card: scope member gives only this member the
// model; scope job swaps the lead of the member's job.
function swapFromCard(root, memberName, engineWords, modelWords, scope, options = {}) {
  if (scope !== 'job') return swapMember(root, memberName, engineWords, modelWords, options);
  const { member, picked } = teamMember(root, memberName, options);
  const out = swapJob(root, picked.job, engineWords, modelWords, options);
  const { resolveEngineForMember } = require('./member-engine');
  const after = resolveEngineForMember(member, root, options);
  const moved = after.engine && after.engine.id === out.engine && sameModel(out.engine, after.model || '', out.model);
  if (!moved && after.pick_source === 'team') return { ...out, line: `${out.line} ${member} keeps its own line.` };
  return out;
}

module.exports = {
  availableTools,
  memberEngineChoices,
  swapFromCard,
  swapJob,
  swapMember,
};
