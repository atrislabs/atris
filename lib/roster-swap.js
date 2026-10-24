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
const { HIDDEN_PROFILE_NAMES, engineTakesModel } = require('./runner-command');
const { availableModels } = require('./roster-models');
const { readRosterRuns, workerRuns, summarizeRuns, DEFAULT_DAYS } = require('./roster-runs');

// Installed tools and the models each offers, with the registry they came
// from (callers check roles against it). A model the owner wrote under
// "## picks" in ROSTER.md counts as offered by its tool too, added after the
// tool's own list: model names live in the owner's file, not in code. The
// short list comes from the first layer that has one (this session, this
// project, then all projects).
function machineOffer(root = process.cwd(), options = {}) {
  const registry = reg.readEngineRegistry(root, { persist: false });
  const engines = registry.engines
    .filter((engine) => !HIDDEN_PROFILE_NAMES.includes(engine.id))
    .filter((engine) => engine.installed || (engine.health && engine.health.status === 'ready'));
  const tools = availableModels(engines, options).map((row) => ({ ...row, models: [...row.models], tool: reg.rosterToolLabel(row.engine) }));
  let state = null;
  try {
    state = options.state || reg.readRosterState(root, options);
  } catch {
    state = null;
  }
  const layer = state ? reg.ROSTER_LAYERS.map((scope) => state[scope]).find((item) => item && Array.isArray(item.shortlist) && item.shortlist.length) : null;
  const shortlist = layer ? layer.shortlist : [];
  for (const pick of shortlist) {
    const row = tools.find((item) => item.engine === pick.engine);
    if (row && pick.model && !row.models.some((name) => sameModel(row.engine, name, pick.model))) row.models.push(pick.model);
  }
  return { registry, tools, shortlist, shortlistFile: layer ? layer.file : '' };
}

// One swap option: the tool, the model to post ('' for the tool's own
// model), and the model as it reads.
function optionFor(row, name) {
  const pin = name ? pinFor(row.engine, name) : '';
  return { engine: row.engine, tool: row.tool, model: pin ? name : '', label: !name ? 'its own model' : pin ? modelText(pin) || name : name };
}

function fullList(tools) {
  return tools.flatMap((row) => (row.models.length ? row.models : ['']).map((name) => optionFor(row, name)));
}

// A model the seed marks "(test model)" never goes on top.
const TEST_MODEL = /\(test model\)/i;

// The ordered swap list that --available and the phone's engine card both
// read. With a "## picks" section: the Atris engines first (hosted on
// Atris's own servers, test models left out), then each pick in file order
// (a pick for a tool not on this machine is left out, and one already shown
// is not shown twice), then one "more models" entry carrying the full list.
// With no picks: the full list, as before.
function swapList(root = process.cwd(), options = {}) {
  const offer = options.offer || machineOffer(root, options);
  const full = fullList(offer.tools);
  if (!offer.shortlist.length) return { picked: false, options: full, full, tools: offer.tools };
  const seen = new Set();
  const take = (option, flag) => {
    const key = `${option.engine}\u0000${option.label.toLowerCase()}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { ...option, [flag]: true };
  };
  const atris = full
    .filter((option) => reg.engineHosted({ id: option.engine }) && !TEST_MODEL.test(option.label))
    .map((option) => take(option, 'atris'))
    .filter(Boolean);
  const picks = offer.shortlist
    .map((pick) => {
      const row = offer.tools.find((item) => item.engine === pick.engine);
      return row ? take(optionFor(row, pick.model), 'pick') : null;
    })
    .filter(Boolean);
  return {
    picked: true,
    file: offer.shortlistFile,
    options: [...atris, ...picks, { more: true, label: 'more models', options: full }],
    full,
    tools: offer.tools,
  };
}

// The saved id for a model name, or the name as written when it has none.
function modelId(engine, name) {
  try {
    return reg.normalizeRosterModel(engine, name) || '';
  } catch {
    return String(name || '').trim();
  }
}

// A name --available lists is a real model only when the engine takes a
// model and the name saves as an id a --model flag can carry: no spaces or
// brackets (a trailing long-context mark aside), and not just the tool's own
// name. Anything else (a router label, a tool listing itself) is a display
// label, and picking it means no pin: the line names the tool alone, the
// way the roster writes any worker with no model.
function pinFor(engine, name) {
  if (!engineTakesModel(engine)) return '';
  const id = modelId(engine, name);
  const bare = id.replace(/\[1m\]$/i, '').toLowerCase();
  if (!bare || /[\s()[\]]/.test(bare)) return '';
  if (bare === String(engine).toLowerCase() || bare === reg.rosterToolLabel(engine).toLowerCase()) return '';
  return id;
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
  // a display label on the list stands for the tool's own model
  if (!words) {
    if (!row.models.some((item) => !pinFor(engine, item))) throw new Error(`pick a model for ${row.tool}: ${row.models.join(', ')}`);
    return { engine, model: '', name: '', tool: row.tool, registry };
  }
  const name = row.models.find((item) => sameModel(engine, item, words));
  if (!name) throw new Error(`${row.tool} has no model "${words}" on this machine. pick one of: ${row.models.join(', ')}`);
  const pin = pinFor(engine, name);
  return { engine, model: pin, name: pin ? name : '', tool: row.tool, registry };
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
// A model's last 7 days in the owner's words: the phone's swap card shows it
// under the model, so it says finished, never the team's own word for it.
const recordWords = seen => `${seen.landed} of ${seen.runs} finished this week`;

// The current model is on top; models with a record in the last 7 days come
// next, most landed first; the rest keep --available's order.
function memberEngineChoices(root, memberName, options = {}) {
  const { member, picked } = teamMember(root, memberName, options);
  const { registry, tools, shortlist, shortlistFile } = machineOffer(root, options);
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
      // a display label posts no model, so the swap pins none
      const id = name ? pinFor(row.engine, name) : '';
      const seen = record(row.engine, id);
      return {
        engine: row.engine,
        model: id ? name : '',
        label: !name ? 'its own model' : id ? modelText(id) || name : name,
        current: row.engine === curEngine && sameModel(row.engine, id, curModel),
        record: seen ? recordWords(seen) : null,
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
  // options: the same ordered list --available prints (swapList), keeping
  // only what this member can do, each with current and its 7-day record.
  // groups stays the full list by tool for the page that draws it today.
  const mark = (option) => {
    const pin = option.model ? pinFor(option.engine, option.model) : '';
    const seen = record(option.engine, pin);
    return { ...option, current: option.engine === curEngine && sameModel(option.engine, pin, curModel), record: seen ? recordWords(seen) : null };
  };
  const list = swapList(root, { ...options, offer: { registry, tools, shortlist, shortlistFile } });
  const choices = list.options
    .filter((option) => option.more || fits(option.engine))
    .map((option) => (option.more ? { ...option, options: option.options.filter((item) => fits(item.engine)).map(mark) } : mark(option)));
  return {
    member,
    job: picked.job,
    job_key: jobKey,
    line: curEngine ? `${member} runs on ${workerText(curEngine, curModel)}.` : `${member} has no engine yet.`,
    scopes: [{ id: 'member', label: `just ${member}` }, { id: 'job', label: `for every ${picked.job} job` }],
    groups: groups.map(({ current, recorded, order, ...group }) => group),
    picked: list.picked,
    options: choices,
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
  // the owner reads this: the member has its own pick, so it stays on its own model
  if (!moved && after.pick_source === 'team') return { ...out, line: `${out.line} ${member} keeps its own model.` };
  return out;
}

module.exports = {
  swapList,
  memberEngineChoices,
  swapFromCard,
  swapJob,
  swapMember,
};
