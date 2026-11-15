'use strict';

// The people list behind atris.ai/dashboard/nexus, worked out the same way the
// web page does it. Ported from atrisos-web app/dashboard/people/people-model.ts
// and people-list.ts. Pure: no network, no files, so it is tested on its own.
// Keep the two in step: a change to the scoring or the moves on the web lands here too.

// ---- the saved list (people-list.ts) ----

// Each person's map is one file in their own Atris folder. Only they can read it.
const PEOPLE_FILE = 'files/people.json';
const ROOM = 950000; // the folder takes text files up to 1 MB

const STATUSES = new Set(['prospect', 'sent', 'replied', 'met', 'proposal', 'paying', 'partner', 'silent', 'hold', 'lost', 'left']);
const clip = (value, most) => (typeof value === 'string' ? value.trim().slice(0, most) : '');
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** A new map: just the owner in the middle. */
function starter() {
  return { nodes: [{ t: 'p', n: 'You', me: 1, d: 0 }], edges: [], made: stamp() };
}

/** Read a saved map. Null when the text is not a map. */
function readList(text) {
  try {
    const list = JSON.parse(text);
    if (!list || !Array.isArray(list.nodes) || !Array.isArray(list.edges)) return null;
    // The page trusts these shapes. A file that breaks them is refused, not half shown.
    const size = list.nodes.length;
    const rows = (value) => value === undefined || (Array.isArray(value) && value.every((row) => typeof row === 'string' || (Array.isArray(row) && row.every((cell) => typeof cell === 'string'))));
    const goodNode = (n) => !!n && typeof n.n === 'string' && typeof n.t === 'string' && rows(n.act) && rows(n.links) && rows(n.proof) && rows(n.solo);
    const goodEdge = (e) => Array.isArray(e) && Number.isInteger(e[0]) && Number.isInteger(e[1]) && e[0] >= 0 && e[1] >= 0 && e[0] < size && e[1] < size && typeof e[2] === 'string';
    return list.nodes.every(goodNode) && list.edges.every(goodEdge) ? list : null;
  } catch {
    return null;
  }
}

/** Apply one change. Returns the new map, or a sentence saying why not. */
function applyChange(list, change) {
  const next = { ...list, nodes: list.nodes.map((n) => ({ ...n })), edges: [...list.edges], made: stamp() };
  const record = { do: change.do };

  if (change.do === 'add') {
    const name = clip(change.name, 80);
    if (!name) return 'A name is needed.';
    const twin = next.nodes.find((n) => n.t === 'p' && n.n.toLowerCase() === name.toLowerCase());
    if (twin) return `${twin.n} is already on your map.`;
    let me = next.nodes.findIndex((n) => n.me);
    if (me < 0) me = next.nodes.push({ t: 'p', n: 'You', me: 1, d: 0 }) - 1;
    const email = clip(change.email, 120);
    const note = clip(change.note, 300);
    const person = {
      t: 'p', n: name, d: 1, status: 'met', group: 'People you met', tags: 'met',
      cid: next.nodes.reduce((top, n) => Math.max(top, n.cid || 0), 0) + 1,
      title: clip(change.title, 300) || undefined, co: clip(change.company, 120) || undefined,
      city: clip(change.city, 60) || undefined, note: note || undefined,
      mail: email ? 1 : undefined, email: email || undefined,
    };
    const at = next.nodes.push(person) - 1;
    next.edges.push([me, at, 'knows']);
    Object.assign(record, { name, title: person.title, company: person.co, city: person.city, email: person.email, note: person.note });
  } else {
    const person = Number.isInteger(change.at) ? next.nodes[change.at] : undefined;
    if (!person || person.t !== 'p' || person.me || person.n !== change.who) return 'That person is not on your map.';
    Object.assign(record, { who: person.n });
    if (change.do === 'note') {
      const text = clip(change.text, 1000);
      if (!text) return 'The note is empty.';
      person.act = [[today(), 'Note', text], ...(person.act || [])].slice(0, 12);
      record.text = text;
    } else if (change.do === 'status') {
      if (typeof change.status !== 'string' || !STATUSES.has(change.status)) return 'That status is not one we know.';
      person.status = change.status;
      record.status = change.status;
    } else if (change.do === 'details') {
      for (const [field, key, most] of [['title', 'title', 300], ['company', 'co', 120], ['city', 'city', 60]]) {
        const value = clip(change[field], most);
        if (value) { person[key] = value; record[field] = value; }
      }
    } else {
      return 'That change is not one we know.';
    }
  }

  if (next.mine === 'mac') next.pending = [...(next.pending || []), record];
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > ROOM) return 'Your map is full. Remove some people before adding more.';
  return next;
}

// ---- what the page knows about each person (people-model.ts) ----

/** The conversation loop. Each stage is set by one status. */
const LOOP = [
  { word: 'Found', status: 'prospect' },
  { word: 'Reached out', status: 'sent' },
  { word: 'Replied', status: 'replied' },
  { word: 'Met', status: 'met' },
  { word: 'Paying', status: 'paying' },
  { word: 'Partner', status: 'partner' },
];

const STAGE_OF = { prospect: 0, sent: 1, replied: 2, met: 3, proposal: 3, paying: 4, partner: 5 };
const TALKING = new Set(['replied', 'paying', 'partner', 'hold', 'met', 'proposal']);
const GENERIC = new Set(['Check in and reinforce the win', 'Ask who else they know']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86400000;
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** "Nov 3" for a YYYY-MM-DD day, with the year when it is not this year. */
function shortDay(day, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day || '');
  if (!m) return '';
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return '';
  const year = Number(m[1]);
  return `${month} ${Number(m[3])}${year === now.getFullYear() ? '' : `, ${year}`}`;
}

/** Whole days since a YYYY-MM-DD day. No day on record counts as forever. */
function daysSince(day, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day || '');
  if (!m) return Infinity;
  const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((todayUtc - then) / DAY);
}

function closeness(d) {
  return d === 1 ? 'Direct' : d === 2 ? 'One intro' : '';
}

function actWhat(row) {
  return Array.isArray(row) ? String(row[1] ?? '') : '';
}

/** Where someone is in the loop. `off` means they stepped off it (quiet, on hold, lost, left). */
function loopOf(person, now = new Date()) {
  const status = person.status || 'prospect';
  if (has(STAGE_OF, status)) {
    const stage = STAGE_OF[status];
    return { stage, label: status === 'proposal' ? 'Proposal out' : LOOP[stage].word, off: false };
  }
  const off = {
    silent: person.last ? `Quiet since ${shortDay(person.last, now)}` : 'Quiet',
    hold: 'On hold',
    lost: 'Lost',
    left: 'Left',
  };
  if (!has(off, status)) return { stage: 0, label: LOOP[0].word, off: false };
  // Not a stage of its own: they stay at the furthest stage they reached.
  let stage = status === 'hold' ? 2 : status === 'silent' ? 1 : 0;
  for (const row of person.act || []) {
    const what = actWhat(row);
    if (/they replied/i.test(what)) stage = Math.max(stage, 2);
    else if (/email sent/i.test(what)) stage = Math.max(stage, 1);
  }
  return { stage, label: off[status], off: true };
}

/** The score (sort only) and the next move, the same way the people map works them out. */
function measure(person) {
  const x = person.x || {};
  const status = person.status || 'prospect';
  const d = person.d;
  const title = person.title || '';
  const knows = Number(x.knows) || 0;
  const via = typeof x.via === 'string' ? x.via : '';
  const shared = typeof x.shared === 'string' ? x.shared : '';
  let v = 0;
  let r = 0;
  let sp = !knows ? 0 : knows < 3 ? 1 : knows < 10 ? 2 : 3;
  if (status === 'paying' || status === 'partner' || x.deal || x.chk || x.fit === 'yes') v = 3;
  else if (x.fit === 'no') v = 0;
  else if (x.owner || x.fit === 'maybe' || person.kind === 'buyer' || /\b(owner|founder|ceo|president|principal|partner|director|head of|chief)\b/i.test(title)) v = 2;
  else if (title) v = 1;
  if (TALKING.has(status) || d === 1) r = 3;
  else if (d === 2 || person.warm) r = 2;
  if (person.mail && r < 3) r += 1;
  if (/\b(hosts|community)\b/.test(person.tags || '')) sp = Math.min(3, sp + 2);
  else if (person.kind === 'bridge') sp = Math.min(3, sp + 1);
  const move = status === 'lost' || status === 'left' ? 'Leave alone for now'
    : status === 'partner' ? 'Ask who else they know'
    : status === 'paying' ? 'Check in and reinforce the win'
    : status === 'replied' || status === 'hold' ? 'Answer them. They wrote back'
    : status === 'met' ? 'Follow up while it is fresh'
    : status === 'proposal' ? 'Close it. A proposal is out'
    : status === 'sent' ? 'Wait. The first note is out'
    : status === 'silent' ? (via ? `Ask ${via} for an intro` : 'Find a warmer way in')
    : d === 1 ? 'Message them yourself'
    : d === 2 ? (via ? `Ask ${via} for an intro` : `Open with ${shared || 'what you share'}`)
    : person.mail ? 'Go deeper, then write a first note'
    : 'Find a way to reach them';
  let score = Math.round(((3 * v + 2 * r + sp) / 18) * 100);
  if (status === 'silent') score = Math.round(score * 0.6);
  if (status === 'lost' || status === 'left' || x.fit === 'no') score = 0;
  return { score, move };
}

/** Work out every person on the map once. Grouping buckets (g 1) and the owner are left out. */
function buildPeople(list, now = new Date()) {
  const nodes = list.nodes;
  const adj = nodes.map(() => []);
  for (const [a, b] of list.edges) {
    if (adj[a]) adj[a].push(b);
    if (adj[b]) adj[b].push(a);
  }
  const rows = [];
  nodes.forEach((person, at) => {
    if (person.t !== 'p' || person.me) return;
    const x = person.x || {};
    const place = person.city ? undefined : adj[at].find((j) => nodes[j].t === 'l');
    const city = person.city || (place === undefined ? '' : nodes[place].n);
    const { score, move } = measure(person);
    const status = person.status || 'prospect';
    rows.push({
      at,
      name: person.n,
      title: person.title || '',
      company: person.co || '',
      city,
      status,
      d: person.d,
      via: typeof x.via === 'string' ? x.via : '',
      mail: !!person.mail,
      last: person.last || '',
      score,
      move,
      tableMove: GENERIC.has(move) ? '' : move,
      close: closeness(person.d),
      loop: loopOf(person, now),
      talking: TALKING.has(status),
      hidden: /^Stripe customer cus_/.test(person.n),
      hay: [person.n, person.co, city, status].join(' ').toLowerCase(),
    });
  });
  rows.sort((a, b) => b.score - a.score);
  return { list, rows, byAt: new Map(rows.map((row) => [row.at, row])), adj, me: nodes.findIndex((n) => n.me) };
}

/** The shortest way from you to someone, as node numbers. Null past three hops. */
function route(people, target) {
  const { me, adj, list } = people;
  if (me < 0 || target < 0 || target >= list.nodes.length) return null;
  const prev = new Map([[me, -1]]);
  const queue = [me];
  while (queue.length) {
    const at = queue.shift();
    if (at === target) break;
    for (const next of adj[at]) {
      if (prev.has(next) || list.nodes[next].g) continue;
      prev.set(next, at);
      queue.push(next);
    }
  }
  if (!prev.has(target)) return null;
  const path = [];
  for (let at = target; at !== -1; at = prev.get(at)) path.unshift(at);
  return path.length > 4 ? null : path;
}

/** The people and orgs someone is tied to. */
function ties(people, at) {
  const seen = new Set();
  const out = [];
  for (const j of people.adj[at] || []) {
    const node = people.list.nodes[j];
    if (seen.has(j) || node.g || node.me || (node.t !== 'p' && node.t !== 'o')) continue;
    seen.add(j);
    out.push({ at: j, name: node.n, person: node.t === 'p' });
  }
  return out;
}

const VIEWS = [
  { key: 'all', label: 'Everyone', test: () => true },
  { key: 'talk', label: 'Talking', test: (row) => row.talking },
  { key: 'warm', label: 'Warm', test: (row) => !row.talking && (row.d === 1 || row.d === 2) },
  { key: 'pay', label: 'Paying', test: (row) => row.status === 'paying' || row.status === 'partner' },
];

/** Rows for one view and search. Unnamed Stripe customers show only when searched for. */
function viewRows(rows, view, query) {
  const test = (VIEWS.find((v) => v.key === view) || VIEWS[0]).test;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows.filter((row) => !row.hidden && test(row));
  return rows.filter((row) => test(row) && words.every((word) => row.hay.includes(word)));
}

/** How many people each view holds, the way the table tabs count them. */
function viewCounts(rows) {
  const visible = rows.filter((row) => !row.hidden);
  return Object.fromEntries(VIEWS.map((v) => [v.key, visible.filter(v.test).length]));
}

/** Today: the few people waiting on you, at most five, one line each. */
function todayFeed(people, now = new Date()) {
  const rows = people.rows.filter((row) => !row.hidden);
  const statusByName = new Map();
  for (const node of people.list.nodes) if (node.t === 'p' && !node.me) statusByName.set(node.n.toLowerCase(), node.status || 'prospect');
  const oldestFirst = (a, b) => daysSince(b.last, now) - daysSince(a.last, now) || b.score - a.score;
  const helping = new Set(['replied', 'met', 'proposal', 'paying', 'partner']);

  const groups = [
    [rows.filter((row) => row.status === 'replied' || row.status === 'hold').sort(oldestFirst), () => 'Wrote back. Answer them.'],
    [
      rows.filter((row) => (row.status === 'met' || row.status === 'proposal') && daysSince(row.last, now) > 3).sort(oldestFirst),
      (row) => (row.status === 'proposal' ? 'Proposal out. Close it.' : 'Met you. Follow up while it is fresh.'),
    ],
    [
      rows.filter((row) => row.d === 2 && row.via && row.move === `Ask ${row.via} for an intro` && helping.has(statusByName.get(row.via.toLowerCase()) || '')),
      (row) => `One intro away, through ${row.via}.`,
    ],
    [
      rows.filter((row) => row.d === 1 && row.talking && daysSince(row.last, now) > 30).sort(oldestFirst),
      () => 'A month since you talked. Check in.',
    ],
  ];

  const items = [];
  const picked = new Set();
  const perVia = new Map();
  for (const [group, line] of groups) {
    for (const row of group) {
      if (items.length >= 5) return items;
      if (picked.has(row.at)) continue;
      const via = row.via.toLowerCase();
      if (via && (perVia.get(via) || 0) >= 2) continue;
      picked.add(row.at);
      if (via) perVia.set(via, (perVia.get(via) || 0) + 1);
      items.push({ at: row.at, name: row.name, line: line(row) });
    }
  }
  return items;
}

/** The way in for a one-intro person, as names: the shortest path, else through `via`. */
function wayIn(people, at) {
  const row = people.byAt.get(at);
  if (!row || row.d !== 2) return null;
  const found = route(people, at);
  const names = found && found.map((j) => (j === people.me ? 'You' : people.list.nodes[j].n));
  return names || (row.via ? ['You', row.via, row.name] : null);
}

/** Link hosts, the way the card shows them: http(s) only, no www, no repeats, at most five. */
function domains(urls) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push({ url, host });
  }
  return out.slice(0, 5);
}

module.exports = {
  PEOPLE_FILE,
  ROOM,
  STATUSES,
  LOOP,
  starter,
  readList,
  applyChange,
  shortDay,
  daysSince,
  closeness,
  loopOf,
  measure,
  buildPeople,
  route,
  ties,
  viewRows,
  viewCounts,
  todayFeed,
  wayIn,
  domains,
};
