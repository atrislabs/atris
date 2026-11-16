'use strict';

// The network tools of atris nexus (groups, network, saved lists) in the shapes the command
// line prints: backend routers/nexus_router.py, GET /nexus/groups, POST /nexus/groups/open,
// GET /nexus/network and the saved-list routes. Pure: no network, no files.
// Labels, list names and people's names are only ever matched here, in memory. They travel
// in a request body and never in a web address.

const model = require('./nexus-model');
const S = require('./nexus-store');

// The order the backend answers in.
const KINDS = ['saved', 'list', 'company', 'city', 'school', 'cluster'];
const HEADING = { saved: 'Saved lists', list: 'Lists', company: 'Companies', city: 'Cities', school: 'Schools', cluster: 'Clusters' };
const NOUN = { saved: 'saved list', list: 'list', company: 'company', city: 'city', school: 'school', cluster: 'cluster' };
// A group's key is its label, lower-cased with the spaces collapsed, for these kinds.
const LABEL_KEYED = new Set(['list', 'company', 'city', 'school']);
const GROUP_SHOWN = 50; // the most groups the backend lists for one kind
const NAME_MOST = 80;
const SAVE_MOST = 5000;
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const squash = (value) => String(value === undefined || value === null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
const plural = S.plural;

/** The key a label gives, for the kinds whose key is the label. */
function keyOf(label) {
  return squash(label);
}

/** A group, a saved list or a person row as the few fields the command line passes around. */
function groupRef(kind, group) {
  return { kind, key: String(group.key), label: String(group.label === undefined ? group.key : group.label), count: Number(group.count) || 0 };
}

/**
 * One group among the ones the backend listed: the exact key first, then the label in any
 * case. { group } for one, { matches } for several, {} for none.
 */
function matchGroup(groups, word) {
  const raw = String(word || '').trim();
  const exact = groups.filter((g) => String(g.key) === raw);
  if (exact.length === 1) return { group: exact[0] };
  const want = squash(raw);
  const close = groups.filter((g) => squash(g.label) === want);
  if (close.length === 1) return { group: close[0] };
  const some = exact.length > 1 ? exact : close;
  return some.length ? { matches: some } : {};
}

/** One saved list by name: the exact name first, then any case. */
function matchList(lists, word) {
  const raw = String(word || '').trim();
  const exact = lists.filter((l) => String(l.name) === raw);
  if (exact.length === 1) return { list: exact[0] };
  const want = squash(raw);
  const close = lists.filter((l) => squash(l.name) === want);
  if (close.length === 1) return { list: close[0] };
  const some = exact.length > 1 ? exact : close;
  return some.length ? { matches: some } : {};
}

/** A list name: 1 to 80 characters once trimmed. { name } or { error }. */
function listName(value) {
  const name = String(value === undefined || value === null ? '' : value).trim();
  if (!name) return { error: 'A list needs a name.' };
  if (name.length > NAME_MOST) return { error: `A list name is at most ${NAME_MOST} characters.` };
  return { name };
}

/** Person ids from words: split on commas and spaces, checked, no repeats. { ids } or { error }. */
function parseIds(values, most = SAVE_MOST) {
  const seen = new Set();
  const ids = [];
  for (const piece of values.flatMap((value) => String(value).split(/[\r\n,]+/)).map((one) => one.trim()).filter(Boolean)) {
    if (!ID_SHAPE.test(piece)) return { error: `"${piece}" is not a person id. An id looks like 11111111-1111-4111-8111-111111111111.` };
    const id = piece.toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (!ids.length) return { error: 'No person ids were given.' };
  if (ids.length > most) return { error: `A list holds at most ${most} people. ${ids.length} were given.` };
  return { ids };
}

const stageWord = (stage) => {
  if (!stage) return '';
  const known = S.stageFromWord(stage);
  return known ? S.stageLabel(known) : String(stage);
};

const closeWord = (closeness) => (closeness === 1 ? 'direct' : closeness === 2 ? 'one intro' : '');

/** "Founder at Sample Co", or whichever half there is. */
function roleLine(person) {
  const title = text(person.title);
  const company = text(person.company);
  if (title && company) return `${title} at ${company}`;
  return title || company;
}

/** GET /nexus/groups as a plain heading per kind, a label and a count on each line. */
function groupsLines(kinds, only = '') {
  const lines = [];
  let capped = false;
  for (const kind of KINDS) {
    if (only && kind !== only) continue;
    const entry = kinds.find((k) => k && k.kind === kind);
    const groups = entry && Array.isArray(entry.groups) ? entry.groups : [];
    if (!groups.length) continue;
    if (groups.length >= GROUP_SHOWN) capped = true;
    if (lines.length) lines.push('');
    lines.push(HEADING[kind]);
    lines.push(...S.grid(groups.map((g) => [String(g.label === undefined ? g.key : g.label), String(Number(g.count) || 0)])));
  }
  if (capped) lines.push('', `Each heading shows its biggest ${GROUP_SHOWN}. To open a smaller one: atris nexus group <kind> "<label>"`);
  return lines;
}

/** One opened group: the count, who is most connected, your way in, who is talking, what they share, then the people. */
function groupLines(open, now = new Date()) {
  const group = open.group || {};
  const people = Array.isArray(open.people) ? open.people : [];
  const count = Number(group.count) || people.length;
  const lines = [`${group.label === undefined ? '' : group.label} (${NOUN[group.kind] || group.kind}): ${plural(count, 'person', 'people')}`];

  const most = open.most_connected;
  lines.push(`Most connected: ${most && most.name ? `${most.name}, knows ${most.knows}` : 'no ties yet'}`);

  const way = open.way_in;
  if (way && way.name) {
    const bits = [closeWord(way.closeness), text(way.last_touch_at) ? `last talked ${model.shortDay(way.last_touch_at.slice(0, 10), now)}` : ''].filter(Boolean);
    lines.push(`Your way in: ${way.name}${bits.length ? ` (${bits.join(', ')})` : ''}`);
  } else {
    lines.push('Your way in: no one yet');
  }

  lines.push(`Talking: ${Number(open.talking) || 0}`);
  const common = (Array.isArray(open.in_common) ? open.in_common : []).filter((c) => c && c.label);
  lines.push(`In common: ${common.length ? common.map((c) => `${c.label} ${Number(c.count) || 0}`).join(', ') : 'nothing yet'}`);

  if (people.length) {
    const rows = people.map((p) => [String(p.name || 'Unnamed'), roleLine(p), stageWord(p.stage), `knows ${Number(p.knows) || 0}`]);
    const wide = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
    lines.push('');
    for (const r of rows) lines.push(`  ${r.map((cell, i) => (i < 3 ? cell.padEnd(wide[i]) : cell)).join('  ')}`.replace(/\s+$/, ''));
  }
  return lines;
}

/** GET /nexus/network: the numbers, then clusters, most connected and bridges. */
function networkLines(net) {
  const people = Number(net.people) || 0;
  if (!people) return ['No one is on your list yet.'];
  const rows = [['People', people], ['Linked people', Number(net.linked_people) || 0], ['Links', Number(net.links) || 0]];
  const labelWidth = Math.max(...rows.map((r) => r[0].length));
  const valueWidth = Math.max(...rows.map((r) => String(r[1]).length));
  const lines = ['Your network', ...rows.map(([label, value]) => `  ${label.padEnd(labelWidth)}  ${String(value).padStart(valueWidth)}`)];
  const section = (title, items, cells) => {
    if (!items.length) return;
    lines.push('', title, ...S.grid(items.map(cells)));
  };
  const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []);
  section('Clusters', list(net.clusters), (c) => [String(c.label === undefined ? c.key : c.label), plural(Number(c.count) || 0, 'person', 'people')]);
  section('Most connected', list(net.most_connected), (p) => [String(p.name || 'Unnamed'), `knows ${Number(p.knows) || 0}`]);
  section('Bridges (without them the network splits)', list(net.bridges), (p) => [String(p.name || 'Unnamed'), `joins ${plural(Number(p.joins) || 0, 'part', 'parts')}`]);
  if (!Number(net.links)) lines.push('', 'No ties yet, so there are no clusters or bridges to find.');
  return lines;
}

/** GET /nexus/lists as one line per saved list. */
function listsLines(lists) {
  if (!lists.length) return ['No saved lists yet. Make one: atris nexus save "<name>" --from company "<label>"'];
  const lines = [`${plural(lists.length, 'saved list', 'saved lists')}.`];
  const rows = lists.map((l) => [String(l.name), plural(Number(l.count) || 0, 'person', 'people')]);
  const wide = Math.max(...rows.map((r) => r[0].length));
  const num = Math.max(...rows.map((r) => r[1].length));
  rows.forEach((r, i) => {
    const helper = lists[i].made_by === 'helper' ? '  made by a helper' : '';
    lines.push(`  ${r[0].padEnd(wide)}  ${r[1].padStart(num)}${helper}`);
  });
  return lines;
}

module.exports = {
  KINDS,
  NOUN,
  HEADING,
  LABEL_KEYED,
  NAME_MOST,
  SAVE_MOST,
  ID_SHAPE,
  keyOf,
  squash,
  groupRef,
  matchGroup,
  matchList,
  listName,
  parseIds,
  stageWord,
  roleLine,
  groupsLines,
  groupLines,
  networkLines,
  listsLines,
};
