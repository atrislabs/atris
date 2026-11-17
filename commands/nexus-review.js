'use strict';

// atris nexus review: walk your people one card at a time, in the terminal.
//
//   atris nexus review [--stage <stage>] [--list "<name>"] [--search "<words>"] [--due] [--restart]
//
// Keys, no Enter needed: n or right (next), p or left (back), s (stage), t (a note),
// d (follow-up day), o (the whole card), q (quit).
//
// Three parts, so the pure ones can be tested without a terminal:
//   1. Pure: the filter, the date words, the saved place.
//   2. The key handler (createWalk). It takes key events and calls `actions`, nothing else.
//   3. run(): loads the people, then wires a real terminal to the key handler, or prints
//      JSON and leaves when there is no terminal.
//
// One way to write. A change made here goes through store.runStore, the same code the
// `stage`, `note` and `due` commands run, so a card is never written two ways. The card
// on screen is drawn by that same code too, so it reads like `atris nexus "<name>"`.
//
// Your place is kept in the CLI's own folder for the people copy (~/.atris/nexus/review.json)
// and holds, for each filter, a short fingerprint of the filter and one person id. Never a
// name, an email, a company or a city, and not the search words either. Nothing here logs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const model = require('../lib/nexus-model');
const S = require('../lib/nexus-store');
const { oneLine } = require('../lib/developer-api');
const store = require('./nexus-store');
const local = require('./nexus-local');

const PAGE = 200; // the most one page of the store gives
const MAX_PEOPLE = 5000; // a walk this long is a list, not a review
const KEEP_PLACES = 50; // filters whose place is remembered
const POSITIONS_FILE = 'review.json';
const ID_RE = /^[0-9a-f-]{8,64}$/i;
const STAGES = ['found', 'reached_out', 'replied', 'met', 'paying', 'partner'];
const MAX_AHEAD_DAYS = 3650;
const NEEDS_STORE = 'The people store did not answer, and review needs it. Try again in a moment.';
const NO_KEYS = 'This terminal cannot read single keys. Use --json to get the people instead.';
const KEYS_LINE = 'n next   p back   s stage   t note   d follow-up day   o everything   q quit';
const DAY_HELP = 'Use YYYY-MM-DD, today, tomorrow, a weekday like fri, +3 (days from now) or clear.';

const CLEAR = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ERASE_LINE = '\x1b[2K';

const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

// ---- the filter ----

const SWITCHES = new Set(['due', 'restart', 'json']);
const VALUES = { stage: 'stage', list: 'list', group: 'list', search: 'search' };

/** The words after `review`. { opts } or { error }. */
function parseReviewArgs(rawArgs) {
  const opts = { due: false, restart: false };
  let seenReview = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = String(rawArgs[i]);
    if (!seenReview && arg === 'review') { seenReview = true; continue; }
    if (arg === '-h') continue;
    if (!arg.startsWith('--')) return { error: 'atris nexus review does not take a name or a word on its own. Narrow it with --stage, --list, --search or --due.' };
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (SWITCHES.has(name)) {
      if (name !== 'json') opts[name] = true;
    } else if (VALUES[name]) {
      const value = eq >= 0 ? arg.slice(eq + 1) : (i + 1 < rawArgs.length ? String(rawArgs[++i]) : '');
      if (!value.trim()) return { error: `--${name} needs a value` };
      opts[VALUES[name]] = value;
    } else if (name !== 'help') {
      return { error: `atris nexus review does not know --${name}. It takes --stage, --list, --search, --due and --restart.` };
    }
  }
  return { opts };
}

/**
 * The filter the walk uses, checked the way list and search check theirs (the store's own
 * prepare). { filter: { stage?, group?, q?, due } } or { error }.
 */
function buildFilter(opts) {
  const flags = {};
  if (opts.stage !== undefined) flags.stage = opts.stage;
  if (opts.list !== undefined) flags.group = opts.list;
  const checked = store.prepare('list', [], flags);
  if (checked.error) return { error: checked.error };
  const filter = { due: !!opts.due };
  if (checked.args.stage) filter.stage = checked.args.stage;
  if (checked.args.group) filter.group = checked.args.group;
  const q = String(opts.search || '').trim().replace(/\s+/g, ' ');
  if (q) filter.q = q;
  return { filter };
}

/** A fingerprint of the filter: the same filter always gives the same one, and no words are in it. */
function filterKey(filter) {
  const parts = [filter.stage || '', filter.group || '', String(filter.q || '').toLowerCase(), filter.due ? 'due' : ''];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function describeFilter(filter) {
  return [
    filter.stage ? S.stageLabel(filter.stage).toLowerCase() : '',
    filter.group ? `in "${filter.group}"` : '',
    filter.q ? `matching "${filter.q}"` : '',
    filter.due ? 'follow-up due' : '',
  ].filter(Boolean).join(', ');
}

const pad2 = (n) => String(n).padStart(2, '0');

/** A date as YYYY-MM-DD on this computer's calendar. */
function dayString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function daysFrom(now, n) {
  return dayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
}

/** True when a follow-up day is today or earlier. */
function isDue(dueOn, today) {
  return typeof dueOn === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dueOn) && dueOn.slice(0, 10) <= today;
}

/** Does this card still fit the filter, after the changes made in this walk? */
function stillMatches(card, filter, today) {
  const mine = (card && card.private) || {};
  if (filter.stage && (mine.stage || 'found') !== filter.stage) return false;
  if (filter.due && !isDue(mine.due_on, today)) return false;
  return true;
}

/** --due: only people whose follow-up day has come, the longest overdue first. */
function dueOnly(cards, today) {
  const dueOn = (card) => String((card.private && card.private.due_on) || '').slice(0, 10);
  return cards
    .filter((card) => isDue(card.private && card.private.due_on, today))
    .sort((a, b) => (dueOn(a) < dueOn(b) ? -1 : dueOn(a) > dueOn(b) ? 1 : String(a.name || '').localeCompare(String(b.name || ''))));
}

// ---- date words ----

/**
 * A follow-up day from what was typed: YYYY-MM-DD, today, tomorrow, clear (the existing
 * words), a weekday ("fri", "next fri": the next one after today), or +3 / +3d / +2w from today.
 * { ok, day }: day is null for clear.
 */
function followUpDay(input, now = new Date()) {
  const word = String(input || '').trim().toLowerCase();
  if (!word) return { ok: false };
  const ahead = /^\+(\d{1,4})([dw]?)$/.exec(word);
  if (ahead) {
    const days = Number(ahead[1]) * (ahead[2] === 'w' ? 7 : 1);
    return days <= MAX_AHEAD_DAYS ? { ok: true, day: daysFrom(now, days) } : { ok: false };
  }
  const weekday = word.replace(/^next\s+/, '');
  if (Object.prototype.hasOwnProperty.call(WEEKDAYS, weekday)) {
    return { ok: true, day: daysFrom(now, ((WEEKDAYS[weekday] - now.getDay() + 6) % 7) + 1) };
  }
  return S.parseDay(word, now);
}

/** What was typed for the follow-up: a day word, then an optional next move. { ok, day, move }. */
function parseDueLine(line, now = new Date()) {
  const words = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { ok: false };
  const take = words[0].toLowerCase() === 'next' && words.length > 1 ? 2 : 1;
  const found = followUpDay(words.slice(0, take).join(' '), now);
  return found.ok ? { ok: true, day: found.day, move: words.slice(take).join(' ') } : { ok: false };
}

// ---- the saved place ----

function positionsFile(dir) {
  return path.join(dir, POSITIONS_FILE);
}

/** The saved places from the file's text: [{ key, id }]. Anything unreadable is no places. */
function parsePositions(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const list = data && Array.isArray(data.places) ? data.places : [];
  return list
    .filter((entry) => entry && typeof entry.key === 'string' && /^[0-9a-f]{16}$/.test(entry.key) && typeof entry.id === 'string' && ID_RE.test(entry.id))
    .map((entry) => ({ key: entry.key, id: entry.id }))
    .slice(-KEEP_PLACES);
}

/** The places with one filter's person set (or taken off, with null). The newest goes last. */
function withPosition(entries, key, id) {
  const rest = entries.filter((entry) => entry.key !== key);
  if (!id) return rest;
  return [...rest, { key, id }].slice(-KEEP_PLACES);
}

function positionFor(entries, key) {
  const found = entries.find((entry) => entry.key === key);
  return found ? found.id : null;
}

/**
 * The person to start from next time. The one you were on, unless a change made in this walk
 * took them off the filter (a new stage under --stage, a new follow-up under --due). Then
 * the next person who still fits, so a resume never lands back at the start.
 */
function positionToSave(people, at, filter, today) {
  const here = people[at];
  if (!here) return null;
  if (stillMatches(here, filter, today)) return here.id;
  const next = people.slice(at + 1).find((card) => stillMatches(card, filter, today));
  return next ? next.id : null;
}

function readPositions(dir) {
  try {
    return parsePositions(fs.readFileSync(positionsFile(dir), 'utf8'));
  } catch {
    return [];
  }
}

// Private to the owner, written to a side file first so a crash never leaves half a file.
function writePositions(dir, entries) {
  const file = positionsFile(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, places: entries }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---- loading the people ----

/**
 * Every card that fits the filter, a page at a time, through the store's own search (the
 * calls list and search make). { people, total, truncated }. Throws what the store throws.
 */
async function loadPeople(client, filter, today) {
  const people = [];
  const seen = new Set();
  let total = 0;
  while (people.length < MAX_PEOPLE) {
    const body = { limit: PAGE, offset: seen.size };
    if (filter.q) body.q = filter.q;
    if (filter.group) body.group = filter.group;
    if (filter.stage) body.stage = filter.stage;
    const data = await client.search(body);
    const page = Array.isArray(data.people) ? data.people : [];
    total = Number(data.total) || 0;
    let fresh = 0;
    for (const card of page) {
      if (!card || !card.id || seen.has(card.id)) continue;
      seen.add(card.id);
      people.push(card);
      fresh += 1;
    }
    if (!fresh || seen.size >= total) break;
  }
  const rows = filter.due ? dueOnly(people, today) : people;
  return { people: rows, total: filter.due ? rows.length : total, truncated: !filter.due && seen.size < total };
}

// ---- what is on screen ----

function screen({ at, total, words, lines, message }) {
  const head = `${at + 1} of ${total}${words ? `  (${words})` : ''}`;
  return [head, '', ...lines, ...(message ? ['', message] : []), '', KEYS_LINE].join('\n');
}

// The same card, with every touch and the whole note (the plain card keeps four and cuts the note).
function fullView(view) {
  return {
    ...view,
    card(people, row, now) {
      const c = view.card(people, row, now);
      const node = people.list.nodes[row.at];
      c.recent = (node.act || []).map((entry) => {
        const [day, what, said] = Array.isArray(entry) ? entry : ['', String(entry), ''];
        return { day: day || '', when: model.shortDay(day, now), what: what || '', said: said || '' };
      });
      c.note = String(node.note || '');
      return c;
    },
  };
}

// ---- the real actions: the store's own code, one card at a time ----

/**
 * What the walk does to a person. Each one runs store.runStore, the code behind
 * `atris nexus "<name>"`, `stage`, `note` and `due`. The people store is asked for the
 * card by name in those commands; here the card is already in hand, so that one search
 * is answered from memory (it would be the same card) and every other call goes out as it does there.
 */
function makeActions({ request, token, view, clock }) {
  const through = async (card, ctx) => {
    const lines = [];
    let fresh = card;
    const detail = `/nexus/people/${encodeURIComponent(card.id)}`;
    const pinned = async (pathname, options = {}) => {
      if (pathname === '/nexus/people/search') return { ok: true, status: 200, data: { people: [card], total: 1 } };
      const result = await request(pathname, options);
      if (result.ok && pathname === detail && result.data && result.data.card) fresh = result.data.card;
      return result;
    };
    const say = (line) => { lines.push(String(line)); };
    await store.runStore({
      words: [], flags: {}, json: false, log: say, err: say, fail: (message) => { say(message); return 1; },
      usage: (message) => { say(message); return 2; }, now: clock(), tz: '', prep: { args: {} },
      fileHasPeople: async () => false, view, ...ctx, request: pinned, token, pick: (people) => ({ row: people.rows[0] }),
    });
    return { lines, card: fresh };
  };
  const name = (card) => String(card.name || '');
  return {
    async show(card, { full = false } = {}) {
      const done = await through(card, { words: [name(card)], view: full ? fullView(view) : view });
      return { lines: done.lines, card: done.card };
    },
    async stage(card, stage) {
      const done = await through(card, { sub: 'stage', words: ['stage', name(card), stage] });
      return { message: done.lines.join(' ') };
    },
    async note(card, text) {
      const done = await through(card, { sub: 'note', words: ['note', name(card), text] });
      return { message: done.lines.join(' ') };
    },
    async due(card, day, move) {
      const done = await through(card, { sub: 'due', words: ['due', name(card)], prep: { args: { day, move: move || '' } } });
      return { message: done.lines.join(' ') };
    },
  };
}

// ---- the key handler ----

/**
 * One walk. Feed it key events (the same { name, ctrl } the terminal gives) with key(str, k);
 * it calls actions.show / stage / note / due and writes the screen with out(). Keys that come
 * in while a call is out wait their turn. A failed call shows its plain sentence and the walk goes on.
 */
function createWalk({ people, at = 0, filter, actions, out, clock = () => new Date(), notice = '' }) {
  const state = { at, mode: 'browse', buffer: '', prompt: '', message: notice, lines: [], done: false, error: null };
  const words = describeFilter(filter);
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  let queue = Promise.resolve();

  const stop = (error) => {
    if (error) state.error = error;
    state.done = true;
    finish();
  };
  const paint = () => {
    out(`${HIDE_CURSOR}${CLEAR}${screen({ at: state.at, total: people.length, words, lines: state.lines, message: state.message })}\n`);
  };
  const draw = async (full = false) => {
    const card = people[state.at];
    try {
      const shown = await actions.show(card, { full });
      state.lines = shown.lines;
      if (shown.card) people[state.at] = shown.card;
    } catch (error) {
      state.lines = ['That card did not load.', oneLine((error && error.message) || 'Try again in a moment.')];
    }
    paint();
  };
  const go = (step) => {
    const to = state.at + step;
    state.message = '';
    if (to < 0) state.message = 'That is the first one.';
    else if (to >= people.length) state.message = 'That is the last one.';
    else state.at = to;
    return draw();
  };
  // A change: run it, show what the store said (or why it did not take), draw the card again.
  const change = async (run) => {
    state.mode = 'browse';
    state.buffer = '';
    try {
      state.message = (await run()).message || '';
    } catch (error) {
      state.message = oneLine((error && error.message) || 'That did not save. Try again in a moment.');
    }
    return draw();
  };
  const ask = (mode, prompt) => {
    state.mode = mode;
    state.buffer = '';
    state.prompt = prompt;
    out(`\n${SHOW_CURSOR}${prompt}`);
  };
  const echo = () => out(`\r${ERASE_LINE}${state.prompt}${state.buffer}`);
  const cancel = () => {
    state.mode = 'browse';
    state.buffer = '';
    state.message = '';
    paint();
  };

  const browse = async (str, k) => {
    if (k.name === 'right') return go(1);
    if (k.name === 'left') return go(-1);
    if (k.ctrl || k.meta) return undefined;
    switch (str.toLowerCase()) {
      case 'n': return go(1);
      case 'p': return go(-1);
      case 's': {
        state.mode = 'stage';
        const current = S.stageLabel(people[state.at].private && people[state.at].private.stage);
        out(`\n${SHOW_CURSOR}${STAGES.map((s, i) => `${i + 1} ${S.stageLabel(s)}`).join('   ')}\nPick a number (Esc to cancel). Now: ${current}`);
        return undefined;
      }
      case 't': return ask('note', 'Note: ');
      case 'd': return ask('day', 'Follow-up day (YYYY-MM-DD, fri, +3, tomorrow, clear), then an optional next move: ');
      case 'o': state.message = ''; return draw(true);
      case 'q': return stop();
      default: return undefined;
    }
  };

  const pickStage = async (str, k) => {
    if (k.name === 'escape') return cancel();
    const n = str.length === 1 ? Number(str) : 0;
    if (!(n >= 1 && n <= STAGES.length)) return undefined;
    const card = people[state.at];
    const stage = STAGES[n - 1];
    if (((card.private && card.private.stage) || 'found') === stage) {
      state.mode = 'browse';
      state.message = `Already ${S.stageLabel(stage)}.`;
      return draw();
    }
    return change(() => actions.stage(card, stage));
  };

  const typing = async (str, k) => {
    if (k.name === 'escape') return cancel();
    if (k.name === 'return' || k.name === 'enter') {
      const typed = state.buffer.trim();
      const card = people[state.at];
      if (state.mode === 'note') {
        if (!typed) { state.message = 'Nothing to add.'; state.mode = 'browse'; return draw(); }
        return change(() => actions.note(card, typed));
      }
      const parsed = parseDueLine(typed, clock());
      if (!parsed.ok) {
        state.mode = 'browse';
        state.message = typed ? `"${typed.split(/\s+/)[0]}" is not a day. ${DAY_HELP}` : 'No day given, so nothing changed.';
        return draw();
      }
      return change(() => actions.due(card, parsed.day, parsed.move));
    }
    if (k.name === 'backspace') {
      state.buffer = Array.from(state.buffer).slice(0, -1).join('');
      return echo();
    }
    if (k.ctrl || k.meta || !str || /[\x00-\x1f\x7f]/.test(str)) return undefined;
    state.buffer += str;
    return echo();
  };

  const handle = async (str, k) => {
    if (state.done) return undefined;
    if (k.ctrl && k.name === 'c') return stop();
    if (state.mode === 'stage') return pickStage(str, k);
    if (state.mode === 'note' || state.mode === 'day') return typing(str, k);
    return browse(str, k);
  };

  const enqueue = (job) => {
    queue = queue.then(job).catch((error) => stop(error));
    return queue;
  };
  return {
    state,
    finished,
    start: () => enqueue(() => draw()),
    key: (str, k) => enqueue(() => handle(typeof str === 'string' ? str : '', k || {})),
  };
}

// ---- the command ----

async function run(ctx) {
  const { rawArgs, json, log, fail, usage, deps = {} } = ctx;
  const clock = () => (deps.now ? deps.now() : new Date());
  const parsed = parseReviewArgs(rawArgs);
  if (parsed.error) return usage(parsed.error);
  const built = buildFilter(parsed.opts);
  if (built.error) return usage(built.error);
  const { filter } = built;

  let token;
  try {
    ({ token } = await ctx.getToken());
  } catch (error) {
    return fail(error && error.message);
  }
  if (!token) return fail(ctx.notLoggedIn);

  const client = store.storeClient(ctx.request, token);
  let loaded;
  try {
    loaded = await loadPeople(client, filter, dayString(clock()));
  } catch (error) {
    if (error instanceof store.StoreDown) return fail(NEEDS_STORE);
    if (error instanceof store.StoreLocked || error instanceof store.StoreError) return fail(error.message, error instanceof store.StoreLocked ? { status: 402 } : {});
    return fail(error && error.message);
  }
  const { people, total, truncated } = loaded;

  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stdout;
  // No terminal to read keys from: say who matches, as one JSON object, and leave. Never wait.
  if (json || !stdout.isTTY || !stdin.isTTY) {
    log(JSON.stringify({ ok: true, total, ...(truncated ? { truncated: true } : {}), people }));
    return 0;
  }
  if (!people.length) {
    log(`No one on your list fits${describeFilter(filter) ? ` (${describeFilter(filter)})` : ''}.`);
    return 0;
  }

  const dir = local.localDir(deps);
  const key = filterKey(filter);
  const places = readPositions(dir);
  let at = 0;
  let notice = truncated ? `Walking the first ${people.length} of ${total}.` : '';
  const savedId = parsed.opts.restart ? null : positionFor(places, key);
  const savedAt = savedId ? people.findIndex((card) => card.id === savedId) : -1;
  if (savedAt > 0) {
    at = savedAt;
    notice = `Picking up where you stopped. Add --restart to begin again.${notice ? ` ${notice}` : ''}`;
  }

  const walk = createWalk({
    people, at, filter, clock, notice,
    actions: makeActions({ request: ctx.request, token, view: ctx.view, clock }),
    out: (text) => stdout.write(text),
  });

  readline.emitKeypressEvents(stdin);
  const onKey = (str, k) => { walk.key(str, k); };
  let restored = false;
  let started = false;
  let saved = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { stdin.removeListener('keypress', onKey); } catch { /* the terminal is going away */ }
    try { if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false); } catch { /* the terminal is going away */ }
    try { stdin.pause(); } catch { /* the terminal is going away */ }
    try { stdout.write(SHOW_CURSOR); } catch { /* the terminal is going away */ }
  };
  // Your place: one fingerprint and one person id. Nothing else.
  const remember = () => {
    if (saved || !started) return true;
    saved = true;
    try {
      writePositions(dir, withPosition(readPositions(dir), key, positionToSave(people, walk.state.at, filter, dayString(clock()))));
      return true;
    } catch {
      return false;
    }
  };
  const onSignal = (code) => () => { restore(); remember(); process.exit(code); };
  // Raw mode turns Ctrl-C into a key, so these only come from outside (kill, a closed window).
  const signals = [['SIGINT', onSignal(130)], ['SIGTERM', onSignal(143)], ['SIGHUP', onSignal(129)]];
  process.once('exit', restore);
  for (const [name, handler] of signals) process.once(name, handler);

  let failure = null;
  try {
    try {
      stdin.setRawMode(true);
    } catch {
      return fail(NO_KEYS);
    }
    started = true;
    stdin.resume();
    stdin.on('keypress', onKey);
    walk.start();
    await walk.finished;
    if (walk.state.error) failure = walk.state.error;
  } catch (error) {
    failure = error;
  } finally {
    restore();
    process.removeListener('exit', restore);
    for (const [name, handler] of signals) process.removeListener(name, handler);
  }
  const kept = remember();
  if (failure) return fail((failure && failure.message) || 'The review stopped.');
  log(kept ? `Stopped at ${walk.state.at + 1} of ${people.length}. Run atris nexus review again to pick up here.` : 'Stopped. Your place could not be saved.');
  return 0;
}

module.exports = {
  run,
  parseReviewArgs,
  buildFilter,
  filterKey,
  describeFilter,
  dueOnly,
  followUpDay,
  parseDueLine,
  parsePositions,
  withPosition,
  positionFor,
  positionToSave,
  readPositions,
  writePositions,
  positionsFile,
  loadPeople,
  screen,
  makeActions,
  createWalk,
  STAGES,
};
