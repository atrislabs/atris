'use strict';

// atris nexus, store mode: the same commands, read and written through the shared
// people store (backend routers/nexus_router.py, signed in, under /nexus). The caller
// in commands/nexus.js decides what to do when the store is not there.
//
//   StoreDown    the store did not answer (no connection, not found, server error) before
//                anything was written. The caller falls back to the saved list.
//   StoreLocked  the store answered 402: Nexus needs a paid plan. Never falls back.
//   StoreError   anything else, with a plain sentence. Never falls back.
//
// Once a write has been sent, a failure is a StoreError: the write may have landed, and
// writing the same change to the saved list as well would leave the two out of step.

const { NOT_LOGGED_IN } = require('../lib/developer-api');
const model = require('../lib/nexus-model');
const S = require('../lib/nexus-store');

const WAIT_MS = 15000;
const LOCKED_LINE = 'Nexus needs a paid plan. Get it at https://nexus.atris.ai';
const BRING_OVER_LINE = 'Your people store is empty, but your saved list has people. Run: atris nexus bring-over';
const FIND_LIMIT = 25;
const FIND_ALL_LIMIT = 200; // the most one page of the store gives
const CITY_LIMIT = 50;
const CITY_ALL_LIMIT = 500;
const GROUP = 'People you met'; // what the file's add puts on a new person

class StoreDown extends Error {}
class StoreLocked extends Error {}
class StoreError extends Error {}

const enc = encodeURIComponent;

function storeClient(request, token) {
  let wrote = false;
  const call = async (method, pathname, body, options = {}) => {
    if (method !== 'GET') wrote = true;
    const result = await request(pathname, {
      token,
      method,
      timeoutMs: WAIT_MS,
      ...(body === undefined ? {} : { body }),
      ...options,
    });
    if (result.ok) return result.data && typeof result.data === 'object' ? result.data : {};
    const status = result.status;
    if (status === 402) throw new StoreLocked(LOCKED_LINE);
    if (status === 401) throw new StoreError(`Sign in to see your people. ${NOT_LOGGED_IN}`);
    if (status === 0 || status === 404 || status >= 500) {
      if (!wrote) throw new StoreDown('The people store did not answer.');
      throw new StoreError('That did not save. Try again in a moment.');
    }
    throw new StoreError(S.plainError(result));
  };
  return {
    get: (pathname) => call('GET', pathname),
    // A repeat of a POST would add the person or the note twice, so these are sent once.
    post: (pathname, body, options = { retries: 0 }) => call('POST', pathname, body, options),
    patch: (pathname, body) => call('PATCH', pathname, body),
    put: (pathname, body) => call('PUT', pathname, body),
  };
}

/** What a sub-command needs from its words, checked before any call. { error } or { args }. */
function prepare(sub, words, flags, now) {
  if (sub === 'due') {
    const day = S.parseDay(words[2], now);
    if (!words[2]) return { error: 'atris nexus due needs a name and a date' };
    if (!day.ok) return { error: `"${words[2]}" is not a date. Use YYYY-MM-DD, today, tomorrow or clear.` };
    return { args: { day: day.day, move: words.slice(3).join(' ').trim() } };
  }
  if (sub === 'paid') {
    if (!words[2]) return { error: 'atris nexus paid needs a name and an amount' };
    const cents = S.parseMoney(words[2]);
    if (cents === null) return { error: `"${words[2]}" is not an amount. Use dollars, like 50 or 1200.50.` };
    return { args: { cents, checked: !!flags.checked } };
  }
  if (sub === 'goal') {
    const given = {};
    for (const word of words.slice(1, 3)) {
      if (S.looksLikeDay(word)) {
        const day = S.parseDay(word, now);
        if (!day.ok || given.day !== undefined) return { error: `"${word}" is not a date. Use YYYY-MM-DD.` };
        given.day = day.day;
      } else {
        const cents = S.parseMoney(word);
        if (cents === null || given.cents !== undefined) return { error: `"${word}" is not an amount. Use dollars, like 10000.` };
        given.cents = cents;
      }
    }
    if (words.length > 3) return { error: 'atris nexus goal takes an amount and a date, nothing more' };
    return { args: given };
  }
  return { args: {} };
}

async function runStore(ctx) {
  const { sub, words, flags, json, log, err, fail, usage, now } = ctx;
  const client = storeClient(ctx.request, ctx.token);
  const tz = ctx.tz ? `tz=${enc(ctx.tz)}` : '';
  const withTz = (path) => (tz ? `${path}?${tz}` : path);
  const out = (data) => log(JSON.stringify(data));
  const cardsOf = (data) => (Array.isArray(data.people) ? data.people : []);
  const mineId = (card) => `/nexus/people/${enc(card.id)}/mine`;

  // The store is reachable but holds no one; the saved list does. Say so once, never act on it.
  const emptyHint = async () => {
    try {
      const mine = await client.get('/nexus/people?limit=1');
      return Number(mine.total) === 0 && (await ctx.fileHasPeople()) ? BRING_OVER_LINE : '';
    } catch {
      return '';
    }
  };

  // The person a name points at, among the store's own cards. Stops with a message when
  // there are none or several.
  const pick = async (name) => {
    const data = await client.get(`/nexus/people?q=${enc(name)}&limit=${FIND_ALL_LIMIT}`);
    const cards = cardsOf(data);
    const hint = cards.length ? '' : await emptyHint();
    const found = ctx.pick({ rows: cards.map((card) => ({ name: String(card.name || ''), card })) }, name);
    if (found.stop !== undefined && hint) err(hint);
    return found.row ? { card: found.row.card } : { stop: found.stop };
  };

  if (sub === 'wall') {
    const data = await client.get(withTz('/nexus/wall'));
    const hint = data.people === 0 ? await emptyHint() : '';
    if (json) out(data);
    else for (const line of S.wallLines(data, now)) log(line);
    if (hint) err(hint);
    return 0;
  }

  if (sub === 'goal') {
    const given = ctx.prep.args;
    if (given.cents === undefined && given.day === undefined) {
      const { goal } = await client.get('/nexus/goal');
      if (json) out({ goal: goal || null });
      else if (!goal || (goal.goal_cents == null && !goal.goal_date)) log('No goal set. Set one: atris nexus goal 10000 2026-12-15');
      else log(`Goal: ${[goal.goal_cents == null ? '' : S.formatMoney(goal.goal_cents), goal.goal_date ? `by ${model.shortDay(goal.goal_date, now)}` : ''].filter(Boolean).join(' ')}`);
      return 0;
    }
    // Setting one half keeps the other: the store writes both fields every time.
    const { goal: current } = await client.get('/nexus/goal');
    const body = {
      goal_cents: given.cents !== undefined ? given.cents : (current && current.goal_cents != null ? current.goal_cents : null),
      goal_date: given.day !== undefined ? given.day : (current && current.goal_date ? current.goal_date : null),
    };
    const saved = await client.put('/nexus/goal', body);
    if (json) out(saved);
    else {
      const g = saved.goal || body;
      log(`Goal set: ${[g.goal_cents == null ? '' : S.formatMoney(g.goal_cents), g.goal_date ? `by ${model.shortDay(g.goal_date, now)}` : ''].filter(Boolean).join(' ')}`);
    }
    return 0;
  }

  if (sub === 'bring-over') {
    const { list, missing } = await ctx.fileClient.read();
    const count = missing ? 0 : S.filePeople(list);
    if (!count) {
      if (json) out({ ok: true, created: 0, matched: 0, skipped: 0, ties_added: 0, touches_added: 0 });
      else log('Your saved list has no one to bring over.');
      return 0;
    }
    if (count > S.MAX_IMPORT_PEOPLE) return fail(`Your saved list has ${count} people and one import takes at most ${S.MAX_IMPORT_PEOPLE}. Nothing was sent.`);
    const done = await client.post('/nexus/import', { nodes: list.nodes, edges: list.edges }, { retries: 0, timeoutMs: 600000 });
    if (json) out(done);
    else {
      const parts = [`${done.created || 0} new`, `${done.matched || 0} already there`];
      if (done.skipped) parts.push(`${done.skipped} skipped`);
      log(`Brought over ${S.plural(count, 'person', 'people')}: ${parts.join(', ')}.`);
      log(`${S.plural(done.ties_added || 0, 'tie', 'ties')} and ${S.plural(done.touches_added || 0, 'note', 'notes')} added. Your saved list was not changed.`);
    }
    return 0;
  }

  if (sub === 'city') {
    const query = words.slice(1).join(' ');
    const { places } = await client.get('/nexus/places');
    const all = Array.isArray(places) ? places : [];
    const hits = S.cityMatches(all, query);
    if (hits.length !== 1) {
      const hint = !all.length ? await emptyHint() : '';
      if (hint) err(hint);
      if (!hits.length) return fail(`No city called "${query}" in your people store.`);
      const names = hits.slice(0, 10).map(S.placeName);
      return fail(`${hits.length} places match "${query}". Use one of: ${names.join('; ')}`, { matches: names });
    }
    const place = hits[0];
    const data = await client.get(`/nexus/places/${enc(place.id)}/people?limit=${flags.all ? CITY_ALL_LIMIT : CITY_LIMIT}`);
    if (json) { out(data); return 0; }
    const people = cardsOf(data);
    const yours = people.filter((card) => card.mine).length;
    log(`${S.placeName(place)}: ${S.plural(data.total || 0, 'person', 'people')}${yours ? `, ${yours} yours` : ''}`);
    const rows = people.map((card) => {
      const p = card.private || {};
      return {
        name: String(card.name || 'Unnamed'),
        company: String(card.company_name || ''),
        stage: card.mine ? S.stageLabel(p.stage) : '',
        mark: card.mine ? 'yours' : '',
      };
    });
    if (rows.length) {
      const wide = [0, 1, 2].map((i) => Math.max(...rows.map((r) => [r.name, r.company, r.stage][i].length)));
      for (const r of rows) log(`  ${r.name.padEnd(wide[0])}  ${r.company.padEnd(wide[1])}  ${r.stage.padEnd(wide[2])}  ${r.mark}`.replace(/\s+$/, ''));
    }
    if ((data.total || 0) > people.length) log(`Showing ${people.length} of ${data.total}.${flags.all ? '' : ' Add --all for more.'}`);
    return 0;
  }

  if (sub === 'find') {
    const query = words.slice(1).join(' ');
    const data = await client.get(`/nexus/people?q=${enc(query)}&limit=${flags.all ? FIND_ALL_LIMIT : FIND_LIMIT}`);
    const people = cardsOf(data);
    const total = Number(data.total) || people.length;
    const hint = total === 0 ? await emptyHint() : '';
    if (json) out(data);
    else if (!total) log(`No one on your list matches "${query}".`);
    else {
      log(`${S.plural(total, 'person matches', 'people match')} "${query}".`);
      const rows = people.map((card) => {
        const p = card.private || {};
        return { name: String(card.name || ''), company: String(card.company_name || ''), close: model.closeness(p.closeness), stage: S.stageLabel(p.stage), move: String(p.next_move || '') };
      });
      for (const line of ctx.view.tableLines(rows)) log(line);
      if (total > people.length) log(`Showing ${people.length} of ${total}.${flags.all ? '' : ' Add --all for every match.'}`);
    }
    if (hint) err(hint);
    return 0;
  }

  if (sub === 'add') {
    const name = words.slice(1).join(' ').trim();
    // The store never matches on a name alone, so the same person typed twice would be two
    // cards. The saved list refuses that, and so does this.
    const twins = await client.get(`/nexus/people?q=${enc(name)}&limit=${FIND_ALL_LIMIT}`);
    const twin = cardsOf(twins).find((card) => String(card.name || '').trim().toLowerCase() === name.toLowerCase());
    if (twin) return fail(`${twin.name} is already on your list.`);
    const body = { name, stage: 'met', closeness: 1, group_name: GROUP, source: 'manual' };
    for (const [flag, key] of [['title', 'title'], ['company', 'company'], ['city', 'location'], ['email', 'email'], ['note', 'note']]) {
      const value = typeof flags[flag] === 'string' ? flags[flag].trim() : '';
      if (value) body[key] = value;
    }
    const done = await client.post('/nexus/people', body);
    if (json) { out(done); return 0; }
    const card = done.card || {};
    const facts = [card.title, card.company_name, card.location_raw].filter(Boolean).join(' · ');
    if (done.created === false) log(`${card.name || name} was already in your store, so their details were updated.`);
    else log(`Added ${card.name || name}${facts ? ` (${facts})` : ''}, as someone you met.`);
    if (done.conflict) err('Another card already holds one of these keys. Not merged.');
    return 0;
  }

  if (sub === 'stage') {
    const stage = S.stageFromWord(words[2]);
    const found = await pick(words[1]);
    if (found.stop !== undefined) return found.stop;
    const before = S.stageLabel(found.card.private && found.card.private.stage);
    const done = await client.patch(mineId(found.card), { stage });
    if (json) { out(done); return 0; }
    log(`${found.card.name} is now ${S.stageLabel(done.card && done.card.private ? done.card.private.stage : stage)} (was ${before}).`);
    return 0;
  }

  if (sub === 'note') {
    const body = words.slice(2).join(' ').trim();
    const found = await pick(words[1]);
    if (found.stop !== undefined) return found.stop;
    const done = await client.post('/nexus/touches', { person_id: found.card.id, kind: 'note', body });
    // The card's own note keeps what was there and adds this after it. The history above
    // holds every note on its own, so one too long to fit is left out of the note only.
    const had = String((found.card.private && found.card.private.note) || '').trim();
    const joined = had ? `${had} | ${body}` : body;
    let updated = true;
    if (joined.length <= S.NOTE_MOST) {
      try {
        await client.patch(mineId(found.card), { note: joined });
      } catch {
        updated = false;
      }
    }
    if (json) out(done);
    else log(`Noted on ${found.card.name}: ${(done.touch && done.touch.body) || body}`);
    if (!updated) err('The note on the card did not update. The note is saved in the history.');
    return 0;
  }

  if (sub === 'due') {
    const found = await pick(words[1]);
    if (found.stop !== undefined) return found.stop;
    const { day, move } = ctx.prep.args;
    const done = await client.patch(mineId(found.card), { due_on: day, ...(move ? { next_move: move } : {}) });
    if (json) { out(done); return 0; }
    if (day === null) log(`Follow-up for ${found.card.name} cleared.`);
    else log(`Follow-up for ${found.card.name} set for ${model.shortDay(day, now)}.${move ? ` Next move: ${move}` : ''}`);
    return 0;
  }

  if (sub === 'paid') {
    const found = await pick(words[1]);
    if (found.stop !== undefined) return found.stop;
    const { cents, checked } = ctx.prep.args;
    // Every call says whether the money is checked, so a new amount is never left looking checked.
    const done = await client.patch(mineId(found.card), { paid_cents: cents, paid_checked: checked });
    if (json) { out(done); return 0; }
    log(`${S.formatMoney(cents)} recorded for ${found.card.name}. ${checked ? 'Checked, so it counts on the wall.' : 'Not checked, so it does not count yet. Add --checked once you have seen the money.'}`);
    return 0;
  }

  if (words.length) {
    const found = await pick(words.join(' '));
    if (found.stop !== undefined) return found.stop;
    const detail = await client.get(`/nexus/people/${enc(found.card.id)}`);
    if (json) { out(detail); return 0; }
    const card = detail.card || found.card;
    const ties = Array.isArray(detail.ties) ? detail.ties : [];
    const touches = Array.isArray(detail.touches) ? detail.touches : [];
    // "Ask <name> for an intro" needs the name of the person who would make it.
    const viaId = card.private && card.private.via_person_id;
    let viaName = ties.some((tie) => tie.other_person_id === viaId) ? '' : undefined;
    if (viaId && viaName === undefined) {
      try { viaName = String(((await client.get(`/nexus/people/${enc(viaId)}`)).card || {}).name || ''); } catch { viaName = ''; }
    }
    const list = S.cardToList(card, ties, touches, viaName || '');
    const people = model.buildPeople(list, now);
    const row = people.rows.find((r) => r.at === 1);
    const c = ctx.view.card(people, row, now);
    const mine = card.private || {};
    if (mine.next_move) c.move = mine.next_move;
    const lines = ctx.view.cardLines(c);
    const extra = [];
    if (mine.due_on) extra.push(`Follow up: ${model.shortDay(mine.due_on, now)}`);
    if (mine.paid_cents) extra.push(`Paid: ${S.formatMoney(mine.paid_cents)}${mine.paid_checked ? ' (checked)' : ', not checked, so not counted'}`);
    const next = lines.findIndex((line) => line.startsWith('Next:'));
    lines.splice(next < 0 ? lines.length : next + 1, 0, ...extra);
    for (const line of lines) log(line);
    return 0;
  }

  // today
  const data = await client.get(withTz('/nexus/today'));
  const people = cardsOf(data);
  const hint = people.length ? '' : await emptyHint();
  if (json) out(data);
  else {
    log('Today');
    if (people.length) for (const p of people) log(`  ${p.name || 'Someone'}: ${S.reasonLine(p.reason, p.days)}`);
    else log('  Nothing is waiting on you today.');
    const total = Number(data.total) || people.length;
    if (total > people.length) log(`  Showing ${people.length} of ${total}.`);
  }
  if (hint) err(hint);
  return 0;
}

module.exports = { runStore, prepare, StoreDown, StoreLocked, StoreError, LOCKED_LINE, BRING_OVER_LINE };
