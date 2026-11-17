'use strict';

// atris nexus set / unset / undo / columns / table: your own columns on people cards.
//
// A column is any fact you want on a person: has an Atris account, met at an event, check
// size, last talked. Each value lives in the card's private extras (backend
// services/nexus_people.py, PATCH /nexus/people/{id}/mine merges extras one key at a time),
// under col_<name>, as { v, by, at, src, was }:
//   v    the value, a number when it reads as one
//   by   "you", or the helper that wrote it
//   at   when it was written
//   src  where it was found (a link or a few words). A helper must give one.
//   was  the value before, so one undo puts it back
// A helper never changes or removes a value you set yourself. Only the store holds these;
// there is no saved-list fallback.

const model = require('../lib/nexus-model');
const S = require('../lib/nexus-store');
const { LOCKED_LINE } = require('./nexus-store');

const SUBS = new Set(['set', 'unset', 'undo', 'columns', 'table']);
const PREFIX = 'col_';
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const VALUE_MOST = 500;
const SOURCE_MOST = 1000;
const PAGE = 200;
const TEXT_ROWS = 100;
const WAIT_MS = 15000;
// The same marks lib/task-core.js reads to tell an agent's shell from a person's.
const AGENT_MARKS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT', 'DEVIN_SESSION_ID'];

// Columns every card already has, usable in table --with and --where.
const BUILT_IN = {
  name: (c) => c.name,
  title: (c) => c.title,
  company: (c) => c.company_name,
  city: (c) => c.location_raw,
  linkedin: (c) => c.linkedin_url,
  x: (c) => c.x_handle,
  website: (c) => c.website,
  email: (c) => (c.private || {}).email,
  stage: (c) => S.stageLabel((c.private || {}).stage).toLowerCase(),
  closeness: (c) => model.closeness((c.private || {}).closeness),
  group: (c) => (c.private || {}).group_name,
  next_move: (c) => (c.private || {}).next_move,
  due: (c) => (c.private || {}).due_on,
  last_touch: (c) => String((c.private || {}).last_touch_at || '').slice(0, 10),
  paid: (c) => ((c.private || {}).paid_cents ? (c.private || {}).paid_cents / 100 : ''),
};

const columnName = (word) => String(word || '').trim().toLowerCase().replace(/\s+/g, '_');
const extras = (card) => ((card && card.private && card.private.extra) || {});
const cell = (card, name) => {
  if (BUILT_IN[name]) return BUILT_IN[name](card);
  const got = extras(card)[PREFIX + name];
  return got && typeof got === 'object' ? got.v : undefined;
};
const shown = (value) => (value === undefined || value === null ? '' : String(value));

function agentShell(env) {
  return AGENT_MARKS.some((mark) => String(env[mark] || '').trim() !== '');
}

function asValue(text) {
  const t = String(text).trim();
  return /^-?\d+(\.\d+)?$/.test(t) && t.length < 16 ? Number(t) : t;
}

// Check the words before anything is sent. Returns { error } or { args }.
function prepare(sub, words, flags, env = process.env) {
  const helper = !!flags['as-helper'] || agentShell(env);
  if (sub === 'set' || sub === 'unset' || sub === 'undo') {
    const name = String(words[1] || '').trim();
    const col = columnName(words[2]);
    if (!name || !words[2]) return { error: `atris nexus ${sub} needs a name and a column, like: atris nexus ${sub} "Rae Sample" met_at${sub === 'set' ? ' "AI Engineer Fair"' : ''}` };
    if (!NAME.test(col)) return { error: `"${words[2]}" cannot be a column. Use letters, numbers, _ or -, starting with a letter, up to 40.` };
    if (BUILT_IN[col]) return { error: `${col} is already on every card. Change it with the other atris nexus commands.` };
    if (sub !== 'set') return { args: { name, col, helper } };
    const value = words.slice(3).join(' ').trim();
    if (!value) return { error: `atris nexus set needs a value after the column. To take a value off: atris nexus unset "${name}" ${col}` };
    if (value.length > VALUE_MOST) return { error: `Keep a value under ${VALUE_MOST} characters. Put longer text in a note.` };
    const source = typeof flags.source === 'string' ? flags.source.trim() : '';
    if (source.length > SOURCE_MOST) return { error: `Keep --source under ${SOURCE_MOST} characters.` };
    // A helper's value counts only with the page that shows it, never one built from a name.
    if (helper && !source) return { error: 'A helper must say where it found this: add --source with the link or page it came from.' };
    return { args: { name, col, value: asValue(value), source, helper } };
  }
  if (sub === 'table') {
    const want = String(typeof flags.with === 'string' ? flags.with : '').split(',').map(columnName).filter(Boolean);
    for (const col of want) if (!NAME.test(col)) return { error: `"${col}" cannot be a column.` };
    let where = null;
    if (typeof flags.where === 'string' && flags.where.trim()) {
      const m = /^\s*(!?)([^=!]+?)\s*(?:=\s*(.*))?$/.exec(flags.where);
      if (!m || !NAME.test(columnName(m[2]))) return { error: 'Use --where column=value, --where column (has one) or --where !column (has none).' };
      where = { not: m[1] === '!', col: columnName(m[2]), value: m[3] === undefined ? undefined : m[3].trim() };
    }
    return { args: { want, where, csv: !!flags.csv } };
  }
  return { args: {} };
}

function client(request, token) {
  const call = async (method, pathname, body, options = {}) => {
    const result = await request(pathname, { token, method, timeoutMs: WAIT_MS, ...(body === undefined ? {} : { body }), ...options });
    if (result.ok) return result.data && typeof result.data === 'object' ? result.data : {};
    if (result.status === 402) throw Object.assign(new Error(LOCKED_LINE), { status: 402 });
    if (result.status === 401) throw new Error('Sign in to see your people. Run: atris login');
    if (result.status === 503) throw new Error('The people store is paused for a few minutes. Nothing was saved. Try again shortly.');
    if (result.status === 0 || result.status >= 500) throw new Error(method === 'GET' || options.read ? 'The people store did not answer. Try again in a moment.' : 'That may not have saved. Check with atris nexus columns, then try again.');
    throw new Error(S.plainError(result));
  };
  return {
    get: (p) => call('GET', p),
    patch: (p, body) => call('PATCH', p, body),
    search: (body) => call('POST', '/nexus/people/search', body, { read: true, retries: 0 }),
  };
}

// Every card, a page at a time.
async function everyone(api) {
  const all = [];
  for (let offset = 0; offset < 100000; offset += PAGE) {
    const data = await api.get(`/nexus/people?limit=${PAGE}&offset=${offset}`);
    const page = Array.isArray(data.people) ? data.people : [];
    all.push(...page);
    const total = Number(data.total);
    if (!page.length || page.length < PAGE || (Number.isFinite(total) && all.length >= total)) break;
  }
  return all;
}

// Rows as aligned text, every column left-aligned.
function grid(rows, indent = '  ') {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => indent + r.map((c, i) => String(c).padEnd(widths[i])).join('  ').replace(/\s+$/, ''));
}

function csvLine(values) {
  return values.map((v) => {
    const s = shown(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

function matchesWhere(card, where) {
  if (!where) return true;
  const got = shown(cell(card, where.col)).trim();
  if (where.value === undefined) return where.not ? !got : !!got;
  const same = got.toLowerCase() === where.value.toLowerCase();
  return where.not ? !same : same;
}

async function run(ctx) {
  const { sub, json, log, fail, usage } = ctx;
  const prep = prepare(sub, ctx.words, ctx.flags, ctx.env || process.env);
  if (prep.error) return usage(prep.error);
  const args = prep.args;
  const api = client(ctx.request, ctx.token);
  const out = (data) => log(JSON.stringify(data));
  const now = ctx.now || new Date();
  const by = args.helper ? String((ctx.env || process.env).ATRIS_MEMBER || 'helper').slice(0, 40) : 'you';

  try {
    if (sub === 'set' || sub === 'unset' || sub === 'undo') {
      const data = await api.search({ q: args.name, limit: 200 });
      const cards = Array.isArray(data.people) ? data.people : [];
      const found = ctx.pick({ rows: cards.map((card) => ({ name: String(card.name || ''), card })) }, args.name);
      if (found.stop !== undefined) return found.stop;
      const card = found.row.card;
      const key = PREFIX + args.col;
      const before = extras(card)[key];
      const had = before && typeof before === 'object' ? before : null;
      const yours = had && had.by === 'you';

      if (sub === 'set') {
        if (args.helper && yours && had.v !== args.value) {
          return fail(`You set ${args.col} on ${card.name} yourself, so a helper does not change it. It stays "${shown(had.v)}".`, { kept: had.v });
        }
        if (had && had.v === args.value && had.by === by) {
          if (json) out({ ok: true, did: 'set', name: card.name, column: args.col, value: args.value, changed: false });
          else log(`${card.name} already has ${args.col}: ${shown(args.value)}`);
          return 0;
        }
        const value = { v: args.value, by, at: now.toISOString() };
        if (args.source) value.src = args.source;
        if (had) value.was = { v: had.v, by: had.by, at: had.at, ...(had.src ? { src: had.src } : {}) };
        await api.patch(`/nexus/people/${encodeURIComponent(card.id)}/mine`, { extra: { [key]: value } });
        if (json) out({ ok: true, did: 'set', id: card.id, name: card.name, column: args.col, value: args.value, by, source: args.source || null, was: had ? had.v : null });
        else log(`${card.name}: ${args.col} is ${shown(args.value)}${had ? ` (was ${shown(had.v)}; atris nexus undo puts it back)` : ''}`);
        return 0;
      }

      if (!had) return fail(`${card.name} has no ${args.col}.`);
      if (args.helper && yours) return fail(`You set ${args.col} on ${card.name} yourself, so a helper does not take it off.`);

      if (sub === 'undo') {
        if (!had.was) return fail(`${args.col} on ${card.name} has nothing earlier to go back to. To take it off: atris nexus unset "${card.name}" ${args.col}`);
        await api.patch(`/nexus/people/${encodeURIComponent(card.id)}/mine`, { extra: { [key]: { ...had.was } } });
        if (json) out({ ok: true, did: 'undo', id: card.id, name: card.name, column: args.col, value: had.was.v, was: had.v });
        else log(`${card.name}: ${args.col} is back to ${shown(had.was.v)} (was ${shown(had.v)})`);
        return 0;
      }

      await api.patch(`/nexus/people/${encodeURIComponent(card.id)}/mine`, { extra: { [key]: null } });
      if (json) out({ ok: true, did: 'unset', id: card.id, name: card.name, column: args.col, was: had.v });
      else log(`${card.name}: took off ${args.col} (was ${shown(had.v)})`);
      return 0;
    }

    const cards = await everyone(api);

    if (sub === 'columns') {
      const tally = new Map();
      for (const card of cards) {
        for (const [key, got] of Object.entries(extras(card))) {
          if (!key.startsWith(PREFIX) || !got || typeof got !== 'object') continue;
          const col = key.slice(PREFIX.length);
          const t = tally.get(col) || { name: col, people: 0, you: 0, helpers: 0, values: new Map(), last: '' };
          t.people += 1;
          if (got.by === 'you') t.you += 1; else t.helpers += 1;
          const v = shown(got.v);
          t.values.set(v, (t.values.get(v) || 0) + 1);
          if (String(got.at || '') > t.last) t.last = String(got.at || '');
          tally.set(col, t);
        }
      }
      const columns = [...tally.values()].sort((a, b) => b.people - a.people || a.name.localeCompare(b.name)).map((t) => ({
        name: t.name, people: t.people, by_you: t.you, by_helpers: t.helpers, last_set: t.last || null,
        top_values: [...t.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([value, count]) => ({ value, count })),
      }));
      if (json) { out({ ok: true, people: cards.length, columns, built_in: Object.keys(BUILT_IN) }); return 0; }
      if (!columns.length) {
        log(`No columns of your own yet, across ${cards.length} people.`);
        log('Add one: atris nexus set "<name>" <column> <value>');
        return 0;
      }
      log(`Your columns, across ${cards.length} people:`);
      for (const line of grid(columns.map((c) => [
        c.name,
        `${c.people} ${c.people === 1 ? 'person' : 'people'}`,
        c.top_values.map((v) => `${v.value}: ${v.count}`).join(', '),
        [c.by_you && `you ${c.by_you}`, c.by_helpers && `helpers ${c.by_helpers}`].filter(Boolean).join(', '),
      ]))) log(line);
      log(`Every card also has: ${Object.keys(BUILT_IN).join(', ')}`);
      return 0;
    }

    // table
    const cols = ['name', ...args.want.filter((c) => c !== 'name')];
    const rows = cards.filter((card) => matchesWhere(card, args.where));
    if (json) {
      out({ ok: true, total: rows.length, columns: cols, rows: rows.map((card) => ({ id: card.id, ...Object.fromEntries(cols.map((c) => [c, cell(card, c) === undefined ? null : cell(card, c)])) })) });
      return 0;
    }
    if (args.csv) {
      log(csvLine(cols));
      for (const card of rows) log(csvLine(cols.map((c) => cell(card, c))));
      return 0;
    }
    if (!rows.length) { log('No one matches.'); return 0; }
    const lines = grid([cols, ...rows.slice(0, TEXT_ROWS).map((card) => cols.map((c) => shown(cell(card, c)).slice(0, 40)))]);
    for (const line of lines) log(line);
    if (rows.length > TEXT_ROWS) log(`Showing ${TEXT_ROWS} of ${rows.length}. Add --csv or --json for everyone.`);
    else log(`${rows.length} ${rows.length === 1 ? 'person' : 'people'}.`);
    return 0;
  } catch (error) {
    return fail(error && error.message, error && error.status ? { status: error.status } : {});
  }
}

module.exports = { SUBS, prepare, run };
