'use strict';

// The Nexus people store (backend routers/nexus_router.py) in the shapes the command
// line already works with. Ported from atrisos-web app/dashboard/people/people-store.ts,
// so the command line and the page agree on stage names and on how a card reads.
// Keep the two in step. Pure: no network, no files.

const model = require('./nexus-model');

// The page's loop statuses and the store's stages.
const STAGE_STATUS = { found: 'prospect', reached_out: 'sent', replied: 'replied', met: 'met', paying: 'paying', partner: 'partner' };
// The same table the store's import uses: off-loop words sit at the furthest stage they reached.
const STATUS_STAGE = {
  prospect: 'found', sent: 'reached_out', replied: 'replied', met: 'met', proposal: 'met', paying: 'paying',
  partner: 'partner', silent: 'reached_out', hold: 'replied', lost: 'found', left: 'found',
};
const STAGE_LABEL = { found: 'Found', reached_out: 'Reached out', replied: 'Replied', met: 'Met', paying: 'Paying', partner: 'Partner' };
// The words the command line takes for a stage, on top of every file status word.
const CLI_STAGE = { found: 'found', reached: 'reached_out', reached_out: 'reached_out', replied: 'replied', met: 'met', paying: 'paying', partner: 'partner' };
// A touch kind as an activity word on the card.
const KIND_WORD = { note: 'Note', sent: 'Email sent', reply: 'They replied', met: 'Met', intro_asked: 'Intro asked' };

// One import takes at most this many people (backend services/nexus_people.py MAX_IMPORT_PEOPLE).
const MAX_IMPORT_PEOPLE = 2000;
const MAX_CENTS = 10 ** 13; // the store's own ceiling on any money field
const NOTE_MOST = 4000; // the store's ceiling on a note

const text = (value) => (typeof value === 'string' && value.trim() ? value : undefined);
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

function stageFromWord(word) {
  const w = String(word || '').trim().toLowerCase();
  return CLI_STAGE[w] || STATUS_STAGE[w] || null;
}

function stageLabel(stage) {
  return STAGE_LABEL[stage] || STAGE_LABEL.found;
}

/**
 * The status the page shows. The store keeps the file's own word in status_raw ("silent",
 * "proposal"), and that word shows while it still fits the stage. Once the stage moves on
 * the word is stale and the stage speaks.
 */
function statusOf(mine) {
  const stage = (mine && mine.stage) || 'found';
  const raw = text(mine && mine.status_raw);
  if (raw && (STATUS_STAGE[raw] || 'found') === stage) return raw;
  return STAGE_STATUS[stage] || 'prospect';
}

function actKind(what) {
  const w = String(what).toLowerCase();
  if (w.includes('replied') || w.includes('reply')) return 'reply';
  if (w.includes('intro')) return 'intro_asked';
  if (w.includes('sent')) return 'sent';
  if (w.startsWith('met') || w.includes(' met')) return 'met';
  return 'note';
}

/** One touch as a card activity row: [day, what, said]. */
function touchToRow(touch) {
  const day = String(touch.at || '').slice(0, 10);
  const body = touch.body || '';
  const kind = touch.kind in KIND_WORD ? touch.kind : 'note';
  if (kind === 'note') return [day, KIND_WORD.note, body];
  // The import folds the file's word into the body ("Email sent hi"); show that as it was.
  if (body && actKind(body) === kind) return [day, body, ''];
  return [day, KIND_WORD[kind], body];
}

/** One store card as one spot on the map. `names` maps card ids to names, for "via". */
function cardToPerson(card, touches = [], names = new Map()) {
  const mine = card.private || {};
  const extra = { ...record(card.extra), ...record(mine.extra) };
  const person = { t: 'p', n: text(card.name) || '', id: card.id, status: statusOf(mine) };
  if (mine.closeness === 1 || mine.closeness === 2) person.d = mine.closeness;
  const set = (key, value) => { if (value !== undefined) person[key] = value; };
  set('title', text(card.title));
  set('co', text(card.company_name));
  set('city', text(card.location_raw) || text(card.place && card.place.city));
  set('group', text(mine.group_name));
  set('note', text(mine.note));
  if (text(mine.email)) { person.email = mine.email; person.mail = 1; }
  set('last', text(mine.last_touch_at) && mine.last_touch_at.slice(0, 10));
  const links = [text(card.linkedin_url), text(card.x_handle) && `https://x.com/${card.x_handle}`, text(card.website)].filter(Boolean);
  if (links.length) person.links = links;
  if (touches.length) person.act = touches.map(touchToRow);
  if (typeof extra.tags === 'string') person.tags = extra.tags;
  if (typeof extra.kind === 'string') person.kind = extra.kind;
  if (extra.warm !== undefined && extra.warm !== null) person.warm = extra.warm;
  if (Array.isArray(extra.proof)) person.proof = extra.proof.filter((p) => typeof p === 'string');
  if (typeof extra.cid === 'number') person.cid = extra.cid;

  const x = {};
  const via = mine.via_person_id ? names.get(mine.via_person_id) : undefined;
  if (via) x.via = via;
  if (text(mine.fit)) x.fit = mine.fit;
  if (text(mine.deal)) x.deal = mine.deal;
  if (typeof extra.knows === 'number') x.knows = extra.knows;
  for (const key of ['next_move', 'due_on', 'deal_value_cents', 'paid_cents', 'paid_checked']) {
    if (mine[key] !== undefined && mine[key] !== null) x[key] = mine[key];
  }
  // The file's "chk" is a checked payment, which scoring counts as value.
  if (x.paid_checked === true) x.chk = 1;
  if (Object.keys(x).length) person.x = x;
  return person;
}

/**
 * One card and what hangs off it as a small map the model can score: you, the person, and
 * the people they are tied to. Ties come as names only; nothing else about them is known.
 */
function cardToList(card, ties = [], touches = [], viaName = '') {
  const names = new Map();
  for (const tie of ties) if (tie.other_person_id && text(tie.other_name)) names.set(tie.other_person_id, tie.other_name);
  const via = card.private && card.private.via_person_id;
  if (via && viaName) names.set(via, viaName);
  const person = cardToPerson(card, touches, names);
  const nodes = [{ t: 'p', n: 'You', me: 1, d: 0 }, person];
  const edges = [];
  if (person.d === 1) edges.push([0, 1, 'knows']);
  for (const tie of ties) {
    if (!text(tie.other_name)) continue;
    edges.push([1, nodes.push({ t: 'p', n: tie.other_name }) - 1, text(tie.label) || 'knows']);
  }
  return { nodes, edges };
}

/** True when a people file has anyone in it to bring across. */
function filePeople(list) {
  return list.nodes.filter((n) => n.t === 'p' && !n.me && !n.g).length;
}

// ---- money and days ----

/** "$1,200.50", "1200.5" or "50" as whole cents. Null when it is not a plain amount. */
function parseMoney(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null;
}

/** Whole cents as dollars with cents: $1,234.50. */
function formatMoney(cents) {
  const n = Math.max(0, Math.round(Number(cents) || 0));
  const dollars = String(Math.floor(n / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${dollars}.${String(n % 100).padStart(2, '0')}`;
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** A day word: YYYY-MM-DD, today, tomorrow, or clear. { ok, day } where day is null for clear. */
function parseDay(value, now = new Date()) {
  const w = String(value || '').trim().toLowerCase();
  if (w === 'today') return { ok: true, day: localDay(now) };
  if (w === 'tomorrow') return { ok: true, day: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) };
  if (w === 'clear' || w === 'none') return { ok: true, day: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (!m) return { ok: false };
  const real = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const same = real.getUTCFullYear() === Number(m[1]) && real.getUTCMonth() === Number(m[2]) - 1 && real.getUTCDate() === Number(m[3]);
  return same ? { ok: true, day: w } : { ok: false };
}

const looksLikeDay = (value) => /^(\d{4}-\d{2}-\d{2}|today|tomorrow|clear|none)$/i.test(String(value || '').trim());

// ---- what the command line says ----

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The reason a person is on today's list, in plain words, with the number of days. */
function reasonLine(reason, days) {
  const n = Math.max(0, Number(days) || 0);
  const ago = n === 0 ? 'today' : `${plural(n, 'day', 'days')} ago`;
  switch (reason) {
    case 'reply_waiting': return `Wrote back ${ago}. Answer them.`;
    case 'follow_up_overdue': return `Follow-up is ${plural(n, 'day', 'days')} overdue.`;
    case 'follow_up_due': return 'Follow-up is due today.';
    case 'no_follow_up_yet': return `Sent ${ago}, no follow-up yet.`;
    case 'met_then_quiet': return `Met ${ago}, nothing since.`;
    case 'gone_quiet': return `${plural(n, 'day', 'days')} since you talked. Check in.`;
    default: return n ? `Waiting ${plural(n, 'day', 'days')}.` : 'Waiting on you.';
  }
}

function placeName(place) {
  const parts = [place.city, place.region || place.country].filter(Boolean);
  return parts.join(', ');
}

/** Rows of cells as aligned text: the first column to the left, the rest to the right. */
function grid(rows, indent = '  ') {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => indent + r.map((cell, i) => (i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]))).join('  ').replace(/\s+$/, ''));
}

/** The war room numbers from GET /nexus/wall as a short aligned list. */
function wallLines(wall, now = new Date()) {
  const goal = wall.goal || null;
  const rows = [
    ['People', String(wall.people || 0), ''],
    ['Sent', String(wall.sent || 0), ''],
    ['Replied', String(wall.replied || 0), ''],
    ['Follow-ups due today', String(wall.follow_ups_due_today || 0), ''],
    ['Follow-ups overdue', String(wall.follow_ups_overdue || 0), ''],
    ['No follow-up yet', String(wall.no_follow_up_yet || 0), ''],
  ];
  const paid = Number(wall.paid_cents) || 0;
  let against = '';
  if (goal && goal.goal_cents) {
    const share = Math.floor((paid * 100) / goal.goal_cents);
    against = `of ${formatMoney(goal.goal_cents)} (${share}%)${goal.goal_date ? `, by ${model.shortDay(goal.goal_date, now)}` : ''}`;
  } else if (goal && goal.goal_date) {
    against = `by ${model.shortDay(goal.goal_date, now)}`;
  }
  rows.push(['Paid (checked only)', formatMoney(paid), against]);
  const lines = [`Wall, ${model.shortDay(wall.today, now) || 'today'}`];
  const labelWidth = Math.max(...rows.map((r) => r[0].length));
  const valueWidth = Math.max(...rows.map((r) => r[1].length));
  for (const [label, value, tail] of rows) lines.push(`  ${label.padEnd(labelWidth)}  ${value.padStart(valueWidth)}${tail ? `  ${tail}` : ''}`);
  const unchecked = Number(wall.unchecked_paid_cents) || 0;
  if (unchecked > 0) {
    lines.push('', `  Not counted: ${formatMoney(unchecked)} recorded but not checked. Only checked money counts.`);
  }
  // People marked Paying with no money on record: the wall would read $0 while the stages say otherwise.
  const paying = Number(wall.stages && wall.stages.paying) || 0;
  if (paying > 0 && paid === 0 && unchecked === 0) {
    lines.push('', `  ${plural(paying, 'person is', 'people are')} at Paying, but no money is recorded. Record it: atris nexus paid "<name>" <amount> --checked`);
  }
  const groups = (Array.isArray(wall.by_group) ? wall.by_group : []).slice(0, 5);
  if (groups.length) {
    lines.push('', 'Top groups');
    lines.push(...grid(groups.map((g) => [g.group_name, `${g.people} people`, `${g.sent} sent`, `${g.replied} replied`, `${g.paying} paying`, `${formatMoney(g.paid_cents)} paid`])));
  }
  const places = (Array.isArray(wall.by_place) ? wall.by_place : []).slice(0, 5);
  if (places.length) {
    lines.push('', 'Top cities');
    lines.push(...grid(places.map((p) => [placeName(p) || 'Unknown place', `${p.people} people`, `${p.sent} sent`, `${p.replied} replied`, `${p.paying} paying`])));
  }
  return lines;
}

/** The places whose name fits a query: "austin", "austin, texas" or "london, united kingdom". */
function cityMatches(places, query) {
  const want = String(query || '').trim().toLowerCase().replace(/\s*,\s*/g, ', ');
  if (!want) return [];
  const full = (p) => [p.city, p.region, p.country].filter(Boolean).join(', ').toLowerCase();
  const short = (p) => [p.city, p.region || p.country].filter(Boolean).join(', ').toLowerCase();
  const exact = places.filter((p) => String(p.city || '').toLowerCase() === want || short(p) === want || full(p) === want);
  if (exact.length) return exact;
  return places.filter((p) => full(p).startsWith(want));
}

/** One short sentence from a failed store answer. */
function plainError(result) {
  const detail = result && result.data && result.data.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.replace(/\s+/g, ' ').trim();
  if (Array.isArray(detail) && detail[0] && typeof detail[0].msg === 'string') return detail[0].msg.replace(/^Value error, /, '').replace(/\s+/g, ' ').trim();
  return `The people store answered ${result && result.status}.`;
}

module.exports = {
  MAX_IMPORT_PEOPLE,
  NOTE_MOST,
  stageFromWord,
  stageLabel,
  statusOf,
  cardToPerson,
  cardToList,
  filePeople,
  parseMoney,
  formatMoney,
  parseDay,
  looksLikeDay,
  localDay,
  plural,
  reasonLine,
  placeName,
  grid,
  wallLines,
  cityMatches,
  plainError,
};
