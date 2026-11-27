'use strict';

// atris nexus hour: a one-hour outbound sprint on one saved list in Nexus.
//
// Pick a cluster (plant shop owners in Austin), say what you think will happen, then work the
// list for an hour: add people, research each one two levels deep (level 1 the business, level 2
// the person), record how sure you are and the one specific reason, store a short note per person,
// and see who is ready. Every fact lives in Nexus. The only thing kept on this computer is the
// clock: when the hour ends, which list, which cluster.
//
// Nothing here sends anything to anyone. `ready` only says who is ready and how to open their
// card, where the owner reads the note and presses send himself, one person at a time
// (POST /nexus/people/{id}/send, behind the card's own send button).
//
// Backend (atrisos-backend routers/nexus_router.py, under /nexus), live today:
//   GET/POST /lists, POST /lists/{id}/people, POST /people/search (with list_id), POST /capture,
//   PATCH /people/{id}/mine (extra.col_<name> = {v, by, at, src, was}).
// Landing soon, so every call to them takes a 404 or 405 as "not live yet" and the hour goes on:
//   PATCH /lists/{id}/experiment {guess, started_at, learned}
//   GET   /lists/{id}/score       {list, experiment, counts, rates, people}
//   PUT   /people/{id}/draft      {subject, body, step, list_id}
//   GET   /lists/{id}/drafts      {count, without_draft, drafts}
//
// Search words and note text travel in request bodies, never in a web address. Errors name
// counts and ids only; the owner's own screen may show names.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/nexus-store');
const { LOCKED_LINE } = require('./nexus-store');

const SUBS = new Set(['start', 'add', 'next', 'research', 'draft', 'ready', 'end', 'status']);
const HELP = [
  '  atris nexus hour start "<cluster>" --guess "<what you think will happen>" [--minutes 60] [--list <saved list>]',
  '                                      one hour of outbound on one saved list; --list runs it on a list you already have',
  '  atris nexus hour                    minutes left, the guess, the scoreboard and the one next thing to do',
  '  atris nexus hour add "<name>" [--email --company --city --site --why "..." --source <url>]   add them and put them on the list',
  '  atris nexus hour start ... --new-only   the whole hour adds only people new to your Nexus; it cannot be turned off until the hour ends',
  '  atris nexus hour add "<name>" --new-only --source <url> --why "<why them>" [--email --company --title --city --site --linkedin --x]',
  '                                      adds them only if they are new to your Nexus; anyone already known is skipped and nothing changes',
  '  atris nexus hour next               the one person who most needs work, what is known and what is missing',
  '  atris nexus hour research "<name>" --level 1|2 --confidence <0-100> --source <url> --why "<one line>"',
  '                                      level 1 is the business, level 2 is the person; nothing is kept without a source',
  '  atris nexus hour draft "<name>" --subject "..." --body-file <path> [--step 1|2|3]   store the note you wrote for them',
  '  atris nexus hour ready              who is at 75 or more, researched at level 2, with a note stored. Sending stays your press',
  '  atris nexus hour end [--learned "..."]   stop the clock, keep what you learned, the tally against the guess and the follow-ups',
  '    status, next, ready and end take --json',
];

const VALUES = new Set(['guess', 'minutes', 'list', 'email', 'company', 'city', 'site', 'why', 'source', 'level',
  'confidence', 'subject', 'body-file', 'learned', 'step', 'person', 'title', 'linkedin', 'x']);
const SWITCHES = new Set(['json', 'new', 'as-helper', 'help', 'new-only']);
// Only a new-only add sends these, so they are refused anywhere else.
const NEW_ONLY_FIELDS = ['title', 'linkedin', 'x'];
const NEW_ONLY = 'new_only';
const NEW_ONLY_STATUSES = new Set(['created', 'replayed', 'skipped']);
const AGENT_MARKS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT', 'DEVIN_SESSION_ID'];

const READY_AT = 75;
const BEAT_MINUTES = 10;
const PAGE = 200;
const MOST_PEOPLE = 2000;
const WAIT_MS = 15000;
const GUESS_MOST = 500;
const LEARNED_MOST = 2000;
const WHY_MOST = 500;
const SOURCE_MOST = 1000;
const SUBJECT_MOST = 200;
const BODY_MOST = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_BASE = 'https://atris.ai/dashboard/nexus';

const NO_GUESS = 'Say what you think will happen first, with --guess "...". No test without a guess behind it.';
const NOT_RUNNING = 'No hour is running. Start one: atris nexus hour start "<cluster>" --guess "<what you think will happen>"';
const NOT_LIVE = {
  experiment: 'Keeping the guess on the list in Nexus is not live yet, so it is kept with the clock on this computer.',
  learned: 'Keeping what you learned on the list in Nexus is not live yet. It is shown here so you can keep it.',
  score: 'Reply numbers from Nexus are not live yet, so reached and replied come from each card\'s stage.',
  drafts: 'Notes stored per person are not live yet, so drafted counts only what the cards already show.',
  draft: 'Storing a note per person is not live yet, so nothing was stored.',
};

const clean = (value) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
const quote = (text) => `"${String(text).replace(/(["\\$`])/g, '\\$1')}"`;
const short = (id) => String(id || '').replace(/-/g, '').slice(0, 8).toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

class NotLive extends Error {}

// ---------------------------------------------------------------------------------------------
// Words and flags

/** Flags from the raw words. Unknown flags are refused so a typo never changes anything. */
function parse(rawArgs) {
  const words = [];
  const flags = {};
  const seen = { hour: false };
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = String(rawArgs[i]);
    if (!seen.hour && arg === 'hour') { seen.hour = true; continue; }
    if (arg === '-h') { flags.help = true; continue; }
    const m = /^--([a-z][a-z-]*)(=([\s\S]*))?$/.exec(arg);
    if (!m) { words.push(arg); continue; }
    const key = m[1];
    if (VALUES.has(key)) {
      if (m[2] !== undefined) flags[key] = m[3];
      else if (i + 1 < rawArgs.length) flags[key] = String(rawArgs[++i]);
      else return { error: `--${key} needs a value.` };
    } else if (SWITCHES.has(key)) {
      if (m[2] !== undefined) return { error: `--${key} takes no value.` };
      flags[key] = true;
    } else {
      return { error: `atris nexus hour does not take --${key}, so nothing was changed. See: atris nexus --help` };
    }
  }
  return { words, flags };
}

const given = (flags, key) => (typeof flags[key] === 'string' ? flags[key].trim() : '');

function whole(value, least, most) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= least && n <= most ? n : null;
}

// ---------------------------------------------------------------------------------------------
// The clock: the only thing kept on this computer.

function clockFile(deps = {}) {
  const env = deps.env || process.env;
  return deps.hourFile || env.ATRIS_NEXUS_HOUR_FILE || path.join(os.homedir(), '.atris', 'nexus-hour.json');
}

function readClock(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error('The hour\'s clock on this computer could not be read.');
  }
  try {
    const clock = JSON.parse(text);
    return clock && typeof clock === 'object' && clock.list_id ? clock : null;
  } catch {
    return null;
  }
}

function writeClock(file, clock) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clock, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function clearClock(file) {
  try { fs.unlinkSync(file); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
}

function timeOf(clock, now) {
  const start = Date.parse(clock.started_at);
  const end = Date.parse(clock.ends_at);
  const total = Math.max(1, Math.round((end - start) / 60000));
  const used = Math.max(0, Math.floor((now.getTime() - start) / 60000));
  const left = Math.max(0, Math.ceil((end - now.getTime()) / 60000));
  const nextBeat = Math.min(total, (Math.floor(used / BEAT_MINUTES) + 1) * BEAT_MINUTES);
  return { total, used: Math.min(used, total), left, up: now.getTime() >= end, nextBeat };
}

// ---------------------------------------------------------------------------------------------
// The store

function storeApi(request, token) {
  const call = async (method, pathname, body, { soon = false, read = method === 'GET' } = {}) => {
    const result = await request(pathname, { token, method, timeoutMs: WAIT_MS, retries: read ? 1 : 0, ...(body === undefined ? {} : { body }) });
    if (result && result.ok) return result.data && typeof result.data === 'object' ? result.data : {};
    const status = result ? result.status : 0;
    const detail = result && result.data && result.data.detail;
    // A route that is not there yet answers 404 with FastAPI's own "Not Found", or 405.
    if (soon && (status === 405 || (status === 404 && (!detail || detail === 'Not Found')))) throw new NotLive(pathname);
    if (status === 402) throw Object.assign(new Error(LOCKED_LINE), { status: 402 });
    if (status === 401) throw new Error('Sign in to see your people. Run: atris login');
    if (status === 503) throw new Error('The people store is paused for a few minutes. Nothing was saved. Try again shortly.');
    if (status === 0 || status >= 500) throw new Error(read ? 'The people store did not answer. Try again in a moment.' : 'That may not have saved. Check with atris nexus hour, then try again.');
    throw new Error(S.plainError(result));
  };
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    patch: (p, b, o) => call('PATCH', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
  };
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------
// New-only adds: the strict way in. Anyone Nexus already knows is skipped with nothing changed.

/** The signed-in account as a short one-way mark, or '' when it cannot be told. */
function accountMark(got, token) {
  let id = got && typeof got.account === 'string' ? got.account.trim() : '';
  if (!id) {
    try {
      const part = String(token || '').split('.')[1];
      const claims = part ? JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) : null;
      if (claims && typeof claims.sub === 'string') id = claims.sub.trim();
    } catch {
      id = '';
    }
  }
  return id ? crypto.createHash('sha256').update(`nexus-hour-account\n${id}`).digest('hex').slice(0, 32) : '';
}

/** The screen that checks connected data before anything is sent. Loaded only when it is used. */
function screenFor(deps) {
  if (typeof deps.screenNewProspect === 'function') return deps.screenNewProspect;
  try {
    const mod = require('../lib/nexus-new-only-screen');
    return mod && typeof mod.screenNewProspect === 'function' ? mod.screenNewProspect : null;
  } catch {
    return null;
  }
}

/** One add on one list, the same every time it is asked, whatever day it is. */
function newOnlyRef(account, listId, fields) {
  const parts = [account, listId, nameKey(fields.name), String(fields.email || '').toLowerCase(), nameKey(fields.company),
    nameKey(fields.title), nameKey(fields.city), fields.website || '', fields.linkedin_url || '', fields.x || '',
    fields.source_url, fields.words];
  return `hour-new-${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 40)}`;
}

/** The new-only answer from Nexus, or null when it is not one this command can trust. */
function readNewOnly(data) {
  if (!data || typeof data !== 'object') return null;
  const status = String(data.status || '');
  if (!NEW_ONLY_STATUSES.has(status)) return null;
  if (status === 'skipped') return { status };
  const id = String(data.person_id || '');
  return UUID.test(id) ? { status, id: id.toLowerCase() } : null;
}

const NEW_ONLY_UNSURE = 'Nexus did not say whether they were added. Run the same command again: it will not add them twice.';

function newOnlyError(result) {
  const status = result ? result.status : 0;
  if (status === 404) return new Error('Nexus could not find the list or the new-only capture endpoint. Nothing was saved.');
  if (status === 405) return new Error('This Nexus server does not support adding only new people. Nothing was saved.');
  if (status === 402) return Object.assign(new Error(LOCKED_LINE), { status: 402 });
  if (status === 401) return new Error('Sign in to see your people. Run: atris login');
  if (status === 503) return new Error('The people store is paused for a few minutes. Nothing was saved. Try again shortly.');
  if (status === 0 || status >= 500) return new Error(NEW_ONLY_UNSURE);
  return new Error(S.plainError(result));
}

async function myLists(api) {
  const data = await api.get('/nexus/lists');
  return (Array.isArray(data.lists) ? data.lists : []).filter((l) => l && l.id);
}

const nameKey = (name) => clean(name).toLowerCase();

/** Every card on one saved list, a page at a time. Search words never leave the body. */
async function listPeople(api, listId) {
  const all = [];
  for (let offset = 0; offset < MOST_PEOPLE; offset += PAGE) {
    const data = await api.post('/nexus/people/search', { list_id: listId, limit: PAGE, offset }, { read: true });
    const page = Array.isArray(data.people) ? data.people.filter((c) => c && c.id) : [];
    all.push(...page);
    const total = Number(data.total);
    if (page.length < PAGE || (Number.isFinite(total) && all.length >= total)) break;
  }
  return all;
}

/** { [person_id]: draft } from the drafts route, or null when it is not live yet. */
async function listDrafts(api, listId) {
  try {
    const data = await api.get(`/nexus/lists/${enc(listId)}/drafts`, { soon: true });
    const out = {};
    for (const d of Array.isArray(data.drafts) ? data.drafts : []) if (d && d.person_id) out[String(d.person_id)] = d;
    return out;
  } catch (error) {
    if (error instanceof NotLive) return null;
    throw error;
  }
}

async function listScore(api, listId) {
  try {
    return await api.get(`/nexus/lists/${enc(listId)}/score`, { soon: true });
  } catch (error) {
    if (error instanceof NotLive) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a card, tolerant of anything missing.

const priv = (c) => (c && c.private && typeof c.private === 'object' ? c.private : {});
const extras = (c) => (priv(c).extra && typeof priv(c).extra === 'object' ? priv(c).extra : {});
const col = (c, name) => {
  const got = extras(c)[`col_${name}`];
  return got && typeof got === 'object' ? got : null;
};
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const REACHED = new Set(['reached_out', 'replied', 'met', 'paying', 'partner']);
const REPLIED = new Set(['replied', 'met', 'paying', 'partner']);

function personView(c, drafts, scored) {
  const p = priv(c);
  const level = col(c, 'research_level') ? num(col(c, 'research_level').v) : 0;
  const confidence = col(c, 'confidence') ? num(col(c, 'confidence').v) : null;
  const hook = col(c, 'hook') ? clean(col(c, 'hook').v) : '';
  const hookSource = col(c, 'hook') ? clean(col(c, 'hook').src) : '';
  const emailCheck = col(c, 'email_status');
  const draft = (drafts && drafts[String(c.id)]) || (extras(c).draft && typeof extras(c).draft === 'object' ? extras(c).draft : null);
  const stage = String(p.stage || 'found');
  const score = scored && scored[String(c.id)];
  const reached = score ? !!score.reached : REACHED.has(stage);
  const replied = score ? !!score.replied : REPLIED.has(stage);
  const email = clean(p.email);
  const view = {
    id: String(c.id),
    short: short(c.id),
    name: clean(c.name),
    company: clean(c.company_name || (c.org && c.org.name)),
    city: clean(c.location_raw || (c.place && c.place.city)),
    website: clean(c.website),
    email,
    email_confirmed: email ? !(emailCheck && emailCheck.v === 'unconfirmed') : false,
    level,
    confidence,
    hook,
    source: hookSource,
    drafted: !!draft,
    draft_subject: draft ? clean(draft.subject) : '',
    stage,
    reached,
    replied,
    due_on: p.due_on ? String(p.due_on).slice(0, 10) : '',
    next_move: clean(p.next_move),
  };
  view.confident = view.confidence !== null && view.confidence >= READY_AT;
  view.ready = view.confident && view.level >= 2 && view.drafted && !view.reached;
  return view;
}

function tally(people) {
  return {
    on_list: people.length,
    level_1: people.filter((p) => p.level >= 1).length,
    level_2: people.filter((p) => p.level >= 2).length,
    confident: people.filter((p) => p.confident).length,
    drafted: people.filter((p) => p.drafted).length,
    ready: people.filter((p) => p.ready).length,
    reached: people.filter((p) => p.reached).length,
    replied: people.filter((p) => p.replied).length,
  };
}

/** The one person who most needs work: no research yet, then level 1 only, then confident with no note. */
function nextPerson(people) {
  const open = people.filter((p) => !p.reached);
  const tiers = [
    ['no research yet', (p) => p.level < 1],
    ['researched the business, not yet the person', (p) => p.level === 1],
    ['confident, with no note stored', (p) => p.level >= 2 && p.confident && !p.drafted],
  ];
  for (const [why, test] of tiers) {
    const hit = open.find(test);
    if (hit) return { person: hit, why };
  }
  return null;
}

function missingOf(p) {
  const out = [];
  if (!p.email) out.push('an email');
  else if (!p.email_confirmed) out.push('a checked email');
  if (p.level < 1) out.push('level 1 research (the business)');
  if (p.level < 2) out.push('level 2 research (the person)');
  if (p.confidence === null) out.push('a confidence');
  if (!p.hook) out.push('the one specific reason');
  if (!p.drafted) out.push('a note');
  return out;
}

function commandFor(p, why) {
  const who = quote(p.name || p.short);
  if (why === 'no research yet') return `atris nexus hour research ${who} --level 1 --confidence <0-100> --source <url> --why "<one line>"`;
  if (why.startsWith('researched the business')) return `atris nexus hour research ${who} --level 2 --confidence <0-100> --source <url> --why "<one line>"`;
  return `atris nexus hour draft ${who} --subject "<subject>" --body-file <path>`;
}

const sendLine = (p) => `open ${CARD_BASE}/${p.short}`;

// ---------------------------------------------------------------------------------------------
// The screens

const HEADS = [['on_list', 'on list'], ['level_1', 'level 1'], ['level_2', 'level 2'], ['confident', 'confident'],
  ['drafted', 'drafted'], ['ready', 'ready'], ['reached', 'reached'], ['replied', 'replied']];

function scoreboard(counts) {
  const widths = HEADS.map(([key, head]) => Math.max(head.length, String(counts[key]).length));
  const row = (cells) => `  ${cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')}`.replace(/\s+$/, '');
  return [row(HEADS.map(([, head]) => head)), row(HEADS.map(([key]) => counts[key]))];
}

function nextThing(counts, time, pick) {
  if (time.up) return { line: 'Time is up. End the hour and say what you learned.', command: 'atris nexus hour end --learned "<what you learned>"' };
  if (!counts.on_list) return { line: 'Add the first person to the list.', command: 'atris nexus hour add "<name>" --email <email> --source <page it was on> --why "<why them>"' };
  if (counts.ready) return { line: `${plural(counts.ready, 'person is', 'people are')} ready for your press.`, command: 'atris nexus hour ready' };
  if (pick) {
    const p = pick.person;
    const what = pick.why === 'no research yet' ? `Research ${p.name}'s business`
      : pick.why.startsWith('researched the business') ? `Research ${p.name} as a person` : `Store your note to ${p.name}`;
    return { line: `${what}.`, command: commandFor(p, pick.why) };
  }
  return { line: 'Everyone on the list is worked. Add more people.', command: 'atris nexus hour add "<name>" --email <email> --source <page it was on>' };
}

// ---------------------------------------------------------------------------------------------

async function run(ctx) {
  const { log, err, deps } = ctx;
  const now = ctx.now || new Date();
  const parsed = parse(ctx.rawArgs || []);
  const json = !!(parsed.flags && parsed.flags.json) || (ctx.rawArgs || []).some((a) => String(a) === '--json');
  const out = (data) => log(JSON.stringify(data));
  const fail = (message, code = 1, extra = {}) => {
    if (json) out({ ok: false, error: clean(message), ...extra });
    else err(clean(message));
    return code;
  };
  if (parsed.error) return fail(parsed.error, 2);
  const { words, flags } = parsed;
  if (flags.help) { log(HELP.join('\n')); return 0; }
  const sub = words.length ? words[0] : 'status';
  if (!SUBS.has(sub)) return fail(`"${clean(sub)}" is not part of atris nexus hour. Use start, add, next, research, draft, ready or end.`, 2);
  const env = deps.env || process.env;
  const helper = !!flags['as-helper'] || AGENT_MARKS.some((mark) => String(env[mark] || '').trim() !== '');
  const by = helper ? String(env.ATRIS_MEMBER || 'helper').slice(0, 40) : 'you';
  const file = clockFile(deps);

  // Checks that need nothing from the store come first, so a refusal never makes a call.
  let clock;
  try {
    clock = readClock(file);
  } catch (error) {
    return fail(error.message);
  }
  // New-only: asked for on start or add, or kept on the clock by a new-only start. A clock that was
  // started new-only can never add the old way, and a mode this version does not know is treated
  // the same, so nothing quietly falls back.
  const clockStrict = !!clock && clock.mode !== undefined;
  const strictStart = sub === 'start' && !!flags['new-only'];
  const strictAdd = sub === 'add' && (clockStrict || !!flags['new-only']);
  if (flags['new-only'] && sub !== 'start' && sub !== 'add') return fail('--new-only goes with start or add. Nothing was changed.', 2);
  if (!strictAdd && NEW_ONLY_FIELDS.some((k) => flags[k] !== undefined)) {
    return fail('--title, --linkedin and --x go with a new-only add: atris nexus hour add "<name>" --new-only ... Nothing was changed.', 2);
  }
  if ((strictStart || strictAdd) && (given(flags, 'person') || flags.new)) {
    return fail('A new-only add takes neither --person nor --new: it adds only people new to your Nexus and skips anyone already known. Nothing was changed.', 2);
  }
  if (strictAdd) {
    if (clockStrict && (clock.mode !== NEW_ONLY || !clock.account)) return fail('This hour\'s clock cannot tell which account started it, so nothing was added. End it and start again with --new-only.', 1);
    const source = given(flags, 'source');
    if (!source) return fail('A new-only add needs the page you found them on: --source <url>. Nothing was saved.', 2);
    if (!/^https?:\/\/\S+$/i.test(source)) return fail('--source is the web address of the page you found them on, starting with https://. Nothing was saved.', 2);
    if (source.length > SOURCE_MOST) return fail(`Keep --source under ${SOURCE_MOST} characters. Nothing was saved.`, 2);
    if (!given(flags, 'why')) return fail('A new-only add needs the one reason for them: --why "<why them>". Nothing was saved.', 2);
    if (given(flags, 'why').length > WHY_MOST) return fail(`Keep --why to one line, under ${WHY_MOST} characters. Nothing was saved.`, 2);
  }

  if (sub === 'start') {
    if (clock) {
      const t = timeOf(clock, now);
      return fail(t.up
        ? 'An hour is still open and its time is up. End it first: atris nexus hour end --learned "<what you learned>"'
        : `An hour is already running, ${plural(t.left, 'minute', 'minutes')} left. End it first: atris nexus hour end`, 1, { running: true });
    }
    if (!given(flags, 'guess')) return fail(NO_GUESS, 2);
    if (given(flags, 'guess').length > GUESS_MOST) return fail(`Keep the guess under ${GUESS_MOST} characters.`, 2);
    if (!clean(words.slice(1).join(' ')) && !given(flags, 'list')) return fail('Name the cluster, like: atris nexus hour start "plant shop owners in Austin" --guess "..."', 2);
    if (flags.minutes !== undefined && whole(flags.minutes, 5, 240) === null) return fail('--minutes takes a whole number from 5 to 240.', 2);
  } else if (!clock) {
    if (sub === 'status' && json) { out({ ok: true, running: false }); return 0; }
    if (sub === 'status') { log(NOT_RUNNING); return 0; }
    return fail(NOT_RUNNING);
  }
  if (sub === 'add' && !clean(words.slice(1).join(' '))) return fail('atris nexus hour add needs a name, like: atris nexus hour add "Rae Sample" --email rae@example.com', 2);
  if (sub === 'research') {
    if (!clean(words.slice(1).join(' '))) return fail('atris nexus hour research needs a name.', 2);
    const level = whole(flags.level, 1, 2);
    if (level === null) return fail('--level is 1 (the business) or 2 (the person).', 2);
    if (flags.confidence !== undefined && whole(flags.confidence, 0, 100) === null) return fail('--confidence is a whole number from 0 to 100.', 2);
    if (!given(flags, 'source')) return fail('Research counts only with the page it came from. Add --source <url>. Nothing was saved.', 2);
    if (given(flags, 'source').length > SOURCE_MOST) return fail(`Keep --source under ${SOURCE_MOST} characters.`, 2);
    if (given(flags, 'why').length > WHY_MOST) return fail(`Keep --why to one line, under ${WHY_MOST} characters.`, 2);
  }
  let draftText;
  if (sub === 'draft') {
    if (!clean(words.slice(1).join(' '))) return fail('atris nexus hour draft needs a name.', 2);
    if (!given(flags, 'subject')) return fail('atris nexus hour draft needs --subject "...".', 2);
    if (given(flags, 'subject').length > SUBJECT_MOST) return fail(`Keep the subject under ${SUBJECT_MOST} characters.`, 2);
    if (!given(flags, 'body-file')) return fail('atris nexus hour draft needs --body-file <path> with the note you wrote.', 2);
    if (flags.step !== undefined && whole(flags.step, 1, 3) === null) return fail('--step is 1 for the first note, or 2 or 3 for a follow-up.', 2);
    try {
      draftText = fs.readFileSync(path.resolve(given(flags, 'body-file')), 'utf8').replace(/\s+$/, '');
    } catch {
      return fail('That note file could not be read. Nothing was stored.', 2);
    }
    if (!draftText.trim()) return fail('That note file is empty. Nothing was stored.', 2);
    if (draftText.length > BODY_MOST) return fail(`Keep the note under ${BODY_MOST} characters. Nothing was stored.`, 2);
  }
  if (sub === 'end' && given(flags, 'learned').length > LEARNED_MOST) return fail(`Keep what you learned under ${LEARNED_MOST} characters.`, 2);

  let token;
  let account = '';
  try {
    const got = await ctx.getToken();
    token = got && got.token;
    account = accountMark(got, token);
  } catch (error) {
    return fail(error && error.message);
  }
  if (!token) return fail(ctx.notLoggedIn || 'Sign in first: atris login');
  if ((strictStart || strictAdd) && !account) return fail('Could not tell which account is signed in, so nothing was changed. Sign in again: atris login', 1);
  if (strictAdd && clockStrict && clock.account !== account) {
    return fail('A different account is signed in than the one that started this hour, so nothing was added. Sign in to that account, or end the hour and start a new one.', 1);
  }
  const api = storeApi(ctx.request, token);
  const notLive = [];
  const say = (key) => { if (!notLive.includes(key)) notLive.push(key); };
  const sayNotLive = () => { if (!json) for (const key of notLive) log(NOT_LIVE[key]); };

  // Everyone on the hour's list as the hour sees them.
  const gather = async (listId) => {
    const [cards, drafts, score] = await Promise.all([listPeople(api, listId), listDrafts(api, listId), listScore(api, listId)]);
    if (drafts === null) say('drafts');
    if (score === null) say('score');
    const scored = score && Array.isArray(score.people)
      ? Object.fromEntries(score.people.filter((r) => r && r.person_id).map((r) => [String(r.person_id), r])) : null;
    const people = cards.map((c) => personView(c, drafts, scored));
    const counts = tally(people);
    if (score && score.counts && typeof score.counts === 'object') {
      counts.reached = num(score.counts.reached);
      counts.replied = num(score.counts.replied);
    }
    const experiment = score && score.experiment && typeof score.experiment === 'object' ? score.experiment : null;
    return { cards, people, counts, experiment, score };
  };

  // One person on the hour's list: a whole or short id, an exact name, or the only name holding the words.
  const resolve = (people, query) => {
    const want = clean(query).toLowerCase();
    const hex = want.replace(/-/g, '');
    if (/^[0-9a-f]{8,32}$/.test(hex)) {
      const byId = people.filter((p) => p.id.replace(/-/g, '').toLowerCase().startsWith(hex));
      if (byId.length === 1) return { person: byId[0] };
    }
    const exact = people.filter((p) => p.name.toLowerCase() === want);
    if (exact.length === 1) return { person: exact[0] };
    const close = exact.length ? exact : people.filter((p) => p.name.toLowerCase().includes(want));
    if (close.length === 1) return { person: close[0] };
    if (!close.length) return { stop: fail('No one on this hour\'s list matches that. Add them first: atris nexus hour add "<name>"', 1, { matches: 0 }) };
    if (json) out({ ok: false, error: `${close.length} people on this hour's list match. Use the id.`, matches: close.map((p) => ({ id: p.id, name: p.name })) });
    else {
      log(`${close.length} people on this hour's list match. Use the id:`);
      for (const p of close.slice(0, 10)) log(`  ${p.short}  ${p.name}${p.company ? `, ${p.company}` : ''}`);
    }
    return { stop: 1 };
  };

  try {
    if (sub === 'start') {
      const minutes = flags.minutes !== undefined ? whole(flags.minutes, 5, 240) : 60;
      const cluster = clean(words.slice(1).join(' '));
      const lists = await myLists(api);
      let list;
      let made = false;
      if (given(flags, 'list')) {
        const want = given(flags, 'list');
        list = lists.find((l) => String(l.id).toLowerCase() === want.toLowerCase())
          || lists.find((l) => nameKey(l.name) === nameKey(want));
        if (!list) return fail('None of your saved lists has that name or id. Nothing was started.', 1);
      } else {
        list = lists.find((l) => nameKey(l.name) === nameKey(cluster));
        if (!list) {
          const ref = `hour-${crypto.createHash('sha256').update(`${nameKey(cluster)}\n${localDay(now)}`).digest('hex').slice(0, 32)}`;
          const saved = await api.post('/nexus/lists', { name: cluster, ref, person_ids: [], made_by: helper ? 'helper' : 'me' });
          list = saved.list || {};
          if (!list.id) return fail('Nexus did not give back the new list, so the hour did not start. Try again.');
          made = true;
        }
      }
      const guess = given(flags, 'guess');
      let guessSaved = true;
      try {
        await api.patch(`/nexus/lists/${enc(list.id)}/experiment`, { guess, started_at: localDay(now) }, { soon: true });
      } catch (error) {
        if (!(error instanceof NotLive)) throw error;
        guessSaved = false;
        say('experiment');
      }
      const clockNow = {
        list_id: String(list.id),
        cluster: cluster || clean(list.name),
        started_at: now.toISOString(),
        ends_at: new Date(now.getTime() + minutes * 60000).toISOString(),
        ...(guessSaved ? {} : { guess }),
        ...(strictStart ? { mode: NEW_ONLY, account } : {}),
      };
      writeClock(file, clockNow);
      if (json) {
        out({ ok: true, did: 'start', list: { id: String(list.id), name: clean(list.name), count: num(list.count), made }, cluster: clockNow.cluster, minutes, ends_at: clockNow.ends_at, guess_saved: guessSaved, new_only: strictStart, not_live: notLive });
        return 0;
      }
      log(`The hour started: ${minutes} minutes on ${quote(clockNow.cluster)}.`);
      log(made ? 'A new saved list was made for it.' : `It runs on your saved list ${quote(clean(list.name))}, ${plural(num(list.count), 'person', 'people')} on it.`);
      if (strictStart) log('New people only: anyone already in your Nexus is skipped and left as it is, for the whole hour.');
      log(`Guess: ${guess}`);
      log(`Research every ${BEAT_MINUTES} minutes, two levels deep. A note is ready at confidence ${READY_AT} or more.`);
      sayNotLive();
      log('');
      log('See where it stands: atris nexus hour');
      return 0;
    }

    if (strictAdd) {
      // Nexus makes the card, keeps where they were found and why, and puts them on the list in one
      // step. This side never touches the list or the card itself, not even on a replay.
      const name = clean(words.slice(1).join(' '));
      const email = given(flags, 'email');
      const sourceUrl = given(flags, 'source');
      const reason = given(flags, 'why').replace(/\s+/g, ' ');
      const fields = { name, source_url: sourceUrl, words: `Why reach out: ${reason}\nSource: ${sourceUrl}` };
      if (email) fields.email = email;
      if (given(flags, 'company')) fields.company = given(flags, 'company');
      if (given(flags, 'title')) fields.title = given(flags, 'title');
      if (given(flags, 'city')) fields.city = given(flags, 'city');
      if (given(flags, 'site')) fields.website = given(flags, 'site');
      if (given(flags, 'linkedin')) fields.linkedin_url = given(flags, 'linkedin');
      if (given(flags, 'x')) fields.x = given(flags, 'x');
      const listId = String(clock.list_id);
      const lists = await myLists(api);
      if (!lists.some((l) => String(l.id).toLowerCase() === listId.toLowerCase())) {
        return fail('This hour\'s list is not one of the signed-in account\'s saved lists, so nothing was added.', 1);
      }
      // What the check looked through, when it says, so the owner knows how far "new" was checked.
      let looked = {};
      const lookedLine = () => {
        if (!looked.contacts_scope) return;
        const { gmail, calendar, contacts } = looked.checked;
        const sources = [
          gmail && `${gmail} ${gmail === 1 ? 'mailbox' : 'mailboxes'}`,
          calendar && `${calendar} ${calendar === 1 ? 'calendar' : 'calendars'}`,
          contacts && `${contacts} Google Contacts ${contacts === 1 ? 'account' : 'accounts'}`,
        ].filter(Boolean);
        if (sources.length) log(`Checked ${sources.join(', ')}.`);
        if (looked.contacts_scope === 'not_connected') log('Google Contacts was not checked.');
      };
      // Two kinds of known: you have written to or met them (the check), or Nexus already has their card.
      const skipped = (by) => {
        if (json) { out({ ok: true, did: 'add', new_only: true, status: 'skipped', list_id: listId, skipped_by: by, ...looked }); return 0; }
        log(by === 'correspondence'
          ? `${name} is already in your email, calendar or contacts, so they were skipped. Nothing was added or changed.`
          : `${name} already has a card in your Nexus, so they were skipped. Nothing was added or changed.`);
        lookedLine();
        return 0;
      };
      const screen = screenFor(deps);
      if (!screen) return fail('The check of your email, calendar and contacts could not run, so nothing was added.', 1, { new_only: true });
      let screened;
      try {
        screened = await screen({ request: ctx.request, token, name, email: email || null });
      } catch {
        screened = null;
      }
      const verdict = screened && typeof screened === 'object' ? screened.status : '';
      if (verdict && screened.checked && typeof screened.checked === 'object' && ['connected', 'not_connected'].includes(screened.contacts_scope)) {
        const c = screened.checked;
        looked = { checked: { gmail: num(c.gmail), calendar: num(c.calendar), contacts: num(c.contacts) }, contacts_scope: screened.contacts_scope };
      }
      if (verdict === 'matched') return skipped('correspondence');
      if (verdict !== 'clear') return fail('Nexus could not verify this person against your connected accounts. Check your Google connections in Atris. Nothing was added.', 1, { new_only: true, ...looked });
      const body = { ...fields, ref: newOnlyRef(account, listId, fields), list_id: listId, source: 'command_line' };
      const result = await ctx.request('/nexus/capture/new-only', { token, method: 'POST', body, timeoutMs: WAIT_MS, retries: 0 });
      if (!result || !result.ok) throw newOnlyError(result);
      const got = readNewOnly(result.data);
      if (!got) return fail(NEW_ONLY_UNSURE, 1, { new_only: true });
      if (got.status === 'skipped') return skipped('nexus');
      if (json) { out({ ok: true, did: 'add', new_only: true, status: got.status, id: got.id, list_id: listId, ...looked }); return 0; }
      log(got.status === 'replayed' ? `${name} was already added by this same command. Nothing was added twice.` : `${name} is new, so they are in your Nexus and on the hour's list.`);
      lookedLine();
      log(`Next: atris nexus hour research ${quote(name)} --level 1 --confidence <0-100> --source <url> --why "<one line>"`);
      return 0;
    }

    if (sub === 'add') {
      const name = clean(words.slice(1).join(' '));
      const email = given(flags, 'email');
      const source = given(flags, 'source');
      const why = given(flags, 'why');
      if (source.length > SOURCE_MOST) return fail(`Keep --source under ${SOURCE_MOST} characters.`, 2);
      const note = [why, source ? `Found on ${source}` : ''].filter(Boolean).join('\n');
      const body = { name, words: note, source: 'command_line' };
      if (given(flags, 'company')) body.company = given(flags, 'company');
      if (given(flags, 'city')) body.city = given(flags, 'city');
      if (given(flags, 'site')) body.website = given(flags, 'site');
      if (email) body.email = email;
      if (given(flags, 'person')) body.person_id = given(flags, 'person').toLowerCase();
      if (flags.new) body.new = true;
      body.ref = `hour-${crypto.createHash('sha256').update([clock.list_id, nameKey(name), email, note, body.person_id || '', body.new ? 'new' : '', localDay(now)].join('\n')).digest('hex').slice(0, 40)}`;
      const answer = await api.post('/nexus/capture', body);
      const choices = Array.isArray(answer.choices) ? answer.choices.filter((c) => c && UUID.test(String(c.person_id || ''))) : [];
      if (choices.length) {
        const shown = choices.map((c) => ({ person_id: c.person_id, name: clean(c.name), company: clean(c.company) }));
        if (json) out({ ok: false, saved: false, needs_choice: true, error: 'Nothing was saved: this could be someone already on your list. Add --person <id>, or --new for someone new.', choices: shown });
        else {
          log('Nothing was saved. This could be someone already in Nexus:');
          for (const c of shown) log(`  ${c.person_id}  ${c.name}${c.company ? `, ${c.company}` : ''}`);
          log('Run the same command again with --person <id>, or --new for someone new.');
        }
        return 3;
      }
      const id = String(answer.person_id || '');
      if (!UUID.test(id)) return fail('Nexus did not give back a card, so they were not put on the list. Check atris nexus hour before adding again.');
      await api.post(`/nexus/lists/${enc(clock.list_id)}/people`, { add: [id] });
      if (email) {
        const check = source
          ? { v: 'read on a page', by, at: now.toISOString(), src: source }
          : { v: 'unconfirmed', by, at: now.toISOString() };
        await api.patch(`/nexus/people/${enc(id)}/mine`, { extra: { col_email_status: check } });
      }
      const emailState = email ? (source ? 'read on a page' : 'unconfirmed') : 'none';
      if (json) { out({ ok: true, did: 'add', id, list_id: clock.list_id, made: !!answer.made, email: emailState }); return 0; }
      log(`${name} is on the hour's list${answer.matched_by ? ' (already in Nexus, so their card was used)' : ''}.`);
      if (email && !source) log('Their email is marked unconfirmed. Give --source with the page you read it on to count it.');
      if (!email) log('No email yet.');
      log(`Next: atris nexus hour research ${quote(name)} --level 1 --confidence <0-100> --source <url> --why "<one line>"`);
      return 0;
    }

    if (sub === 'research') {
      const { cards, people } = await gather(clock.list_id);
      const found = resolve(people, words.slice(1).join(' '));
      if (found.stop !== undefined) return found.stop;
      const p = found.person;
      const c = cards.find((x) => String(x.id) === p.id) || {};
      const source = given(flags, 'source');
      const at = now.toISOString();
      const values = { research_level: whole(flags.level, 1, 2) };
      if (flags.confidence !== undefined) values.confidence = whole(flags.confidence, 0, 100);
      if (given(flags, 'why')) values.hook = clean(given(flags, 'why'));
      const extra = {};
      for (const [name, v] of Object.entries(values)) {
        const had = col(c, name);
        if (helper && had && had.by === 'you' && had.v !== v) {
          return fail(`You set ${name} on this card yourself, so a helper does not change it. Nothing was saved.`, 1, { id: p.id, column: name });
        }
        const value = { v, by, at, src: source };
        if (had) value.was = { v: had.v, by: had.by, at: had.at, ...(had.src ? { src: had.src } : {}) };
        extra[`col_${name}`] = value;
      }
      await api.patch(`/nexus/people/${enc(p.id)}/mine`, { extra });
      const after = { ...p, level: values.research_level, confidence: values.confidence !== undefined ? values.confidence : p.confidence, hook: values.hook || p.hook };
      after.confident = after.confidence !== null && after.confidence >= READY_AT;
      if (json) { out({ ok: true, did: 'research', id: p.id, level: after.level, confidence: after.confidence, confident: after.confident, by, source }); return 0; }
      log(`${p.name}: level ${after.level} research kept${after.confidence !== null ? `, confidence ${after.confidence}` : ''}.`);
      if (after.level < 2) log(`Next for them: level 2, the person. atris nexus hour research ${quote(p.name)} --level 2 --confidence <0-100> --source <url> --why "<one line>"`);
      else if (!after.confident) log(`Below ${READY_AT}, so no note goes to them this hour.`);
      else if (!p.drafted) log(`Confident. Store your note: atris nexus hour draft ${quote(p.name)} --subject "<subject>" --body-file <path>`);
      else log('Confident, with a note stored. They show in atris nexus hour ready.');
      return 0;
    }

    if (sub === 'draft') {
      const { people } = await gather(clock.list_id);
      const found = resolve(people, words.slice(1).join(' '));
      if (found.stop !== undefined) return found.stop;
      const p = found.person;
      const step = flags.step !== undefined ? whole(flags.step, 1, 3) : 1;
      try {
        await api.put(`/nexus/people/${enc(p.id)}/draft`, { subject: given(flags, 'subject'), body: draftText, step, list_id: clock.list_id }, { soon: true });
      } catch (error) {
        if (!(error instanceof NotLive)) throw error;
        return fail(NOT_LIVE.draft, 1, { not_live: ['draft'] });
      }
      if (json) { out({ ok: true, did: 'draft', id: p.id, step, chars: draftText.length }); return 0; }
      log(`Your note to ${p.name} is stored (${draftText.length} characters). Nothing was sent.`);
      const ready = p.confident && p.level >= 2;
      log(ready ? 'They are ready. See them: atris nexus hour ready' : `They show as ready once research is at level 2 and confidence is ${READY_AT} or more.`);
      return 0;
    }

    const { people, counts, experiment } = await gather(clock.list_id);
    const time = timeOf(clock, now);
    const guess = clean((experiment && experiment.guess) || clock.guess || '');
    if (!experiment && clock.guess) say('experiment');

    if (sub === 'status') {
      const pick = nextPerson(people);
      const next = nextThing(counts, time, pick);
      if (json) {
        out({ ok: true, running: true, cluster: clock.cluster, list_id: clock.list_id, new_only: clockStrict, minutes_left: time.left, minutes_used: time.used, minutes: time.total, time_up: time.up, guess, counts, next: { line: next.line, command: next.command, person_id: pick && !time.up && !counts.ready ? pick.person.id : null }, not_live: notLive });
        return 0;
      }
      log(`GTM hour: ${clock.cluster}`);
      log(time.up ? `Time is up (${time.total} minutes).` : `${plural(time.left, 'minute', 'minutes')} left, minute ${time.used} of ${time.total}. Next research pass at minute ${time.nextBeat}.`);
      log(`Guess: ${guess || '(none kept)'}`);
      if (clockStrict) log('New people only: anyone already in your Nexus is skipped.');
      log('');
      for (const line of scoreboard(counts)) log(line);
      log('');
      log(`Next: ${next.line}`);
      log(`  ${next.command}`);
      if (notLive.length) log('');
      sayNotLive();
      return 0;
    }

    if (sub === 'next') {
      const pick = nextPerson(people);
      if (!pick) {
        const line = counts.on_list ? 'No one needs work right now. Add more people: atris nexus hour add "<name>"' : 'No one is on the list yet. Add someone: atris nexus hour add "<name>"';
        if (json) out({ ok: true, person: null, line, counts, not_live: notLive });
        else { log(line); sayNotLive(); }
        return 0;
      }
      const p = pick.person;
      const missing = missingOf(p);
      const command = commandFor(p, pick.why);
      if (json) { out({ ok: true, why: pick.why, person: p, missing, command, not_live: notLive }); return 0; }
      log(`Next: ${p.name} (${pick.why})`);
      const known = [p.company, p.city, p.website].filter(Boolean);
      if (p.email) known.push(`${p.email}${p.email_confirmed ? '' : ' (unconfirmed)'}`);
      log(`Known: ${known.length ? known.join(' · ') : 'only the name'}`);
      log(`Research: level ${p.level}${p.confidence !== null ? `, confidence ${p.confidence}` : ''}`);
      if (p.hook) log(`Reason: ${p.hook}${p.source ? ` (${p.source})` : ''}`);
      log(`Missing: ${missing.length ? missing.join(', ') : 'nothing'}`);
      log('');
      log(`  ${command}`);
      sayNotLive();
      return 0;
    }

    if (sub === 'ready') {
      const ready = people.filter((p) => p.ready);
      const shown = ready.map((p) => ({ id: p.id, name: p.name, hook: p.hook, confidence: p.confidence, email_confirmed: p.email_confirmed, subject: p.draft_subject, open: `${CARD_BASE}/${p.short}`, command: sendLine(p) }));
      if (json) { out({ ok: true, sending: 'owner', count: shown.length, ready: shown, not_live: notLive }); return 0; }
      log('Sending is your press. Nothing here sends anything: open each card, read the note, press send.');
      log('');
      if (!shown.length) {
        log(`No one is ready yet. Ready means confidence ${READY_AT} or more, level 2 research and a stored note.`);
        log('See who needs work: atris nexus hour next');
      }
      for (const p of shown) {
        log(`${p.name}, confidence ${p.confidence}${p.email_confirmed ? '' : ', email unconfirmed: check it first'}`);
        log(`  Reason: ${p.hook || '(none kept)'}`);
        log(`  ${p.command}`);
      }
      sayNotLive();
      return 0;
    }

    // end
    const learned = given(flags, 'learned');
    let learnedSaved = false;
    if (learned) {
      try {
        await api.patch(`/nexus/lists/${enc(clock.list_id)}/experiment`, { learned }, { soon: true });
        learnedSaved = true;
      } catch (error) {
        if (!(error instanceof NotLive)) throw error;
        say('learned');
      }
    }
    clearClock(file);
    const followUps = people.filter((p) => p.due_on).sort((a, b) => a.due_on.localeCompare(b.due_on))
      .map((p) => ({ id: p.id, name: p.name, due_on: p.due_on, next_move: p.next_move }));
    if (json) {
      out({ ok: true, ended: true, cluster: clock.cluster, list_id: clock.list_id, minutes_used: time.used, guess, learned, learned_saved: learnedSaved, counts, reply_numbers: notLive.includes('score') ? 'stages' : 'nexus', follow_ups: followUps, not_live: notLive });
      return 0;
    }
    log(`The hour on ${quote(clock.cluster)} is over after ${plural(time.used, 'minute', 'minutes')}.`);
    log(`Guess: ${guess || '(none kept)'}`);
    log(`Result: ${counts.on_list} on the list, ${counts.level_2} researched to the person, ${counts.ready} ready, ${counts.reached} reached, ${counts.replied} replied.`);
    if (learned) log(`Learned: ${learned}`);
    else log('Nothing learned was kept. Say it next time with --learned "...".');
    log('');
    if (followUps.length) {
      log('Follow-ups');
      for (const f of followUps) log(`  ${f.due_on}  ${f.name}${f.next_move ? `: ${f.next_move}` : ''}`);
    } else {
      log('No follow-up dates set on this list yet.');
    }
    if (notLive.length) log('');
    sayNotLive();
    return 0;
  } catch (error) {
    return fail(error && error.message, 1, error && error.status ? { status: error.status } : {});
  }
}

module.exports = { SUBS, HELP, run, parse, nextPerson, personView, tally, READY_AT };
