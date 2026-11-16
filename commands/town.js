'use strict';

// atris town: play the Atris town from a terminal, the same world people walk
// on the website.
//
//   atris town                      where you are and what you see
//   atris town go <place|street>    walk to a door or the next street
//   atris town look | map | who | night
//   atris town grow "<name>" "<what it is>" [--layout ..] [--mood ..]
//   atris town streets              the streets you have asked for
//
// Walking (look, go) and asking for streets (grow, streets) use the town's
// text door, which takes a developer key. The map, who and night use your
// sign-in. Add --json to any of them for machine output.

const fs = require('fs');
const path = require('path');
const { stateHome } = require('../lib/state-home');
const {
  NOT_LOGGED_IN,
  wantsHelp,
  wantsJson,
  tokenFrom,
  printResult,
} = require('../lib/developer-api');
const { parseFlags, errorText, cleanText } = require('../lib/night-shift');
const door = require('../lib/town-door');
const view = require('../lib/town-view');

const SUBCOMMANDS = ['look', 'go', 'map', 'who', 'night', 'grow', 'streets'];
const HERE_TTL_MS = 24 * 60 * 60 * 1000; // the town remembers a walker's street for a day
const NOT_BUILT = 'The town does not take street requests from here yet. It is still being built. Nothing was sent.';
const NIGHTS_MAX = 3;

function showTownHelp(log = console.log) {
  log('usage: atris town                         where you are and what you see');
  log('       atris town go <place or street>    walk to a door or to the next street');
  log('       atris town look                    look around again');
  log('       atris town map                     the streets and how they join');
  log('       atris town who                     who is on your street, and your agents');
  log('       atris town night                   last night\'s walk for your agent (--agent <name>)');
  log('       atris town grow "<name>" "<what it is>" [--layout <words>] [--mood <day|dusk|night>]');
  log('                                          ask the town for a new street');
  log('       atris town streets                 the streets you have asked for, and their status');
  log('add --json to any of these for machine output.');
  log('');
  log('look, go, grow and streets use the town\'s text door, which needs a developer key');
  log('(atris api-key create, then ATRIS_API_KEY=<key>). map, who and night use your sign-in.');
  log('ATRIS_API_URL points all of it at another server.');
}

function hereFile() {
  return path.join(stateHome(), '.atris', 'town-here.json');
}

// The last street a walk ended on, so the map can mark it. Best effort.
function defaultHere() {
  return {
    read(userId) {
      try {
        const saved = JSON.parse(fs.readFileSync(hereFile(), 'utf8'));
        const age = Date.now() - Date.parse(saved.at);
        if (!saved.street || !(age >= 0 && age < HERE_TTL_MS)) return null;
        if (saved.user && userId && saved.user !== userId) return null;
        return saved.street;
      } catch {
        return null;
      }
    },
    write(street, userId) {
      try {
        fs.mkdirSync(path.dirname(hereFile()), { recursive: true });
        fs.writeFileSync(hereFile(), JSON.stringify({ street, user: userId || null, at: new Date().toISOString() }));
      } catch {
        // The map just goes without a marker.
      }
    },
  };
}

function makeContext(deps, io, json) {
  const env = deps.env || process.env;
  const request = deps.apiRequestJson || require('../utils/api').apiRequestJson;
  const load = deps.loadCredentials || require('../utils/auth').loadCredentials;
  const here = deps.here || defaultHere();
  let credsPromise = null;
  let factsPromise = null;
  const ctx = {
    deps,
    io,
    json,
    env,
    request,
    here,
    creds() {
      if (!credsPromise) {
        credsPromise = (async () => {
          try { return (await load(request)) || null; } catch { return null; }
        })();
      }
      return credsPromise;
    },
    // The street facts: public, so no sign-in needed. Resolves { ok, data, error }.
    loadFacts() {
      if (!factsPromise) {
        factsPromise = request('/world/streets', { method: 'GET' }).then((result) => {
          const data = result && result.data;
          if (result && result.ok && data && Array.isArray(data.streets)) return { ok: true, data };
          return { ok: false, data: null, error: errorText(result) };
        });
      }
      return factsPromise;
    },
    async facts() {
      return (await ctx.loadFacts()).data;
    },
    async doorOptions() {
      const creds = await ctx.creds();
      const key = door.townKey(creds, env, deps.keyDeps);
      if (!key) return { error: tokenFrom(creds) ? door.NEEDS_KEY : door.NEEDS_LOGIN_AND_KEY };
      return { options: { key, httpRequest: deps.httpRequest, base: deps.apiBase, timeoutMs: deps.timeoutMs } };
    },
  };
  return ctx;
}

function fail(ctx, message, extra = {}) {
  const [first, ...rest] = String(message).split('\n');
  const payload = { ok: false, error: first, ...(rest.length ? { hint: rest.join(' ') } : {}), ...extra };
  printResult({ json: ctx.json, ok: false, error: message, payload }, ctx.io);
  return 1;
}

function say(ctx, lines, payload) {
  printResult({ json: ctx.json, ok: true, text: lines.join('\n'), payload }, ctx.io);
  return 0;
}

// One call to the text door, parsed against the street facts.
async function walk(ctx, tool, args) {
  const opened = await ctx.doorOptions();
  if (opened.error) return { failed: fail(ctx, opened.error, { needs: 'developer_key' }) };
  const [result, facts] = await Promise.all([door.callTool(tool, args, opened.options), ctx.facts()]);
  if (!result.ok) return { failed: fail(ctx, door.doorMessage(result), { status: result.status || null }) };
  const parsed = view.parseLook(result.text, facts);
  if (parsed.street && parsed.street.id) {
    const creds = await ctx.creds();
    ctx.here.write(parsed.street.id, creds && creds.user_id);
  }
  return { parsed };
}

async function lookCommand(ctx) {
  const { parsed, failed } = await walk(ctx, 'town_look', {});
  if (failed) return failed;
  return say(ctx, view.renderLook(parsed), view.lookPayload(parsed, { command: 'look' }));
}

async function goCommand(ctx, words) {
  const wanted = words.join(' ').trim();
  if (!wanted) return fail(ctx, 'Say where to go. Example: atris town go "The School", or atris town go left');
  const { parsed, failed } = await walk(ctx, 'town_go', { place: wanted });
  if (failed) return failed;
  return say(ctx, view.renderLook(parsed), view.lookPayload(parsed, { command: 'go', moved: view.movedFrom(parsed.said) }));
}

async function mapCommand(ctx) {
  const loaded = await ctx.loadFacts();
  if (!loaded.ok) return fail(ctx, `Could not read the town's streets: ${loaded.error}`);
  const creds = await ctx.creds();
  const hereId = ctx.here.read(creds && creds.user_id);
  return say(ctx, view.renderMap(loaded.data, hereId), view.mapPayload(loaded.data, hereId));
}

async function whoCommand(ctx) {
  const creds = await ctx.creds();
  const token = tokenFrom(creds);
  if (!token) return fail(ctx, NOT_LOGGED_IN);
  const now = await ctx.request('/world/agents-now', { method: 'GET', token });
  if (!now || !now.ok) return fail(ctx, `Could not read who is around: ${errorText(now)}`, { status: now && now.status });

  let looked = null;
  let hint = null;
  const opened = await ctx.doorOptions();
  if (opened.error) {
    hint = 'To see who stands on your street, give the town a developer key: atris api-key create';
  } else {
    const result = await door.callTool('town_look', {}, opened.options);
    if (result.ok) looked = view.parseLook(result.text, await ctx.facts());
    else hint = `Could not read your street: ${door.doorMessage(result)}`;
  }
  const lines = view.renderWho(looked, now.data);
  if (hint) lines.push('', hint);
  const payload = view.whoPayload(looked, now.data);
  if (hint) payload.hint = hint;
  return say(ctx, lines, payload);
}

function pickNights(agents, creds, wanted) {
  if (wanted) {
    const lower = wanted.toLowerCase();
    return agents.filter((entry) => entry.agent.id === wanted || String(entry.agent.name || '').toLowerCase().includes(lower));
  }
  const joined = creds && creds.joined_agent && creds.joined_agent.agent_id;
  const own = joined ? agents.filter((entry) => entry.agent.id === joined) : [];
  return own.length ? own : agents;
}

async function nightCommand(ctx, flags) {
  const creds = await ctx.creds();
  const token = tokenFrom(creds);
  if (!token) return fail(ctx, NOT_LOGGED_IN);
  const result = await ctx.request('/world/last-night', { method: 'GET', token });
  if (!result || !result.ok) return fail(ctx, `Could not read last night: ${errorText(result)}`, { status: result && result.status });

  const agents = Array.isArray(result.data && result.data.agents) ? result.data.agents.filter((entry) => entry && entry.agent) : [];
  const wanted = flags.agent ? String(flags.agent).trim() : '';
  const picked = pickNights(agents, creds, wanted);
  if (wanted && !picked.length) return fail(ctx, `None of your agents matches "${cleanText(wanted, 40)}".`);

  const walked = picked.filter((entry) => entry.night);
  if (!walked.length) {
    const empty = picked.length === 1 && picked[0].empty
      ? `${cleanText(picked[0].agent.name, 80)}: ${cleanText(picked[0].empty, 120)}`
      : 'No finished night to walk yet. Start one tonight: atris night "<goal>" --cap 1';
    return say(ctx, [empty], { ok: true, nights: [], empty });
  }
  const shown = walked.slice(0, NIGHTS_MAX);
  const lines = [];
  for (const entry of shown) {
    if (lines.length) lines.push('');
    lines.push(...view.renderNight(entry));
  }
  if (walked.length > shown.length) {
    lines.push('', `${walked.length - shown.length} more of your agents had a night. See one with: atris town night --agent <name>`);
  }
  return say(ctx, lines, { ok: true, nights: shown.map(view.nightPayload), more: walked.length - shown.length });
}

function replyLines(result) {
  const data = result.data;
  if (typeof data === 'string') return data.split('\n').map((line) => cleanText(line, 300)).filter(Boolean);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const lines = ['message', 'status', 'next', 'next_step']
      .filter((key) => typeof data[key] === 'string' && data[key].trim())
      .map((key) => cleanText(data[key], 300));
    if (lines.length) return lines;
  }
  const text = String(result.text || '').trim();
  return text && !/^[{[]/.test(text) ? text.split('\n').map((line) => cleanText(line, 300)).filter(Boolean) : [];
}

// A street tool the server may not have yet: the tool must be listed before
// anything is sent. Resolves { tool } or { failed }.
async function findTool(ctx, name) {
  const opened = await ctx.doorOptions();
  if (opened.error) return { failed: fail(ctx, opened.error, { needs: 'developer_key' }) };
  const listed = await door.listTools(opened.options);
  if (!listed.ok) return { failed: fail(ctx, door.doorMessage(listed), { status: listed.status || null }) };
  const tool = (listed.tools || []).find((item) => item && item.name === name);
  if (!tool) return { failed: fail(ctx, NOT_BUILT, { available: false }) };
  return { tool, options: opened.options };
}

async function growCommand(ctx, args) {
  const { flags, positionals } = parseFlags(args, ['--layout', '--mood'], ['--json']);
  const name = (positionals[0] || '').trim();
  const what = positionals.slice(1).join(' ').trim();
  if (!name || !what) {
    return fail(ctx, 'Say the street and what it is. Example: atris town grow "Lantern Lane" "a quiet street of lamp makers" --mood dusk');
  }
  const found = await findTool(ctx, 'town_request_street');
  if (found.failed) return found.failed;

  const schema = found.tool.inputSchema && found.tool.inputSchema.properties;
  const known = schema && typeof schema === 'object' ? Object.keys(schema) : null;
  const body = { name, what_it_is: what };
  const ignored = [];
  for (const key of ['layout', 'mood']) {
    if (!flags[key]) continue;
    if (known && !known.includes(key)) ignored.push(key);
    else body[key] = flags[key];
  }
  const result = await door.callTool('town_request_street', body, found.options);
  if (!result.ok) {
    if (result.unknownTool) return fail(ctx, NOT_BUILT, { available: false });
    return fail(ctx, door.doorMessage(result), { status: result.status || null });
  }
  const lines = [`Asked the town for "${cleanText(name, 80)}".`, ...replyLines(result)];
  for (const key of ignored) lines.push(`The town does not take --${key} yet, so it was left out.`);
  return say(ctx, lines, { ok: true, requested: body, ignored, reply: result.data != null ? result.data : result.text });
}

async function streetsCommand(ctx) {
  const found = await findTool(ctx, 'town_my_streets');
  if (found.failed) return found.failed;
  const result = await door.callTool('town_my_streets', {}, found.options);
  if (!result.ok) {
    if (result.unknownTool) return fail(ctx, NOT_BUILT, { available: false });
    return fail(ctx, door.doorMessage(result), { status: result.status || null });
  }
  let data = result.data;
  if (data == null && result.text) {
    try { data = JSON.parse(result.text); } catch { data = null; }
  }
  const rows = view.requestRows(data);
  if (!rows || !rows.length) {
    const said = replyLines(result);
    const raw = data && typeof data === 'object' && Object.keys(data).length ? [cleanText(JSON.stringify(data), 300)] : [];
    const lines = rows ? [] : said.length ? said : raw;
    const empty = lines.length ? lines : ['You have not asked for a street yet. Ask for one: atris town grow "<name>" "<what it is>"'];
    return say(ctx, empty, { ok: true, requests: [], ...(rows ? {} : { reply: data != null ? data : result.text }) });
  }
  return say(ctx, ['Your street requests', ...view.renderRequests(rows)], { ok: true, requests: rows.map(view.requestPayload) });
}

async function townCommand(args = [], deps = {}) {
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  if (wantsHelp(args)) {
    showTownHelp(io.log);
    return 0;
  }
  const json = wantsJson(args);
  const ctx = makeContext(deps, io, json);
  const rest = args.filter((arg) => arg !== '--json');
  const sub = String(rest[0] || 'look').toLowerCase();
  if (!SUBCOMMANDS.includes(sub)) {
    return fail(ctx, `"${cleanText(rest[0], 40)}" is not a town command. Try: atris town --help`);
  }
  const tail = rest.slice(1);
  if (sub === 'look') return lookCommand(ctx);
  if (sub === 'go') return goCommand(ctx, tail);
  if (sub === 'map') return mapCommand(ctx);
  if (sub === 'who') return whoCommand(ctx);
  if (sub === 'night') return nightCommand(ctx, parseFlags(tail, ['--agent'], []).flags);
  if (sub === 'grow') return growCommand(ctx, tail);
  return streetsCommand(ctx);
}

module.exports = { townCommand, showTownHelp };
