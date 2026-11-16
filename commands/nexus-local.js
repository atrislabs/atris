'use strict';

// atris nexus, local copy: the caller's own people kept as plain files on this computer,
// so they can be read with no connection. The store stays the source: pull copies it down,
// push-notes sends notes written offline back up. Only the caller's own cards and their
// own layer are kept (cards with mine true, their private fields, their own touches and
// saved lists). Nothing from a business they belong to and no one else's notes is written.
//
//   ~/.atris/nexus/index.json          one line per person, for search and lookups
//   ~/.atris/nexus/lists.json          the caller's saved lists and who is in each
//   ~/.atris/nexus/people/<id>.json    one person: { card, touches }
//   ~/.atris/nexus/inbox.json          notes written offline, waiting for push-notes

const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../lib/nexus-model');
const S = require('../lib/nexus-store');
const { storeClient, StoreDown, StoreLocked, StoreError } = require('./nexus-store');

const SUBS = new Set(['pull', 'local', 'push-notes']);
const LOCAL_SUBS = new Set(['search', 'find', 'show', 'note']);
const PAGE = 200;
const MAX_PAGES = 1000;
const TOUCHES_PER_PERSON = 20;
const NOTE_MOST = 4000;
const SEARCH_LIMIT = 25;
const ID_RE = /^[0-9a-f-]{8,64}$/i;
const CARD_FIELDS = ['id', 'mine', 'is_public', 'name', 'title', 'company_name', 'org_id', 'place_id', 'location_raw', 'linkedin_url', 'x_handle', 'website', 'place', 'org', 'private'];
const NO_COPY = 'No local copy yet. Run: atris nexus pull';
const enc = encodeURIComponent;

function localDir(deps = {}) {
  const env = deps.env || process.env;
  return deps.nexusDir || env.ATRIS_NEXUS_DIR || path.join(os.homedir(), '.atris', 'nexus');
}

function shortPath(dir) {
  const home = os.homedir();
  return dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir;
}

// Private data: only the owner may read it. Written to a side file first, then moved, so a
// crash never leaves half a file.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw new Error(`${shortPath(file)} could not be read. Run atris nexus pull to rebuild it.`);
  }
}

/** Only the caller's own card, field by field. Anything else the store sends is left out. */
function ownCard(card) {
  const out = {};
  for (const key of CARD_FIELDS) if (card[key] !== undefined) out[key] = card[key];
  return out;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function indexRow(card, touches) {
  const p = card.private || {};
  const row = {
    id: card.id,
    name: text(card.name),
    title: text(card.title),
    company: text(card.company_name) || text(card.org && card.org.name),
    city: text(card.location_raw) || text(card.place && card.place.city),
    stage: p.stage || '',
    closeness: p.closeness || null,
    group: text(p.group_name),
    next_move: text(p.next_move),
    due_on: p.due_on || null,
  };
  const notes = touches.map((t) => text(t.body)).filter(Boolean);
  row.words = [row.name, row.title, row.company, row.city, S.stageLabel(row.stage), row.group, text(p.email), text(p.note), row.next_move, ...notes]
    .filter(Boolean).join(' ').toLowerCase();
  return row;
}

// Every one of the caller's cards, page by page. The store hands back a cursor for the next
// full page; an older store without one is paged by offset.
async function allCards(client) {
  const cards = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = cursor ? `&cursor=${enc(cursor)}` : (cards.length ? `&offset=${cards.length}` : '');
    const data = await client.get(`/nexus/people?limit=${PAGE}${query}`);
    const people = Array.isArray(data.people) ? data.people : [];
    cards.push(...people);
    if (people.length < PAGE) return cards;
    cursor = data.next_cursor || null;
    if (!cursor && data.total != null && cards.length >= Number(data.total)) return cards;
  }
  throw new StoreError('Your list is bigger than one pull can take. Nothing was changed.');
}

// Who is in each saved list, read through search with the list's id. A store too old to
// answer that keeps the list with its count only.
async function listMembers(client, listId, keep) {
  const ids = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { list_id: listId, limit: PAGE, ...(cursor ? { cursor } : { offset: ids.length }) };
    let data;
    try {
      data = await client.search(body);
    } catch (error) {
      if (error instanceof StoreLocked) throw error;
      return null;
    }
    const people = Array.isArray(data.people) ? data.people : [];
    for (const card of people) if (card && keep.has(card.id)) ids.push(card.id);
    if (people.length < PAGE) break;
    cursor = data.next_cursor || null;
  }
  return ids;
}

async function pull(ctx) {
  const { log, json, now, dir } = ctx;
  const client = storeClient(ctx.request, ctx.token);
  const cards = (await allCards(client)).filter((card) => card && card.mine === true && ID_RE.test(String(card.id || '')));
  const ids = new Set(cards.map((card) => card.id));
  const touchData = await client.get(`/nexus/touches?per_person=${TOUCHES_PER_PERSON}`);
  const touchesBy = touchData && touchData.touches && typeof touchData.touches === 'object' ? touchData.touches : {};
  const listData = await client.get('/nexus/lists');
  const lists = [];
  for (const item of Array.isArray(listData.lists) ? listData.lists : []) {
    if (!item || !item.id) continue;
    const people = await listMembers(client, item.id, ids);
    lists.push({ id: String(item.id), name: String(item.name || ''), count: Number(item.count) || 0, ...(people ? { people } : {}) });
  }

  // Everything is in hand. Only now does the folder change.
  const peopleDir = path.join(dir, 'people');
  fs.mkdirSync(peopleDir, { recursive: true, mode: 0o700 });
  const tally = { people: cards.length, added: 0, changed: 0, removed: 0, same: 0, lists: lists.length };
  const rows = [];
  for (const card of cards) {
    const touches = (Array.isArray(touchesBy[card.id]) ? touchesBy[card.id] : [])
      .map((t) => ({ id: t.id, kind: t.kind, body: t.body, at: t.at }));
    const person = { card: ownCard(card), touches };
    const file = path.join(peopleDir, `${card.id}.json`);
    const next = `${JSON.stringify(person, null, 2)}\n`;
    let before = null;
    try { before = fs.readFileSync(file, 'utf8'); } catch { before = null; }
    if (before === next) tally.same++;
    else {
      writeJson(file, person);
      tally[before === null ? 'added' : 'changed']++;
    }
    rows.push(indexRow(card, touches));
  }
  for (const name of fs.readdirSync(peopleDir)) {
    if (!name.endsWith('.json') || ids.has(name.slice(0, -5))) continue;
    fs.unlinkSync(path.join(peopleDir, name));
    tally.removed++;
  }
  rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
  const pulledAt = now.toISOString();
  writeJson(path.join(dir, 'lists.json'), { pulled_at: pulledAt, lists });
  writeJson(path.join(dir, 'index.json'), { version: 1, pulled_at: pulledAt, total: rows.length, people: rows });

  if (json) log(JSON.stringify({ ok: true, dir, ...tally, pulled_at: pulledAt }));
  else {
    log(`Pulled ${S.plural(tally.people, 'person', 'people')} into ${shortPath(dir)}: ${tally.added} new, ${tally.changed} changed, ${tally.removed} removed, ${tally.same} the same.`);
    log(`${S.plural(tally.lists, 'saved list', 'saved lists')} copied.`);
  }
  return 0;
}

function loadIndex(dir) {
  const index = readJson(path.join(dir, 'index.json'), null);
  return index && Array.isArray(index.people) ? index : null;
}

function loadInbox(dir) {
  const inbox = readJson(path.join(dir, 'inbox.json'), { notes: [] });
  return { notes: Array.isArray(inbox.notes) ? inbox.notes : [] };
}

// One person by id (whole or the first 8 or more characters), else by name.
function resolve(ctx, index, query) {
  const want = String(query || '').trim();
  const lower = want.toLowerCase();
  if (ID_RE.test(want)) {
    const byId = index.people.filter((row) => row.id.toLowerCase() === lower || (want.length >= 8 && row.id.toLowerCase().startsWith(lower)));
    if (byId.length === 1) return { row: byId[0] };
  }
  return ctx.findPerson({ rows: index.people }, want);
}

function stopOnPick(ctx, found, query) {
  const { log, err, json } = ctx;
  const names = (found.matches || []).map((row) => row.name);
  if (!names.length) return ctx.fail(`No one called "${query}" is in your local copy.`, { matches: [] });
  const shown = names.slice(0, 10);
  if (json) log(JSON.stringify({ ok: false, error: `${names.length} people match "${query}". Use the full name or the id.`, matches: shown, total: names.length }));
  else {
    err(`${names.length} people match "${query}". Use the full name or the id:`);
    for (const row of found.matches.slice(0, 10)) err(`  ${row.name}  ${row.id}`);
    if (names.length > shown.length) err(`  and ${names.length - shown.length} more`);
  }
  return 1;
}

function localSearch(ctx, index, query) {
  const { log, json, flags } = ctx;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = index.people
    .filter((row) => terms.every((term) => row.words.includes(term)))
    .map((row) => ({ row, score: terms.every((term) => row.name.toLowerCase().includes(term)) ? 0 : 1 }))
    .sort((a, b) => a.score - b.score)
    .map((hit) => hit.row);
  const shown = flags.all ? hits : hits.slice(0, SEARCH_LIMIT);
  if (json) {
    log(JSON.stringify({ ok: true, query, total: hits.length, pulled_at: index.pulled_at, people: shown.map(({ words, ...row }) => row) }));
    return 0;
  }
  if (!hits.length) {
    log(`No one in your local copy matches "${query}".`);
    return 0;
  }
  log(`${S.plural(hits.length, 'person matches', 'people match')} "${query}" in your local copy.`);
  const rows = shown.map((row) => ({ name: row.name, company: row.company, close: model.closeness(row.closeness), stage: S.stageLabel(row.stage), move: row.next_move }));
  for (const line of ctx.view.tableLines(rows)) log(line);
  if (shown.length < hits.length) log(`Showing ${shown.length} of ${hits.length}. Add --all for every match.`);
  return 0;
}

function localShow(ctx, index, query) {
  const { log, json, now, dir } = ctx;
  const found = resolve(ctx, index, query);
  if (!found.row) return stopOnPick(ctx, found, query);
  const person = readJson(path.join(dir, 'people', `${found.row.id}.json`), null);
  if (!person || !person.card) return ctx.fail(`${found.row.name} is in the index but their file is missing. Run atris nexus pull.`);
  const waiting = loadInbox(dir).notes.filter((n) => n.person_id === found.row.id);
  if (json) {
    log(JSON.stringify({ ok: true, pulled_at: index.pulled_at, ...person, waiting }));
    return 0;
  }
  const people = model.buildPeople(S.cardToList(person.card, [], person.touches || [], ''), now);
  const row = people.rows.find((r) => r.at === 1);
  const c = ctx.view.card(people, row, now);
  c.ties = [];
  const mine = person.card.private || {};
  if (mine.next_move) c.move = mine.next_move;
  const lines = ctx.view.cardLines(c);
  const extra = [];
  if (mine.due_on) extra.push(`Follow up: ${model.shortDay(mine.due_on, now)}`);
  if (mine.paid_cents) extra.push(`Paid: ${S.formatMoney(mine.paid_cents)}${mine.paid_checked ? ' (checked)' : ', not checked, so not counted'}`);
  const next = lines.findIndex((line) => line.startsWith('Next:'));
  lines.splice(next < 0 ? lines.length : next + 1, 0, ...extra);
  if (waiting.length) {
    lines.push('', 'Not sent yet');
    for (const n of waiting) lines.push(`  ${n.text}`);
  }
  lines.push('', `Id: ${found.row.id}`, `From your local copy, pulled ${model.shortDay(String(index.pulled_at || '').slice(0, 10), now) || 'earlier'}.`);
  for (const line of lines) log(line);
  return 0;
}

function localNote(ctx, index, query, body) {
  const { log, json, now, dir } = ctx;
  if (body.length > NOTE_MOST) return ctx.usage(`A note can be at most ${NOTE_MOST} characters.`);
  const found = resolve(ctx, index, query);
  if (!found.row) return stopOnPick(ctx, found, query);
  const inbox = loadInbox(dir);
  const note = { person_id: found.row.id, name: found.row.name, text: body, at: now.toISOString() };
  inbox.notes.push(note);
  writeJson(path.join(dir, 'inbox.json'), inbox);
  if (json) log(JSON.stringify({ ok: true, did: 'local-note', ...note, waiting: inbox.notes.length }));
  else {
    log(`Noted on ${found.row.name}, on this computer only.`);
    log(`${S.plural(inbox.notes.length, 'note waits', 'notes wait')} to be sent. Run atris nexus push-notes when you are back online.`);
  }
  return 0;
}

function runLocal(ctx) {
  const { words } = ctx;
  const what = words[1];
  if (!LOCAL_SUBS.has(what)) return ctx.usage('atris nexus local takes search "<words>", show "<name or id>" or note "<name or id>" "<text>"');
  const query = String(words[2] || '').trim();
  if (!query) return ctx.usage(what === 'show' || what === 'note' ? `atris nexus local ${what} needs a name or an id` : `atris nexus local ${what} needs words to look for`);
  const body = words.slice(3).join(' ').trim();
  if (what === 'note' && !body) return ctx.usage('atris nexus local note needs a name or an id and the note text');
  const index = loadIndex(ctx.dir);
  if (!index) return ctx.fail(NO_COPY);
  if (what === 'show') return localShow(ctx, index, query);
  if (what === 'note') return localNote(ctx, index, query, body);
  return localSearch(ctx, index, words.slice(2).join(' ').trim());
}

// Notes written offline, sent one at a time and taken off the list as each lands, so a
// connection that drops half way never sends one twice.
async function pushNotes(ctx) {
  const { log, err, json, dir } = ctx;
  const inbox = loadInbox(dir);
  if (!inbox.notes.length) {
    if (json) log(JSON.stringify({ ok: true, sent: 0, waiting: 0 }));
    else log('No notes are waiting to be sent.');
    return 0;
  }
  const sent = [];
  const kept = [];
  let stopped = '';
  for (const note of inbox.notes) {
    if (stopped) { kept.push(note); continue; }
    const client = storeClient(ctx.request, ctx.token);
    // Read straight, so a card gone from the store (404) is told apart from no connection.
    const found = await ctx.request(`/nexus/people/${enc(note.person_id)}`, { token: ctx.token, timeoutMs: 15000 });
    if (!found.ok && found.status !== 404) {
      stopped = found.status === 402 ? 'Nexus needs a paid plan. Get it at https://nexus.atris.ai'
        : found.status === 401 ? `Sign in to send your notes. ${ctx.notLoggedIn}`
          : 'The people store did not answer. Your notes are still waiting on this computer.';
      kept.push(note);
      continue;
    }
    const card = found.ok && found.data && found.data.card;
    if (!card || card.mine !== true) {
      err(`${note.name || note.person_id} is not on your list in the store. That note was kept here.`);
      kept.push(note);
      continue;
    }
    let done;
    try {
      done = await client.post('/nexus/touches', { person_id: note.person_id, kind: 'note', body: note.text, ...(note.at ? { at: note.at } : {}) });
    } catch (error) {
      stopped = `${error.message} The note for ${note.name || 'that person'} and any after it are still waiting.`;
      kept.push(note);
      continue;
    }
    sent.push(note);
    writeJson(path.join(dir, 'inbox.json'), { notes: inbox.notes.filter((n) => !sent.includes(n)) });
    // The card's own note gets the text after what was there, as atris nexus note does.
    const had = text(card.private && card.private.note);
    const joined = had ? `${had} | ${note.text}` : note.text;
    let mine = card.private || {};
    if (joined.length <= S.NOTE_MOST) {
      try {
        const patched = await client.patch(`/nexus/people/${enc(note.person_id)}/mine`, { note: joined });
        mine = (patched.card && patched.card.private) || { ...mine, note: joined };
      } catch {
        err(`The note on ${note.name || 'that card'} did not update. The note is saved in the history.`);
      }
    }
    keepLocal(dir, note.person_id, mine, (done && done.touch) || { kind: 'note', body: note.text, at: note.at });
  }
  writeJson(path.join(dir, 'inbox.json'), { notes: kept });
  if (json) log(JSON.stringify({ ok: !stopped, sent: sent.length, waiting: kept.length, ...(stopped ? { error: stopped } : {}) }));
  else {
    log(`Sent ${S.plural(sent.length, 'note', 'notes')}.${kept.length ? ` ${S.plural(kept.length, 'note is', 'notes are')} still waiting.` : ''}`);
    if (stopped) err(stopped);
  }
  return stopped ? 1 : 0;
}

// A sent note goes into the local copy as well, so show has it before the next pull.
function keepLocal(dir, id, mine, touch) {
  const file = path.join(dir, 'people', `${id}.json`);
  const person = readJson(file, null);
  if (!person || !person.card) return;
  person.card.private = { ...(person.card.private || {}), ...mine };
  person.touches = [{ id: touch.id, kind: touch.kind || 'note', body: touch.body, at: touch.at }, ...(person.touches || [])].slice(0, TOUCHES_PER_PERSON);
  writeJson(file, person);
  const index = loadIndex(dir);
  if (!index) return;
  const at = index.people.findIndex((row) => row.id === id);
  if (at >= 0) index.people[at] = indexRow(person.card, person.touches);
  writeJson(path.join(dir, 'index.json'), index);
}

async function run(ctx) {
  const { sub } = ctx;
  try {
    if (sub === 'local') return runLocal(ctx);
    const { token } = await ctx.getToken();
    if (!token) return ctx.fail(ctx.notLoggedIn);
    const withToken = { ...ctx, token };
    if (sub === 'pull') return await pull(withToken);
    return await pushNotes(withToken);
  } catch (error) {
    if (error instanceof StoreDown) return ctx.fail('The people store did not answer. Your local copy was not changed.');
    if (error instanceof StoreLocked) return ctx.fail(error.message, { status: 402 });
    return ctx.fail(error && error.message);
  }
}

module.exports = { SUBS, run, localDir, ownCard };
