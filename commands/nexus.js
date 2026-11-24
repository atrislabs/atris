'use strict';

// atris nexus: the same people cards as atris.ai/dashboard/nexus, for the owner
// and for any command-line agent. Every command tries the shared people store
// first (commands/nexus-store.js). When the store does not answer, it falls back
// to the saved list: one file in the signed-in person's Atris folder
// (files/people.json). The file is read and written as the web page did before the
// store: a missing file is a fresh list, any other read failure stops with nothing
// written, and every save reads the file again first.

const { apiRequestJson } = require('../utils/api');
const { ensureFreshCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, tokenFrom, oneLine } = require('../lib/developer-api');
const model = require('../lib/nexus-model');
const S = require('../lib/nexus-store');
const store = require('./nexus-store');
const columns = require('./nexus-columns');
const review = require('./nexus-review');
const mail = require('./nexus-mail');
const local = require('./nexus-local');
const capture = require('./nexus-capture');
const importer = require('./nexus-import');
const hour = require('./nexus-hour');
const experiments = require('./nexus-experiments');
const rank = require('./nexus-rank');

const USAGE = [
  'atris nexus: your people, the same cards as atris.ai/dashboard/nexus',
  '  atris nexus                         today\'s moves, the five most urgent (--all for the rest) and counts',
  '  atris nexus "<name>"                one person\'s card',
  '  atris nexus list                    everyone, 50 at a time (--offset 50 for the next page)',
  '  atris nexus search "<words>"        matching people, best first (find works too; --all for every match)',
  '  atris nexus count                   how many people, by stage, and your biggest lists',
  '    list and search take --stage <stage>, --closeness <direct|intro>, --group "<list>", --limit <1-200>, --offset <n>',
  '  atris nexus note "<name>" "<text>"  add a note',
  '  atris nexus stage "<name>" <found|reached|replied|met|paying|partner>',
  '  atris nexus add "<name>" [--title --company --city --email --linkedin --x --website --note]',
  '    a new card is Found with no closeness or list; say more with --stage met, --closeness direct, --group "<list>"',
  '  atris nexus due "<name>" <date> ["next move"]   set the follow-up (YYYY-MM-DD, today, tomorrow, clear)',
  '  atris nexus review [--stage <stage>] [--list "<name>"] [--search "<words>"] [--due] [--restart]',
  '                                      your people one card at a time: n next, p back, s stage, t note, d follow-up day (fri, +3, a date), o everything, q quit; it remembers where you stopped. With --json or off a terminal it prints the matching people and leaves',
  '  atris nexus paid "<name>" <amount> [--checked]  record a payment. Only checked money counts.',
  '  atris nexus wall                    the war room numbers: sent, replied, follow-ups, paid money, groups, cities',
  '  atris nexus goal [amount] [date]    show or set the money goal',
  '  atris nexus city "<city>"           the people in a city, yours marked',
  '  atris nexus bring-over              send your saved list to the store (never changes the list)',
  '  atris nexus set "<name>" <column> <value> [--source <link>]   your own column on a card (a helper must give --source)',
  '  atris nexus unset "<name>" <column>   take a column off a card',
  '  atris nexus undo "<name>" <column>    put back the value before the last change',
  '  atris nexus columns                 every column you have, how many people have it and the top values',
  '  atris nexus table --with <a,b,c> [--where <column>=<value>] [--csv]   everyone with the columns you pick, for sheets and graphs',
  '                                      a helper never changes or removes a value you set yourself',
  '  atris nexus mail "<name>"           their mail across every Gmail inbox you connected, newest first, each naming its inbox',
  '  atris nexus reply "<name>" --from <inbox> --message <id> --body "<text>" [--dry-run] [--yes]',
  '                                      reply in that thread from the inbox that got it; shows the reply and asks first',
  '  atris nexus pull                    copy your own people to this computer (~/.atris/nexus), for use offline',
  '  atris nexus local search "<words>"  search that copy, no connection needed',
  '  atris nexus local show "<name or id>"   one card from that copy',
  '  atris nexus local note "<name or id>" "<text>"   a note kept on this computer until you send it',
  '  atris nexus push-notes              send the notes written offline, then clear them',
  ...capture.HELP,
  ...importer.HELP,
  ...hour.HELP,
  ...experiments.HELP,
  ...rank.HELP,
  '  --json on any of these prints one JSON object for agents (the store\'s own answer when it answers)',
  'The store is tried first. If it does not answer, reads use the saved list; changes are never saved there (wall, goal, due, paid, city, bring-over and the filters need the store).',
].join('\n');

// Commands the saved list cannot answer: the store or nothing.
const STORE_ONLY = new Set(['wall', 'goal', 'due', 'paid', 'city', 'bring-over']);
// Commands that need a word after them.
const TAKES_WORD = new Set(['find', 'search', 'note', 'stage', 'add', 'due', 'paid', 'city', 'mail', 'reply']);
const SUBS = new Set(['list', 'find', 'search', 'count', 'note', 'stage', 'add', ...STORE_ONLY, ...columns.SUBS, ...mail.SUBS]);
const FALLBACK_LINE = 'Using your saved list. The people store did not answer.';
const STORE_NEEDED = 'The people store did not answer, and this command needs it. Try again in a moment.';
// The store is the home for every change. A change it cannot take is not written anywhere
// else, so the saved list and the store never drift apart. Reading the saved list is fine.
const WRITES = new Set(['note', 'stage', 'add']);
const NOT_SAVED = 'The people store did not answer, so nothing was saved. Try again in a moment.';
const VALUE_FLAGS = new Set(['title', 'company', 'city', 'email', 'note', 'linkedin', 'x', 'website', 'stage', 'closeness', 'group', 'limit', 'offset', 'source', 'with', 'where', 'from', 'thread', 'message', 'body', 'ref']);
const FILTERED = new Set(['list', 'find', 'search']);
const FILTERS_NEED_STORE = 'The people store did not answer, and --stage, --closeness and --group need it. Try again in a moment.';
const STAGE_WORDS = { found: 'prospect', reached: 'sent', replied: 'replied', met: 'met', paying: 'paying', partner: 'partner' };
const NAME_LIMIT = 10;

/** A real calendar day written YYYY-MM-DD. */
function realDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim());
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// window and decides are set on one column, through the same path (and the same rules) as set.
function shortcut(words) {
  const [word, name] = words;
  const rest = words.slice(2).map((w) => String(w).trim()).filter(Boolean);
  if (word === 'window') {
    if (!String(name || '').trim() || rest.length !== 1) return { error: 'atris nexus window needs a name and one date, like: atris nexus window "Rae Sample" 2026-12-15 --source <link>' };
    if (rest[0].toLowerCase() === 'clear') return { words: ['unset', name, 'window_ends'] };
    if (!realDay(rest[0])) return { error: `"${rest[0]}" is not a real date. Use YYYY-MM-DD, like 2026-12-15, or clear to take it off.` };
    return { words: ['set', name, 'window_ends', rest[0]] };
  }
  if (word === 'decides') {
    if (!String(name || '').trim() || !rest.length) return { error: 'atris nexus decides needs a name and who decides, like: atris nexus decides "Rae Sample" "Rae, the owner" --source <link>' };
    return { words: ['set', name, 'decider', rest.join(' ')] };
  }
  return { words };
}

function parseArgs(args) {
  const words = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq < 0 ? undefined : eq);
    if (VALUE_FLAGS.has(key)) {
      if (eq >= 0) flags[key] = arg.slice(eq + 1);
      else if (i + 1 < args.length) flags[key] = String(args[++i]);
      else flags[key] = '';
    } else {
      flags[key] = true;
    }
  }
  return { words, flags };
}

// The file in the person's Atris folder, read and written through the CLI's API helper.
function peopleClient(request, token) {
  const call = (pathname, options = {}) => request(pathname, { token, timeoutMs: 30000, ...options });
  return {
    // A missing file means a new map. Anything else that goes wrong must stop here:
    // starting fresh over a list we failed to read would wipe it on the next save.
    async read() {
      const result = await call(`/memory/file?path=${encodeURIComponent(model.PEOPLE_FILE)}`);
      if (result.ok) {
        const list = model.readList(result.data && typeof result.data.text === 'string' ? result.data.text : '');
        if (!list) throw new Error('Your people file could not be read. Nothing was changed.');
        return { list, missing: false };
      }
      const said = String(result.error || '');
      if ((result.status === 400 || result.status === 404) && said.startsWith('No file at')) return { list: model.starter(), missing: true };
      throw new Error(result.status === 401 ? `Sign in to see your people. ${NOT_LOGGED_IN}` : 'Your people could not load. Try again in a moment.');
    },
    async write(list) {
      const result = await call('/memory/write', { method: 'PUT', body: { path: model.PEOPLE_FILE, text: JSON.stringify(list) } });
      if (!result.ok) throw new Error('That did not save. Try again in a moment.');
    },
  };
}

async function defaultToken() {
  const creds = await ensureFreshCredentials(apiRequestJson);
  const account = creds && typeof creds.user_id === 'string' ? creds.user_id : '';
  return { token: tokenFrom(creds), account };
}

/** One person by name: exact (any case) first, else the only name holding the words. */
function findPerson(people, query) {
  const want = String(query || '').trim().toLowerCase();
  if (!want) return { matches: [] };
  const exact = people.rows.filter((row) => row.name.toLowerCase() === want);
  if (exact.length === 1) return { row: exact[0] };
  if (exact.length > 1) return { matches: exact };
  const close = people.rows.filter((row) => row.name.toLowerCase().includes(want));
  if (close.length === 1) return { row: close[0] };
  return { matches: close };
}

function stageText(row) {
  return model.LOOP[row.loop.stage] ? model.LOOP[row.loop.stage].word : '';
}

function brief(row) {
  return { name: row.name, company: row.company, close: row.close, stage: row.loop.label === 'Found' ? '' : row.loop.label, move: row.tableMove };
}

function card(people, row, now) {
  const node = people.list.nodes[row.at];
  const date = row.status === 'silent' ? '' : model.shortDay(row.last, now);
  const recent = (node.act || []).slice(0, 4).map((entry) => {
    const [day, what, said] = Array.isArray(entry) ? entry : ['', String(entry), ''];
    return { day: day || '', when: model.shortDay(day, now), what: what || '', said: said || '' };
  });
  const note = String(node.note || '');
  return {
    name: row.name,
    title: row.title,
    company: row.company,
    city: row.city,
    closeness: row.close,
    status: row.status,
    stage: row.loop.label,
    stageReached: stageText(row),
    off: row.loop.off,
    date,
    last: row.last,
    move: row.move,
    path: model.wayIn(people, row.at),
    email: row.mail,
    recent,
    note: note.length > 300 ? `${note.slice(0, 300)}...` : note,
    ties: model.ties(people, row.at).slice(0, 14).map((tie) => tie.name),
    links: model.domains([...(node.links || []), ...(node.proof || [])]).map((link) => link.host),
  };
}

function cardLines(c) {
  const lines = [c.name];
  const facts = [c.title, c.company, c.city].filter(Boolean).join(' · ');
  if (facts) lines.push(facts);
  if (c.closeness) lines.push(`Closeness: ${c.closeness}`);
  // Found is where every card starts, so it says nothing; a stage shows once something happened.
  if (c.stage !== 'Found' || c.off) lines.push(`Stage: ${c.stage}${c.date ? `, ${c.date}` : ''}${c.off ? ` (got as far as ${c.stageReached})` : ''}`);
  lines.push(`Next: ${c.move}.`);
  if (c.path) lines.push(`Way in: ${c.path.join(' → ')}`);
  if (!c.email) lines.push('No email yet');
  if (c.recent.length) {
    lines.push('', 'Recent');
    for (const r of c.recent) lines.push(`  ${(r.when || '').padEnd(12)} ${r.what}${r.said ? `  ${r.said}` : ''}`.replace(/\s+$/, ''));
  }
  if (c.note) {
    lines.push('', 'Notes');
    for (const line of c.note.split('\n')) lines.push(`  ${line}`.replace(/\s+$/, ''));
  }
  if (c.ties.length) lines.push('', `Ties: ${c.ties.join(', ')}`);
  if (c.links.length) lines.push(`Links: ${c.links.join(', ')}`);
  return lines;
}

function tableLines(rows) {
  const cut = (value, most) => (value.length > most ? `${value.slice(0, most - 1)}.` : value);
  const cols = rows.map((r) => [cut(r.name, 30), cut(r.company || '', 26), r.close || '', r.stage, r.move || '']);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...cols.map((c) => c[i].length)));
  return cols.map((c) => c.map((cell, i) => (i < 4 ? cell.padEnd(widths[i]) : cell)).join('  ').replace(/\s+$/, ''));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

async function nexusCommand(args = [], deps = {}) {
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  const now = deps.now ? deps.now() : new Date();
  const parsedArgs = parseArgs(args);
  const { flags } = parsedArgs;
  const json = !!flags.json;

  if (flags.help || parsedArgs.words[0] === 'help') {
    log(USAGE);
    return 0;
  }
  const short = shortcut(parsedArgs.words);
  if (short.error) {
    if (json) log(JSON.stringify({ ok: false, error: short.error }));
    else err(short.error);
    return 2;
  }
  const words = short.words;
  const sub = SUBS.has(words[0]) ? words[0] : null;

  const fail = (message, extra = {}) => {
    if (json) log(JSON.stringify({ ok: false, error: oneLine(message), ...extra }));
    else err(oneLine(message));
    return 1;
  };
  const usage = (message) => {
    if (json) log(JSON.stringify({ ok: false, error: message }));
    else err(`${message}\n${USAGE}`);
    return 2;
  };

  // The one-by-one walk: its own file, signed in and through the store like the commands above.
  if (words[0] === 'review') return review.run({ rawArgs: args, json, log, fail, usage, deps, request: deps.apiRequestJson || apiRequestJson, getToken: deps.getToken || defaultToken, notLoggedIn: NOT_LOGGED_IN, view: { card, cardLines, tableLines } });

  // The hour: one outbound sprint on a saved list. Its own file, its own flags.
  if (words[0] === 'hour') {
    return hour.run({ rawArgs: args, log, err, now, deps, request: deps.apiRequestJson || apiRequestJson, getToken: deps.getToken || defaultToken, notLoggedIn: NOT_LOGGED_IN });
  }

  // Saved lists as experiments: lists, experiment, score, guess, learned, common, alike, compare, drafts.
  // Before the person-search fallback, so "atris nexus score" never looks up a person called "score".
  if (experiments.SUBS.has(words[0])) {
    return experiments.run({ rawArgs: args, log, err, now, request: deps.apiRequestJson || apiRequestJson, getToken: deps.getToken || defaultToken, notLoggedIn: NOT_LOGGED_IN, confirm: deps.confirm });
  }
  if (rank.SUBS.has(words[0])) {
    return rank.run({ rawArgs: args, log, err, now, request: deps.apiRequestJson || apiRequestJson, getToken: deps.getToken || defaultToken, notLoggedIn: NOT_LOGGED_IN });
  }

  // The local copy: pull and push-notes sign in; local reads only files on this computer.
  if (local.SUBS.has(words[0])) {
    return local.run({
      sub: words[0], words, flags, json, log, err, fail, usage: (message) => {
        if (json) log(JSON.stringify({ ok: false, error: message }));
        else err(message);
        return 2;
      },
      now, dir: local.localDir(deps), request: deps.apiRequestJson || apiRequestJson,
      getToken: deps.getToken || defaultToken, notLoggedIn: NOT_LOGGED_IN,
      findPerson, view: { card, cardLines, tableLines },
    });
  }

  // capture and import read their own flags from the raw words, so pasted text never mixes with a flag value.
  const intake = [capture, importer].find((m) => m.SUBS.has(words[0]));
  if (intake) {
    return intake.run({
      rawArgs: args, log, err, now, request: deps.apiRequestJson || apiRequestJson, getToken: deps.getToken || defaultToken,
      notLoggedIn: NOT_LOGGED_IN, view: { card, cardLines }, stdin: deps.stdin, ask: deps.ask, isTTY: deps.isTTY,
    });
  }

  // `atris nexus find` with nothing after it: say how, do not look up a person called "find".
  if (TAKES_WORD.has(sub) && !String(words[1] || '').trim()) {
    if (sub === 'search' || sub === 'find') return usage(`atris nexus ${sub} needs words to look for. To see everyone: atris nexus list`);
    return usage(`atris nexus ${sub} needs ${sub === 'city' ? 'a city' : 'a name'}`);
  }
  if (sub === 'note' && !words.slice(2).join(' ').trim()) return usage('atris nexus note needs a name and the note text');
  if (sub === 'stage' && !words[2]) return usage('atris nexus stage needs a name and a stage');
  if (sub === 'stage' && !S.stageFromWord(words[2])) return usage(`"${words[2]}" is not a stage. Use found, reached, replied, met, paying or partner.`);
  const prep = store.prepare(sub, words, flags, now);
  if (prep.error) return usage(prep.error);

  let client;
  let tokenValue;
  try {
    const { token } = await (deps.getToken || defaultToken)();
    if (!token) return fail(NOT_LOGGED_IN);
    tokenValue = token;
    client = (deps.client || peopleClient)(deps.apiRequestJson || apiRequestJson, token);
  } catch (error) {
    return fail(error && error.message);
  }

  // Your own columns live only in the store: no saved-list fallback.
  const oneLineUsage = (message) => {
    if (json) log(JSON.stringify({ ok: false, error: message }));
    else err(message);
    return 2;
  };
  const columnsCtx = () => ({ sub, words, flags, json, log, fail, usage: oneLineUsage, now, env: deps.env, request: deps.apiRequestJson || apiRequestJson, token: tokenValue, pick });

  // One name that may match several people: list them and stop.
  const pick = (people, query) => {
    const found = findPerson(people, query);
    if (found.row) return found;
    const names = found.matches.map((row) => row.name);
    if (!names.length) return { stop: fail(`No one called "${query}" is on your list.`, { matches: [] }) };
    const shown = names.slice(0, NAME_LIMIT);
    if (json) {
      log(JSON.stringify({ ok: false, error: `${names.length} people match "${query}". Use the full name.`, matches: shown, total: names.length }));
    } else {
      err(`${names.length} people match "${query}". Use the full name:`);
      for (const name of shown) err(`  ${name}`);
      if (names.length > shown.length) err(`  and ${names.length - shown.length} more`);
    }
    return { stop: 1 };
  };

  // Every save reads the file again first, so a change made elsewhere (the web
  // page, another agent, the owner's computer) is never written over.
  const save = async (makeChange) => {
    const { list } = await client.read();
    const people = model.buildPeople(list, now);
    const made = makeChange(people);
    if (made.stop !== undefined) return made;
    const next = model.applyChange(list, made.change);
    if (typeof next === 'string') return { stop: fail(next) };
    await client.write(next);
    return { ...made, next, waits: next.mine === 'mac' };
  };
  const waitLine = 'Your computer picks this up on its next sync.';

  if (columns.SUBS.has(sub)) return columns.run(columnsCtx());
  // Mail lives only in the store and the inboxes you connected: no saved-list fallback.
  if (mail.SUBS.has(sub)) return mail.run({ ...columnsCtx(), rawArgs: args, confirm: deps.confirm });

  // The store first. It falls back to the saved list only when it did not answer and
  // nothing was written to it; a 402 or any other answer stops here.
  if (deps.useStore !== false) {
    const tz = deps.tz !== undefined ? deps.tz : (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
    const ctx = {
      sub, words, flags, json, log, err, fail, usage, now, tz, prep,
      request: deps.apiRequestJson || apiRequestJson,
      token: tokenValue,
      pick,
      fileClient: client,
      fileHasPeople: async () => {
        try {
          const read = await client.read();
          return !read.missing && S.filePeople(read.list) > 0;
        } catch {
          return false;
        }
      },
      view: { card, cardLines, tableLines },
    };
    try {
      return await store.runStore(ctx);
    } catch (error) {
      if (error instanceof store.StoreLocked) return fail(error.message, { status: 402 });
      if (error instanceof store.StoreError) return fail(error.message);
      if (!(error instanceof store.StoreDown)) return fail(error && error.message);
    }
    if (STORE_ONLY.has(sub)) return fail(STORE_NEEDED);
    if (WRITES.has(sub)) return fail(NOT_SAVED);
    if (FILTERED.has(sub) && (prep.args.stage || prep.args.closeness || prep.args.group)) return fail(FILTERS_NEED_STORE);
    err(FALLBACK_LINE);
  } else if (STORE_ONLY.has(sub)) {
    return fail(STORE_NEEDED);
  } else if (FILTERED.has(sub) && (prep.args.stage || prep.args.closeness || prep.args.group)) {
    return fail(FILTERS_NEED_STORE);
  }

  try {
    if (sub === 'note') {
      const name = words[1];
      const text = words.slice(2).join(' ');
      const done = await save((people) => {
        const found = pick(people, name);
        return found.row ? { row: found.row, change: { do: 'note', at: found.row.at, who: found.row.name, text } } : found;
      });
      if (done.stop !== undefined) return done.stop;
      const saved = done.next.nodes[done.row.at].act[0][2];
      if (json) log(JSON.stringify({ ok: true, did: 'note', name: done.row.name, note: saved, pending: done.waits }));
      else {
        log(`Noted on ${done.row.name}: ${saved}`);
        if (done.waits) log(waitLine);
      }
      return 0;
    }

    if (sub === 'stage') {
      const name = words[1];
      const word = String(words[2]).toLowerCase();
      const status = STAGE_WORDS[word] || (model.STATUSES.has(word) ? word : '');
      if (!status) return usage(`"${words[2]}" is not a stage. Use found, reached, replied, met, paying or partner.`);
      const done = await save((people) => {
        const found = pick(people, name);
        return found.row ? { row: found.row, change: { do: 'status', at: found.row.at, who: found.row.name, status } } : found;
      });
      if (done.stop !== undefined) return done.stop;
      const after = model.loopOf(done.next.nodes[done.row.at], now).label;
      if (json) log(JSON.stringify({ ok: true, did: 'stage', name: done.row.name, from: done.row.loop.label, stage: after, status, pending: done.waits }));
      else {
        log(`${done.row.name} is now ${after} (was ${done.row.loop.label}).`);
        if (done.waits) log(waitLine);
      }
      return 0;
    }

    if (sub === 'add') {
      const name = words.slice(1).join(' ');
      const change = { do: 'add', name, title: flags.title, company: flags.company, city: flags.city, email: flags.email, note: flags.note };
      const done = await save(() => ({ change }));
      if (done.stop !== undefined) return done.stop;
      const person = done.next.nodes[done.next.nodes.length - 1];
      const added = { name: person.n, title: person.title || '', company: person.co || '', city: person.city || '', email: person.email || '', note: person.note || '' };
      if (json) log(JSON.stringify({ ok: true, did: 'add', ...added, stage: 'Met', closeness: 'Direct', pending: done.waits }));
      else {
        const facts = [added.title, added.company, added.city].filter(Boolean).join(' · ');
        log(`Added ${added.name}${facts ? ` (${facts})` : ''}, as someone you met.`);
        if (done.waits) log(waitLine);
      }
      return 0;
    }

    const { list } = await client.read();
    const people = model.buildPeople(list, now);

    // A page of the saved list, the same --limit and --offset the store takes.
    const page = (hits) => {
      const { limit, offset } = prep.args;
      const shown = hits.slice(offset, offset + limit);
      const foot = () => {
        if (!shown.length || (offset === 0 && hits.length <= shown.length)) return;
        if (offset === 0 && !flags.limit && !flags.all) {
          log(`Showing ${shown.length} of ${hits.length}. Add --all for every match.`);
          return;
        }
        log(`Showing ${offset + 1} to ${offset + shown.length} of ${hits.length}.`);
        if (offset + shown.length < hits.length) log(`Add --offset ${offset + shown.length} for the next page.`);
      };
      return { rows: shown.map(brief), limit, offset, foot };
    };

    if (sub === 'find' || sub === 'search') {
      const query = words.slice(1).join(' ');
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = people.rows.filter((row) => {
        const hay = [row.name, row.title, row.company, row.city, row.status].join(' ').toLowerCase();
        return terms.every((term) => hay.includes(term));
      });
      const shown = page(hits);
      if (json) {
        log(JSON.stringify({ ok: true, query, total: hits.length, limit: shown.limit, offset: shown.offset, people: shown.rows }));
        return 0;
      }
      if (!hits.length) {
        log(`No one on your list matches "${query}".`);
        return 0;
      }
      log(`${plural(hits.length, 'person matches', 'people match')} "${query}".`);
      for (const line of tableLines(shown.rows)) log(line);
      shown.foot();
      return 0;
    }

    if (sub === 'list') {
      const everyone = people.rows.filter((row) => !row.hidden);
      const shown = page(everyone);
      if (json) {
        log(JSON.stringify({ ok: true, total: everyone.length, limit: shown.limit, offset: shown.offset, people: shown.rows }));
        return 0;
      }
      if (!everyone.length) {
        log('No one is on your list yet.');
        return 0;
      }
      log(`${plural(everyone.length, 'person', 'people')} on your list.`);
      for (const line of tableLines(shown.rows)) log(line);
      shown.foot();
      return 0;
    }

    if (sub === 'count') {
      const counts = model.viewCounts(people.rows);
      const tally = { people: counts.all, talking: counts.talk, warm: counts.warm, paying: counts.pay };
      if (json) log(JSON.stringify({ ok: true, counts: tally }));
      else log(`${plural(tally.people, 'person', 'people')}, ${tally.talking} talking, ${tally.warm} warm, ${tally.paying} paying.`);
      return 0;
    }

    if (words.length) {
      const found = pick(people, words.join(' '));
      if (found.stop !== undefined) return found.stop;
      const c = card(people, found.row, now);
      if (json) log(JSON.stringify({ ok: true, person: c }));
      else for (const line of cardLines(c)) log(line);
      return 0;
    }

    const counts = model.viewCounts(people.rows);
    const tally = { people: counts.all, talking: counts.talk, warm: counts.warm, paying: counts.pay };
    const items = model.todayFeed(people, now).map((item) => {
      const row = people.byAt.get(item.at);
      return { name: item.name, line: item.line, close: row.close, stage: row.loop.label, move: row.move };
    });
    if (json) {
      log(JSON.stringify({ ok: true, today: items, counts: tally }));
      return 0;
    }
    log('Today');
    if (items.length) for (const item of items) log(`  ${item.name}: ${item.line}`);
    else log('  Nothing is waiting on you today.');
    log('');
    log(`${plural(tally.people, 'person', 'people')}, ${tally.talking} talking, ${tally.warm} warm, ${tally.paying} paying.`);
    return 0;
  } catch (error) {
    return fail(error && error.message);
  }
}

module.exports = { nexusCommand, peopleClient, findPerson, parseArgs, USAGE };
