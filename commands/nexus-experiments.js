'use strict';

// atris nexus lists / experiment / score / guess / learned / common / alike / compare / drafts:
// a saved list in Nexus as an experiment, from the terminal.
//
// A list is given by its exact name (any case) or its id. The name is looked up through
// GET /nexus/lists; only the list id ever goes in a web address. Names, guesses, what was
// learned and the words for a new experiment travel in request bodies.
//
// Backend (atrisos-backend routers/nexus_router.py, under /nexus):
//   GET   /lists                    {lists: [{id, name, count, made_by, created_at}]}
//   GET   /lists/{id}/score         {list, experiment, counts, rates, people}   services/nexus_experiments.py
//   PATCH /lists/{id}/experiment    {guess?, started_at?, learned?} -> {list, experiment}
//   POST  /lists/compare            {list_ids} -> {lists: [{list, experiment, counts, rates}], best}
//   GET   /lists/{id}/common        {list_id, count, traits, ties}             services/nexus_alike.py
//   POST  /lists/{id}/alike         {limit, include_catalog} -> {list_id, count, people: [{person_id, name, score, why}]}
//   POST  /lists/{id}/people        {add: [person ids]} -> {list, skipped}
//   GET   /lists/{id}/drafts        {count, without_draft, drafts: [{person_id, step, by, at, subject, body}]}
//   POST  /experiments              not live yet; a 404 or 405 says so in one line.
//
// Nothing here sends anything to anyone. Nothing here writes a log or a file.

const crypto = require('crypto');
const readline = require('readline');
const S = require('../lib/nexus-store');
const { LOCKED_LINE } = require('./nexus-store');

const SUBS = new Set(['lists', 'experiment', 'score', 'guess', 'learned', 'common', 'alike', 'compare', 'drafts']);
const HELP = [
  '  atris nexus lists                   your saved lists, how many on each, and the guess on any that has one',
  '  atris nexus experiment "<name>" --city "<city>" [--work "<words>"] [--group "<list>"] [--guess "<text>"] [--limit N]',
  '                                      make a list to test: who is on it, what they share, more like them, what to do next',
  '  atris nexus score "<list>"          the list\'s numbers: reached, replied, met, became users, paying, and the rates',
  '  atris nexus guess "<list>" "<text>"     keep what you think will happen on the list',
  '  atris nexus learned "<list>" "<text>"   keep what you learned on the list',
  '  atris nexus common "<list>"         what the people on a list share',
  '  atris nexus alike "<list>" [--limit N] [--add] [--yes]   more of your people like them; --add puts them on the list after you say yes',
  '  atris nexus compare "<list>" "<list>" [...]   two to six lists side by side, and the best one so far',
  '  atris nexus drafts "<list>" [--full]   who on the list has a note waiting and who does not; nothing is sent',
  '    a list is its exact name or its id',
];

const VALUES = new Set(['city', 'work', 'group', 'guess', 'limit']);
const SWITCHES = new Set(['json', 'add', 'yes', 'full', 'help']);
const WAIT_MS = 30000;
const GUESS_MOST = 500;
const LEARNED_MOST = 2000;
const NAME_MOST = 80;
const ALIKE_DEFAULT = 25;
const ALIKE_MOST = 100;
const COMPARE_FEWEST = 2;
const COMPARE_MOST = 6;
const PAGE = 200;
const MOST_PEOPLE = 5000;
const CLOSE_MOST = 8;
const TRAITS_SHOWN = 3;
const ALIKE_SHOWN = 5;

const NOT_LIVE = 'Making an experiment in one step is not live on the service yet. Nothing was made.';
const KIND_WORDS = { company: 'Company', city: 'City', school: 'School', title_word: 'Title word', group: 'Group', stage: 'Stage' };
const KIND_ORDER = ['company', 'city', 'school', 'title_word', 'group', 'stage'];

const clean = (value) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const quote = (text) => `"${String(text).replace(/(["\\$`])/g, '\\$1')}"`;
const enc = encodeURIComponent;
const nameKey = (name) => clean(name).toLowerCase();

/** A rate from 0 to 1 as a whole percent, or a dash when there is nothing to divide by. */
function percent(rate) {
  if (rate === null || rate === undefined || rate === '' || !Number.isFinite(Number(rate))) return '-';
  return `${Math.round(Number(rate) * 100)}%`;
}

class NotLive extends Error {}

// ---------------------------------------------------------------------------------------------
// Words and flags

/** Flags from the raw words. Unknown flags are refused so a typo never changes anything. */
function parse(rawArgs, values = VALUES, switches = SWITCHES) {
  const words = [];
  const flags = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = String(rawArgs[i]);
    if (arg === '-h') { flags.help = true; continue; }
    const m = /^--([a-z][a-z-]*)(=([\s\S]*))?$/.exec(arg);
    if (!m) { words.push(arg); continue; }
    const key = m[1];
    if (values.has(key)) {
      if (m[2] !== undefined) flags[key] = m[3];
      else if (i + 1 < rawArgs.length) flags[key] = String(rawArgs[++i]);
      else return { error: `--${key} needs a value.` };
    } else if (switches.has(key)) {
      if (m[2] !== undefined) return { error: `--${key} takes no value.` };
      flags[key] = true;
    } else {
      return { error: `atris nexus ${words[0] || ''} does not take --${key}, so nothing was changed. See: atris nexus --help`.replace(/\s+/g, ' ') };
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

function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer || '').trim()));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The service

function serviceApi(request, token) {
  const call = async (method, pathname, body, { soon = false, read = method === 'GET' } = {}) => {
    const result = await request(pathname, { token, method, timeoutMs: WAIT_MS, retries: read ? 1 : 0, ...(body === undefined ? {} : { body }) });
    if (result && result.ok) return result.data && typeof result.data === 'object' ? result.data : {};
    const status = result ? result.status : 0;
    const detail = result && result.data && result.data.detail;
    // A route that is not there yet answers 404 with FastAPI's own "Not Found", or 405.
    if (soon && (status === 405 || (status === 404 && (!detail || detail === 'Not Found')))) throw new NotLive(pathname);
    if (status === 402) throw Object.assign(new Error(LOCKED_LINE), { status: 402 });
    if (status === 401) throw Object.assign(new Error('Sign in to see your lists. Run: atris login'), { status: 401 });
    if (status === 503) throw Object.assign(new Error('Nexus is paused for a few minutes. Nothing was saved. Try again shortly.'), { status: 503 });
    if (status === 0 || status >= 500) {
      throw Object.assign(new Error(read ? 'Nexus did not answer. Try again in a moment.' : 'That may not have saved. Check with atris nexus lists, then try again.'), { status });
    }
    if (status === 404) throw Object.assign(new Error('That list is not one of yours. See them: atris nexus lists'), { status });
    throw Object.assign(new Error(S.plainError(result)), { status });
  };
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    patch: (p, b, o) => call('PATCH', p, b, o),
  };
}

async function myLists(api) {
  const data = await api.get('/nexus/lists');
  return (Array.isArray(data.lists) ? data.lists : []).filter((l) => l && l.id);
}

/** One saved list by its id or its exact name, any case. Otherwise the close names, so the owner can pick. */
function findList(lists, query) {
  const want = nameKey(query);
  if (!want) return { matches: [], close: [] };
  const byId = lists.filter((l) => String(l.id).toLowerCase() === want);
  if (byId.length === 1) return { list: byId[0] };
  const exact = lists.filter((l) => nameKey(l.name) === want);
  if (exact.length === 1) return { list: exact[0] };
  if (exact.length > 1) return { matches: exact, close: exact };
  const parts = want.split(' ').filter((w) => w.length > 1);
  const close = lists.filter((l) => {
    const name = nameKey(l.name);
    return name.includes(want) || want.includes(name) || parts.some((w) => name.split(' ').includes(w));
  });
  return { matches: [], close };
}

/** A list by name or id, or a stop with the close names printed. */
function resolveList(lists, query, { json, out, err }) {
  const found = findList(lists, query);
  if (found.list) return found;
  const several = found.matches.length > 1;
  const close = found.close.slice(0, CLOSE_MOST);
  const message = several
    ? `${found.matches.length} of your lists are called that. Use the id.`
    : `None of your saved lists is called ${quote(clean(query))}.`;
  if (json) {
    out({ ok: false, error: message, matches: close.map((l) => ({ id: String(l.id), name: clean(l.name) })) });
    return { stop: 1 };
  }
  err(message);
  if (close.length) {
    err(several ? 'They are:' : 'Close ones:');
    for (const l of close) err(`  ${clean(l.name)}${several ? `  ${l.id}` : ''}`);
  } else if (!several) {
    err('See them: atris nexus lists');
  }
  return { stop: 1 };
}

/** Every card on one saved list, a page at a time; only used to put names on drafts. */
async function listNames(api, listId) {
  const names = {};
  for (let offset = 0; offset < MOST_PEOPLE; offset += PAGE) {
    const data = await api.post('/nexus/people/search', { list_id: listId, limit: PAGE, offset }, { read: true });
    const page = Array.isArray(data.people) ? data.people.filter((c) => c && c.id) : [];
    for (const c of page) names[String(c.id)] = clean(c.name);
    const total = Number(data.total);
    if (page.length < PAGE || (Number.isFinite(total) && Object.keys(names).length >= total)) break;
  }
  return names;
}

/** Run a few at a time, keeping the order. */
async function inTurns(items, most, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(most, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The screens

function scoreLines(counts, rates) {
  const c = counts || {};
  const r = rates || {};
  return [
    `  ${num(c.reached)} reached`,
    `  ${num(c.replied)} replied`,
    `  ${num(c.met)} met`,
    `  ${num(c.signed_up)} became users`,
    `  ${num(c.paying)} paying`,
    `  ${percent(r.reply_rate)} replied, ${percent(r.signup_rate)} became users, ${percent(r.paying_rate)} paying`,
  ];
}

function experimentLines(experiment) {
  const e = experiment && typeof experiment === 'object' ? experiment : {};
  const lines = [];
  if (clean(e.guess)) lines.push(`Guess: ${clean(e.guess)}`);
  if (clean(e.started_at)) lines.push(`Started: ${clean(e.started_at).slice(0, 10)}`);
  if (clean(e.learned)) lines.push(`Learned: ${clean(e.learned)}`);
  return lines;
}

function traitsOf(common) {
  if (Array.isArray(common)) return common;
  return common && Array.isArray(common.traits) ? common.traits : [];
}

function alikeOf(alike) {
  if (Array.isArray(alike)) return alike;
  return alike && Array.isArray(alike.people) ? alike.people : [];
}

function traitLine(t, total) {
  return `${clean(t.label || t.key)}, ${num(t.count)}${total ? ` of ${total}` : ''}`;
}

function alikeLine(p) {
  const why = Array.isArray(p.why) ? p.why.map(clean).filter(Boolean).join(', ') : '';
  return `${clean(p.name) || 'Someone'}, score ${num(p.score)}${why ? `: ${why}` : ''}`;
}

function grid(rows, indent = '  ') {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => indent + r.map((c, i) => String(c).padEnd(widths[i])).join('  ').replace(/\s+$/, ''));
}

// ---------------------------------------------------------------------------------------------

async function run(ctx) {
  const { log, err } = ctx;
  const parsed = parse(ctx.rawArgs || []);
  const json = (ctx.rawArgs || []).some((a) => String(a) === '--json');
  const out = (data) => log(JSON.stringify(data));
  const fail = (message, code = 1, extra = {}) => {
    if (json) out({ ok: false, error: clean(message), ...extra });
    else err(clean(message));
    return code;
  };
  if (parsed.error) return fail(parsed.error, 2);
  const { words, flags } = parsed;
  const sub = words[0];
  if (flags.help) { log(HELP.join('\n')); return 0; }

  // Checks that need nothing from the service come first, so a refusal never makes a call.
  const needsList = ['score', 'guess', 'learned', 'common', 'alike', 'drafts'];
  if (needsList.includes(sub) && !clean(words[1])) return fail(`atris nexus ${sub} needs a list, its name or its id. See them: atris nexus lists`, 2);
  if (sub === 'guess' || sub === 'learned') {
    const text = clean(words.slice(2).join(' '));
    if (!text) return fail(`atris nexus ${sub} needs the list and the words, like: atris nexus ${sub} "Austin plant shops" "${sub === 'guess' ? 'owners reply to one-line notes' : 'Tuesday mornings got the replies'}"`, 2);
    const most = sub === 'guess' ? GUESS_MOST : LEARNED_MOST;
    if (text.length > most) return fail(`Keep it under ${most} characters.`, 2);
  }
  if (sub === 'compare') {
    const asked = words.slice(1).map(clean).filter(Boolean);
    if (asked.length < COMPARE_FEWEST || asked.length > COMPARE_MOST) return fail(`atris nexus compare takes ${COMPARE_FEWEST} to ${COMPARE_MOST} lists, like: atris nexus compare "Austin plant shops" "Austin bakeries"`, 2);
  }
  if (sub === 'alike' && flags.limit !== undefined && whole(flags.limit, 1, ALIKE_MOST) === null) return fail(`--limit takes a whole number from 1 to ${ALIKE_MOST}.`, 2);
  if (sub === 'experiment') {
    const name = clean(words.slice(1).join(' '));
    if (!name) return fail('atris nexus experiment needs a name, like: atris nexus experiment "Austin plant shops" --city Austin --work "plant shop"', 2);
    if (name.length > NAME_MOST) return fail(`Keep the name under ${NAME_MOST} characters.`, 2);
    if (!given(flags, 'city')) return fail('atris nexus experiment needs --city "<city>".', 2);
    if (given(flags, 'guess').length > GUESS_MOST) return fail(`Keep the guess under ${GUESS_MOST} characters.`, 2);
    if (flags.limit !== undefined && whole(flags.limit, 1, MOST_PEOPLE) === null) return fail(`--limit takes a whole number from 1 to ${MOST_PEOPLE}.`, 2);
  }

  let token;
  try {
    ({ token } = await ctx.getToken());
  } catch (error) {
    return fail(error && error.message);
  }
  if (!token) return fail(ctx.notLoggedIn || 'Sign in first: atris login');
  const api = serviceApi(ctx.request, token);

  const resolve = (lists, query) => resolveList(lists, query, { json, out, err });

  try {
    if (sub === 'lists') {
      const lists = await myLists(api);
      // The lists answer carries no guess, so each list's guess comes from its own score.
      const carries = lists.some((l) => Object.prototype.hasOwnProperty.call(l, 'experiment'));
      const experiments = carries
        ? lists.map((l) => l.experiment || null)
        : await inTurns(lists, 4, async (l) => {
          try {
            const score = await api.get(`/nexus/lists/${enc(l.id)}/score`);
            return score.experiment && typeof score.experiment === 'object' ? score.experiment : null;
          } catch (error) {
            if (error && (error.status === 401 || error.status === 402)) throw error;
            return null;
          }
        });
      if (json) {
        out({ ok: true, lists: lists.map((l, i) => ({ ...l, experiment: experiments[i] || null })) });
        return 0;
      }
      if (!lists.length) {
        log('You have no saved lists yet.');
        log('Make one to test: atris nexus experiment "<name>" --city "<city>"');
        return 0;
      }
      log(`${plural(lists.length, 'saved list', 'saved lists')}`);
      lists.forEach((l, i) => {
        log(`  ${clean(l.name)}, ${plural(num(l.count), 'person', 'people')}`);
        const guess = experiments[i] && clean(experiments[i].guess);
        if (guess) log(`    Guess: ${guess}`);
      });
      return 0;
    }

    if (sub === 'experiment') {
      const name = clean(words.slice(1).join(' '));
      const body = { name, city: given(flags, 'city') };
      if (given(flags, 'work')) body.work = given(flags, 'work');
      if (given(flags, 'group')) body.group = given(flags, 'group');
      if (given(flags, 'guess')) body.guess = given(flags, 'guess');
      if (flags.limit !== undefined) body.limit = whole(flags.limit, 1, MOST_PEOPLE);
      const day = (ctx.now || new Date()).toISOString().slice(0, 10);
      body.ref = `exp-${crypto.createHash('sha256').update([nameKey(name), nameKey(body.city), nameKey(body.work), nameKey(body.group), day].join('\n')).digest('hex').slice(0, 32)}`;
      let data;
      try {
        data = await api.post('/nexus/experiments', body, { soon: true });
      } catch (error) {
        if (error instanceof NotLive) return fail(NOT_LIVE, 1, { not_live: true });
        throw error;
      }
      if (json) { out({ ok: true, ...data }); return 0; }
      const list = data.list || {};
      const count = num(list.count);
      log(`${quote(clean(list.name) || name)}: ${plural(count, 'person', 'people')} on the list${data.added !== undefined ? `, ${num(data.added)} just added` : ''}${num(data.already_there) ? `, ${num(data.already_there)} already there` : ''}.`);
      for (const line of experimentLines(data.experiment)) log(line);
      if (data.counts) {
        log('');
        log('Score');
        for (const line of scoreLines(data.counts, data.rates)) log(line);
      }
      const traits = traitsOf(data.common).slice(0, TRAITS_SHOWN);
      if (traits.length) {
        log('');
        log('What they share');
        for (const t of traits) log(`  ${(KIND_WORDS[t.kind] || clean(t.kind))}: ${traitLine(t, count)}`);
      }
      const alike = alikeOf(data.alike).slice(0, ALIKE_SHOWN);
      if (alike.length) {
        log('');
        log('More like them');
        for (const p of alike) log(`  ${alikeLine(p)}`);
      }
      const gaps = [];
      if (num(data.without_email)) gaps.push(`${plural(num(data.without_email), 'person has', 'people have')} no email yet`);
      if (num(data.without_draft)) gaps.push(`${plural(num(data.without_draft), 'person has', 'people have')} no note yet`);
      if (gaps.length) { log(''); log(`${gaps.join('. ')}.`); }
      const next = Array.isArray(data.next) ? data.next.map(clean).filter(Boolean) : [];
      if (next.length) {
        log('');
        log('Next');
        for (const line of next) log(`  ${line}`);
      }
      return 0;
    }

    const lists = await myLists(api);

    if (sub === 'compare') {
      const asked = words.slice(1).map(clean).filter(Boolean);
      const chosen = [];
      for (const query of asked) {
        const found = resolve(lists, query);
        if (found.stop !== undefined) return found.stop;
        chosen.push(found.list);
      }
      if (new Set(chosen.map((l) => String(l.id))).size !== chosen.length) return fail('The same list is named twice. Compare different lists.', 2);
      const data = await api.post('/nexus/lists/compare', { list_ids: chosen.map((l) => String(l.id)) }, { read: true });
      if (json) { out({ ok: true, ...data }); return 0; }
      const rows = Array.isArray(data.lists) ? data.lists : [];
      const table = [['list', 'people', 'reached', 'replied', 'reply rate', 'became users', 'paying']];
      for (const r of rows) {
        const c = r.counts || {};
        table.push([clean((r.list && r.list.name) || ''), num(c.people), num(c.reached), num(c.replied), percent((r.rates || {}).reply_rate), num(c.signed_up), num(c.paying)]);
      }
      for (const line of grid(table)) log(line);
      const best = data.best ? rows.find((r) => r.list && String(r.list.id) === String(data.best)) : null;
      log('');
      if (best) log(`Best so far: ${clean(best.list.name)}, with the highest reply rate.`);
      else log('No best yet. A list needs 5 or more reached before it can win.');
      return 0;
    }

    const found = resolve(lists, words[1]);
    if (found.stop !== undefined) return found.stop;
    const list = found.list;
    const id = enc(String(list.id));
    const listName = clean(list.name);

    if (sub === 'score') {
      const data = await api.get(`/nexus/lists/${id}/score`);
      if (json) { out({ ok: true, ...data }); return 0; }
      const counts = data.counts || {};
      log(`${listName}: ${plural(num(counts.people !== undefined ? counts.people : (data.list || {}).count), 'person', 'people')}`);
      for (const line of experimentLines(data.experiment)) log(line);
      for (const line of scoreLines(counts, data.rates)) log(line);
      if (!data.experiment || !clean(data.experiment.guess)) log(`No guess yet. Keep one: atris nexus guess ${quote(listName)} "<what you think will happen>"`);
      return 0;
    }

    if (sub === 'guess' || sub === 'learned') {
      const text = clean(words.slice(2).join(' '));
      const data = await api.patch(`/nexus/lists/${id}/experiment`, { [sub]: text });
      if (json) { out({ ok: true, ...data }); return 0; }
      const e = data.experiment || {};
      log(sub === 'guess' ? `Guess kept on ${listName}: ${clean(e.guess) || text}` : `Kept on ${listName}: ${clean(e.learned) || text}`);
      if (sub === 'guess' && clean(e.started_at)) log(`Counting from ${clean(e.started_at).slice(0, 10)}.`);
      return 0;
    }

    if (sub === 'common') {
      const data = await api.get(`/nexus/lists/${id}/common`);
      if (json) { out({ ok: true, ...data }); return 0; }
      const count = num(data.count);
      const traits = traitsOf(data);
      if (!count) { log(`No one is on ${listName} yet.`); return 0; }
      if (!traits.length) log(`The ${plural(count, 'person', 'people')} on ${listName} share nothing that shows yet.`);
      else {
        log(`What the ${plural(count, 'person', 'people')} on ${listName} share`);
        const kinds = [...new Set([...KIND_ORDER, ...traits.map((t) => t.kind)])];
        for (const kind of kinds) {
          const these = traits.filter((t) => t.kind === kind);
          if (!these.length) continue;
          log(KIND_WORDS[kind] || clean(kind));
          for (const t of these) log(`  ${traitLine(t, count)}`);
        }
      }
      const ties = data.ties && typeof data.ties === 'object' ? data.ties : null;
      if (ties) {
        log('');
        log(`Ties: ${plural(num(ties.inside), 'link', 'links')} inside the list, ${plural(num(ties.members_tied), 'person knows', 'people know')} someone else on it.`);
        const outside = Array.isArray(ties.outside) ? ties.outside.filter((o) => o && clean(o.name)) : [];
        if (outside.length) log(`Off the list, knowing the most of them: ${outside.map((o) => `${clean(o.name)} (${num(o.knows)})`).join(', ')}`);
      }
      return 0;
    }

    if (sub === 'alike') {
      const limit = flags.limit !== undefined ? whole(flags.limit, 1, ALIKE_MOST) : ALIKE_DEFAULT;
      const data = await api.post(`/nexus/lists/${id}/alike`, { limit, include_catalog: false }, { read: true });
      const people = alikeOf(data).filter((p) => p && p.person_id);
      if (!flags.add) {
        if (json) { out({ ok: true, ...data }); return 0; }
        if (!people.length) { log(`No one else in your people looks like ${listName} yet.`); return 0; }
        log(`${plural(people.length, 'person', 'people')} like the ones on ${listName}, best first`);
        for (const p of people) log(`  ${alikeLine(p)}`);
        log('');
        log(`Put them on the list: atris nexus alike ${quote(listName)} --add`);
        return 0;
      }
      if (!people.length) {
        if (json) out({ ok: true, ...data, added: 0 });
        else log(`No one else in your people looks like ${listName} yet. Nothing was added.`);
        return 0;
      }
      if (!json) for (const p of people) log(`  ${alikeLine(p)}`);
      let yes = !!flags.yes;
      if (!yes && !json) yes = await (ctx.confirm || askYesNo)(`Add these ${people.length} people to ${listName}? [y/N] `);
      if (!yes) {
        if (json) out({ ok: false, error: 'Nothing was added. Add --yes to add them.', added: 0 });
        else log(ctx.confirm || process.stdin.isTTY ? 'Nothing was added.' : 'Nothing was added. Add --yes to add without asking.');
        return json ? 1 : 0;
      }
      const done = await api.post(`/nexus/lists/${id}/people`, { add: people.map((p) => String(p.person_id)) });
      const after = done.list || {};
      if (json) { out({ ok: true, ...data, added: people.length - num(done.skipped), skipped: num(done.skipped), list: after }); return 0; }
      log(`Added ${plural(people.length - num(done.skipped), 'person', 'people')} to ${listName}${after.count !== undefined ? `, ${num(after.count)} on it now` : ''}.`);
      if (num(done.skipped)) log(`${num(done.skipped)} could not be added.`);
      return 0;
    }

    if (sub === 'drafts') {
      const data = await api.get(`/nexus/lists/${id}/drafts`);
      if (json) { out({ ok: true, ...data }); return 0; }
      const drafts = Array.isArray(data.drafts) ? data.drafts.filter((d) => d && d.person_id) : [];
      log(`${listName}: ${plural(num(data.count), 'person has', 'people have')} a note waiting, ${num(data.without_draft)} do not.`);
      if (!drafts.length) return 0;
      // The drafts answer names no one, so the names come from the list's own cards.
      let names = {};
      try { names = await listNames(api, String(list.id)); } catch { names = {}; }
      log('Nothing is sent from here. Each note waits for your press on its card.');
      for (const d of drafts) {
        const who = names[String(d.person_id)] || String(d.person_id).slice(0, 8);
        const body = String(d.body || '').replace(/\r/g, '');
        log('');
        log(`${who}, note ${num(d.step) || 1}${clean(d.subject) ? `: ${clean(d.subject)}` : ''}`);
        if (flags.full) for (const line of body.split('\n')) log(`  ${line}`.replace(/\s+$/, ''));
        else {
          const first = body.split('\n').map(clean).find(Boolean);
          if (first) log(`  ${first}`);
        }
      }
      return 0;
    }

    return fail(`"${clean(sub)}" is not one of the list commands.`, 2);
  } catch (error) {
    return fail(error && error.message, 1, error && error.status ? { status: error.status } : {});
  }
}

module.exports = { SUBS, HELP, run, parse, findList, percent, serviceApi, myLists, resolveList, NotLive, clean, quote, whole, plural };
