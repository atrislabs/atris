'use strict';

// The one card contract between the desk on the Mac and the phone page.
//
// The desk serves exactly one card at a time:
//   { id, kind, title, body, options: [{ id, label, action, binds }], input, job, table }
// with a few more fields the page reads the same way for every kind:
//   option.style    primary | choice | option | quiet: how big the button is
//   option.confirm  the label a first tap turns the button into; the second tap sends
//   option.type     { placeholder, max }: the button turns into a typing box
//   option.detail   one plain line under the label
//   option.chosen   this one is picked already (a swap's scope, the model in use)
//   option.cell     { row, column }: drawn inside that table cell, not in the list
//   option.group    a few words that head a line of quiet options sharing them
//   input           { label, placeholder, action, max, kind }: the quiet line that opens into a box
//   thread          the turns so far, on a reply
//   line            one plain line under the body (who has it, what came of a word)
//   count, label    a deck card's place in the deck and its status
//   watch           the page looks again for the next idea while this shows
//   progress        on the waiting card: [{ at, line }], the plain lines of the
//                   drafting so far, newest last (at is ms since 1970)
//   started_at      on the waiting card: when that drafting began (ms since 1970)
//   waited_ms       on the waiting card: how long ago that was, read on the Mac
//
// A reply is a new card with a new id; nothing is ever patched in place.
// A card's id carries a hash of its words and options (stamp), so options
// that change, or mean something else, always come under a new id.
// Every action names the card it acts on and one option on it, or typed
// words for its input; the desk refuses anything else (lib/gm-bet.js act).
//
// The invariants live here, in cardProblems, and the desk checks every card
// before it serves it (enforce). Each option the desk builds says what it
// answers (answers: the card's asks) or that it only moves around (nav), so
// a card can never show an option that answers some other words.

const crypto = require('node:crypto');
const hash8 = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 8);

const KINDS = new Set(['idea', 'question', 'report', 'choice', 'yes', 'done', 'wait', 'missed', 'reply', 'started', 'team', 'member', 'deck', 'swap']);
const STYLES = new Set(['primary', 'choice', 'option', 'quiet']);
const SAY = { label: 'or say something', placeholder: 'say something', action: 'say', max: 280 };

// Words a person reads: no code spans, flags, paths, file names, or commands.
// A tool's name inside a sentence can be the product ("a page for atris gm
// phone"); a command is one the words tell someone to run, or start with.
const CODE = [
  /`/,
  /(^|\s)[\w.~-]*\/[\w./-]+/,
  /\b[\w-]+\.(js|ts|tsx|sh|md|json|py|yml|yaml|txt|html|css|jsonl)\b/i,
  /(^|\s)--?[a-z]/i,
  /(^|\b(run|ran|running|type|typed)\s+)(npm|npx|git|node|gh|atris)\s+(install|run|publish|test|view|push|commit|merge|tag|log|pr|task|mission|gm|slop|release|init)\b/i,
];
const isPlain = text => !CODE.some(re => re.test(String(text || '')));

// The same words with the code taken out, for a line that slipped through.
function plainWords(text) {
  const t = String(text || '');
  if (isPlain(t)) return t;
  return t.replace(/`[^`]*`/g, ' ')
    .split(/\s+/)
    .filter(w => w && !/^--?[a-z]/i.test(w))
    .map(w => (/\/|\.(js|ts|tsx|sh|md|json|py|yml|yaml|txt|html|css|jsonl)\b/i.test(w) ? 'a file' : w))
    .join(' ')
    .replace(/\b(npm|npx|git|node|gh|atris)\s+[a-z-]+\b/gi, 'a command')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- building options ---------------------------------------------------------------

// an option that answers the card's own words
const answer = (asks, o) => ({ style: 'quiet', ...o, answers: asks });
// an option that only moves around: back, the deck's next, more models
const nav = o => ({ style: 'quiet', ...o, nav: true });

const sayInput = (over = {}) => ({ ...SAY, ...over });

// concern: no draft passed every check in time, so this is the best one, with
// the second look's worry as its line, and the owner goes with it, has it
// sharpened, or asks for something else
function idea({ id, title, body, line = null, unstarted = null, concern = null }) {
  if (concern) {
    return {
      id, kind: 'idea', asks: id, title, body,
      line: concern,
      options: [
        answer(id, { id: 'do', label: 'go with it', action: 'do', style: 'primary', confirm: 'tap again to start' }),
        answer(id, { id: 'sharper', label: 'sharpen it', action: 'sharper' }),
        answer(id, { id: 'other', label: 'something else', action: 'next' }),
      ],
      input: sayInput(),
    };
  }
  return {
    id, kind: 'idea', asks: id, title, body,
    line: line || unstarted || null,
    options: [
      answer(id, { id: 'do', label: 'do it', action: 'do', style: 'primary', confirm: 'tap again to start' }),
      answer(id, { id: 'sharper', label: 'sharper idea', action: 'sharper' }),
      answer(id, { id: 'skip', label: 'not now', action: 'skip' }),
    ],
    input: sayInput(),
  };
}

// a started idea: who has it; the next card comes on the next tap
function started({ id, title, body, line }) {
  return { id, kind: 'started', asks: id, title, body, line, options: [nav({ id: 'next', label: 'next', action: 'next' })], input: null };
}

// choices: [{ id, label, other }]; an other choice turns into a box
function question({ id, title, body = null, choices }) {
  const other = choices.some(c => c.other);
  return {
    id, kind: 'question', asks: id, title, body,
    options: choices.map(c => answer(id, c.other
      ? { id: c.id, label: c.label, action: 'say', style: 'choice', type: { placeholder: c.label, max: 60 } }
      : { id: c.id, label: c.label, action: 'answer', style: 'choice', binds: { choice: c.id } })),
    // its own something else box is the one place to type
    input: other ? null : sayInput(),
  };
}

function report({ id, title, body }) {
  return {
    id, kind: 'report', asks: id, title, body,
    options: [answer(id, { id: 'later', label: 'not now', action: 'later' })],
    input: { label: 'type this week\'s number', placeholder: 'this week\'s number', action: 'report', max: 40 },
  };
}

// items: [{ id, title, why }]
function choice({ id, items }) {
  return {
    id, kind: 'choice', asks: id, title: 'which one next?', body: null,
    options: items.map(i => answer(id, { id: i.id, label: i.title, detail: i.why, action: 'pick', style: 'option', binds: { bet: i.id } })),
    input: sayInput(),
  };
}

// The yes and the no bind the one request the card shows: its job and its
// command's hash (a plain ask has no hash, only its place in the asks).
function yes({ id, title, body, request, job = null, line = null }) {
  const binds = { job: request.job, key: request.key, hash: request.hash || null };
  return {
    id, kind: 'yes', asks: id, title, body, job, line, request,
    options: [
      answer(id, { id: 'yes', label: 'yes', action: 'yes', style: 'primary', confirm: 'tap again to say yes', binds }),
      answer(id, { id: 'no', label: 'no', action: 'no', binds }),
      answer(id, { id: 'later', label: 'not now', action: 'later', binds }),
    ],
    input: sayInput(),
  };
}

function done({ id, title, body, job = null }) {
  return { id, kind: 'done', asks: id, title, body, job, options: [answer(id, { id: 'nice', label: 'nice', action: 'nice', style: 'primary' })], input: sayInput() };
}

// progress, started_at, waited_ms: how the page shows the drafting is alive;
// none of them is in the stamp, so the card keeps its id while they change
function wait({ id, progress = [], started_at = null, waited_ms = null }) {
  return { id, kind: 'wait', asks: id, title: 'writing your next idea.', body: null, options: [], input: sayInput(), watch: true, progress, started_at, waited_ms };
}

// the wait ended with nothing usable: a way to try again, and the box
function missed({ id }) {
  return {
    id, kind: 'missed', asks: id, title: 'no idea came together this time.', body: 'try again, or say what you want one about.',
    options: [answer(id, { id: 'again', label: 'try again', action: 'next', style: 'primary' })],
    input: sayInput(),
  };
}

// A reply to words said on a card. When it asks its own question (it ends
// in a question mark) only its answers show, with the box and a quiet way
// back to the first question. When it only explains, the first card's own
// options show once, and any answer it adds to them after. A member that
// is not running takes a second tap to start, or the words are kept as a note.
// base: the card the words were said on.
function reply({ id, base, text, thread = [], suggestions = [], confirm = null }) {
  const own = Boolean(confirm) || /\?\s*$/.test(String(text || ''));
  const card = { id, kind: 'reply', title: text, body: null, thread, job: base.job || null, base: base.id, table: null };
  if (confirm) {
    return {
      ...card, asks: id,
      options: [
        answer(id, { id: 'start', label: 'start it', action: 'start', style: 'choice', binds: { text: confirm.text } }),
        answer(id, { id: 'note', label: 'keep it as a note instead', action: 'note', style: 'choice', binds: { text: confirm.text } }),
        nav({ id: 'back', label: 'back', action: 'back' }),
      ],
      input: base.input || null,
    };
  }
  if (own) {
    return {
      ...card, asks: id,
      options: [
        ...suggestions.map((s, i) => answer(id, { id: `r${i + 1}`, label: s, action: 'say', style: 'choice', binds: { text: s } })),
        nav({ id: 'back', label: base.kind === 'deck' ? 'back to the job' : base.kind === 'member' ? `back to ${base.title}` : 'back to the first question', action: 'back' }),
      ],
      input: base.input || sayInput(),
    };
  }
  // it explains the card it was said on: that card's options, once, any
  // answer the reply adds to them, and its box; its way back returns to that card
  const backTo = base.kind === 'deck' ? 'back to the job' : base.kind === 'member' ? `back to ${base.title}` : 'back';
  const kept = base.options.filter(o => !o.nav || o.action === 'back').map(o => (o.action === 'back' ? { ...o, label: backTo } : o));
  const have = new Set(kept.map(o => String(o.label).trim().toLowerCase()));
  const added = suggestions.filter(s => !have.has(String(s).trim().toLowerCase()))
    .map((s, i) => answer(base.asks, { id: `r${i + 1}`, label: s, action: 'say', style: 'choice', binds: { text: s } }));
  // the answers it adds sit with the card's own answers, before its quiet links
  const firstQuiet = kept.findIndex(o => !o.style || o.style === 'quiet');
  const options = firstQuiet < 0 ? [...kept, ...added] : [...kept.slice(0, firstQuiet), ...added, ...kept.slice(firstQuiet)];
  return {
    ...card, asks: base.asks,
    options: options.length ? options : [nav({ id: 'back', label: 'back', action: 'back' })],
    input: base.input || (base.options.some(o => o.type) ? null : sayInput()),
    request: base.request,
  };
}

// ---- the team, a member, the job deck, and the swap card -----------------------------

const TEAM_COLUMNS = ['member', 'role', 'ovr', 'engine', 'status'];

// rows: the team table's rows. A tap on a member opens their talk card; a
// tap on their engine opens the swap card (a person has no engine to swap).
function team({ id, rows, line = null, deck = false }) {
  const options = [];
  rows.forEach((r, i) => {
    options.push(nav({ id: `talk:${r.member}`, label: r.member, action: 'member', binds: { member: r.member }, cell: { row: i, column: 'member' } }));
    if (r.engine !== 'person') options.push(nav({ id: `swap:${r.member}`, label: r.engine, action: 'swap', binds: { member: r.member }, cell: { row: i, column: 'engine' } }));
  });
  if (deck) options.push(nav({ id: 'deck', label: 'the jobs, one at a time', action: 'deck' }));
  options.push(nav({ id: 'back', label: 'close', action: 'back' }));
  return {
    id, kind: 'team', asks: id, title: 'the team', body: rows.length ? 'tap a name to talk to them, or what they run on to change it.' : 'nobody is on the team yet.', line,
    table: rows.length ? { columns: TEAM_COLUMNS, rows: rows.map(r => [r.member, r.role, r.ovr, r.engine, r.sentence]), status: rows.map(r => r.status) } : null,
    options, input: null,
  };
}

function member({ id, name, sentence: said, job = null, line = null }) {
  return {
    id, kind: 'member', asks: id, title: name, body: said, job, line,
    options: [nav({ id: 'back', label: 'back to the team', action: 'back' })],
    input: { ...SAY, label: `tell ${name} something`, placeholder: `tell ${name} something`, action: 'talk' },
    member: name,
  };
}

// what a job in the deck is doing, when there is no yes on it to answer
function deckLine(card) {
  const when = card.time ? `, ${card.time}` : '';
  if (card.label === 'working') return `${card.member} is working on it${when}. nothing needs you here.`;
  if (card.label === 'you answered') return `you answered this, so it is back with ${card.member}.`;
  return `${card.member} has not started it yet${when}.`;
}

// one running job: its place in the deck, the yes it waits on, its table
// row, and a box to talk to its member
function deck({ id, at, total, card, columns, job = null }) {
  const options = [];
  if (card.yes) {
    const binds = { job: card.mission_id, key: card.yes.key, hash: card.yes.hash || null };
    options.push(answer(id, { id: 'yes', label: 'yes', action: 'yes', style: 'primary', confirm: 'tap again to say yes', binds }));
    options.push(answer(id, { id: 'no', label: 'no', action: 'no', binds }));
    options.push(answer(id, { id: 'later', label: 'not now', action: 'later', binds }));
  }
  if (total > 1) options.push(nav({ id: 'prev', label: 'previous', action: 'flip', binds: { step: -1 } }));
  options.push(nav({ id: 'back', label: 'the whole team', action: 'back' }));
  if (total > 1) options.push(nav({ id: 'next', label: 'next', action: 'flip', binds: { step: 1 } }));
  return {
    id, kind: 'deck', asks: id,
    title: card.yes ? card.yes.what : card.rows[0].work,
    body: card.yes ? card.yes.why : deckLine(card),
    line: card.said || null,
    count: `${at + 1} of ${total}`,
    label: card.label,
    time: card.time || null,
    job,
    table: { columns, rows: card.rows.map(r => columns.map(k => r[k] || '')) },
    options,
    input: { ...SAY, label: `talk to ${card.member}`, placeholder: `talk to ${card.member}`, action: 'talk' },
    member: card.member,
    request: card.yes ? { job: card.mission_id, key: card.yes.key, hash: card.yes.hash || null } : null,
    deck_job: card.job_id,
  };
}

// The swap card renders the swap list as it comes: Atris models, then the
// owner's picks, then "more models", which turns this card's options into
// the full list. A list with no picks opens short too: the model in use and
// the next two, then more models, when that hides at least two. Without the
// list, every model by tool.
const SHORT_LIST = 3;
function swapChoices(choices, all = false) {
  const flat = Array.isArray(choices.options)
    ? choices.options
    : (choices.groups || []).flatMap(g => g.models.map(m => ({ ...m, tool: g.tool })));
  let more = flat.find(o => o.more) || null;
  let list = flat.filter(o => !o.more);
  if (!more && list.length > SHORT_LIST + 1) {
    more = { more: true, label: 'more models', options: list };
    list = [...list.filter(o => o.current), ...list.filter(o => !o.current)].slice(0, SHORT_LIST);
  }
  if (all && more) return { list: more.options || [], more: null };
  return { list, more };
}

// The models first, each its own option id from the model it picks, so no
// id ever points at another model; then more models, then who a swap is for.
function swap({ id, name, choices, scope = 'member', all = false, line = null }) {
  const { list, more } = swapChoices(choices, all);
  const options = list.map((m) => {
    const detail = m.current ? 'now' : [m.tool, m.record].filter(Boolean).join(', ') || null;
    return answer(id, { id: `m-${hash8([m.engine, m.model, m.label])}`, label: m.label, detail, action: m.current ? 'none' : 'swap_to', style: 'choice', chosen: Boolean(m.current), binds: { engine: m.engine, model: m.model, scope } });
  });
  if (more) options.push(nav({ id: 'more', label: more.label || 'more models', action: 'more' }));
  if ((choices.scopes || []).length > 1) {
    const words = sc => (sc.id === 'member' ? `only ${name}` : `everyone doing ${name}'s kind of work`);
    for (const sc of choices.scopes) options.push(answer(id, { id: `scope:${sc.id}`, label: words(sc), action: 'scope', binds: { scope: sc.id }, chosen: sc.id === scope, group: 'who it is for' }));
  }
  options.push(nav({ id: 'back', label: 'back to the team', action: 'back' }));
  const how = (choices.scopes || []).length > 1 ? `tap a model to switch ${name} to it. it changes only ${name}, unless you pick everyone below first.` : `tap a model to switch ${name} to it.`;
  return { id, kind: 'swap', asks: id, title: name, body: [choices.line, how].filter(Boolean).join(' '), line, options, input: null, member: name, scope, all };
}

// ---- the invariants ---------------------------------------------------------------

// Everything wrong with one card, in plain words; [] when it is whole.
function cardProblems(card) {
  const out = [];
  if (!card || typeof card !== 'object') return ['there is no card'];
  if (!card.id || typeof card.id !== 'string') out.push('it has no id');
  if (!KINDS.has(card.kind)) out.push(`kind ${card.kind} is not a card kind`);
  if (!String(card.title || '').trim()) out.push('it has no title');
  const options = Array.isArray(card.options) ? card.options : [];
  if (!Array.isArray(card.options)) out.push('it has no option list');
  if (!options.length && !card.input) out.push('it has no way forward: no option and no box');
  const ids = new Set();
  for (const o of options) {
    if (!o.id || ids.has(o.id)) out.push(`option ${o.id || '(no id)'} has no id of its own`);
    ids.add(o.id);
    if (!String(o.label || '').trim()) out.push(`option ${o.id} has no label`);
    if (!o.action) out.push(`option ${o.id} does nothing`);
    if (o.style && !STYLES.has(o.style)) out.push(`option ${o.id} has style ${o.style}`);
    // the options shown answer the words shown
    if (!o.nav && o.answers !== card.asks) out.push(`option ${o.id} (${o.label}) answers other words than the card shows`);
  }
  // no raw commands, flags, or paths anywhere a person reads
  const read = [['title', card.title], ['body', card.body], ['line', card.line], ...options.flatMap(o => [[`option ${o.id}`, o.label], [`option ${o.id} detail`, o.detail], [`option ${o.id} group`, o.group]])];
  if (card.input) read.push(['box', card.input.label], ['box', card.input.placeholder]);
  if (card.table) for (const row of card.table.rows) for (const cell of row) read.push(['table', cell]);
  for (const p of Array.isArray(card.progress) ? card.progress : []) read.push(['progress', p && p.line]);
  for (const [where, text] of read) if (text && !isPlain(text)) out.push(`the ${where} has a command, flag, or path in it: ${String(text).slice(0, 80)}`);
  // a yes card says yes, no, and not now, and each binds the request it shows
  const asksYes = card.kind === 'yes' || (card.kind === 'deck' && card.request) || (card.kind === 'reply' && card.request && options.some(o => o.action === 'yes'));
  if (asksYes) {
    for (const want of ['yes', 'no', 'later']) if (!options.some(o => o.id === want)) out.push(`a yes card has no ${want === 'later' ? 'not now' : want}`);
    const r = card.request || {};
    for (const o of options.filter(x => x.action === 'yes' || x.action === 'no')) {
      const b = o.binds || {};
      if (!r.job || b.job !== r.job || b.key !== r.key || (b.hash || null) !== (r.hash || null)) out.push(`option ${o.id} does not bind the request on the card`);
    }
  }
  return out;
}

// Over a run of cards as they were served: never two yes cards in a row.
function sequenceProblems(cards) {
  const out = [];
  cards.forEach((c, i) => { if (i && c && cards[i - 1] && c.kind === 'yes' && cards[i - 1].kind === 'yes') out.push(`cards ${i} and ${i + 1} are both yes cards`); });
  return out;
}

// Words the owner reads say what a thing is, not where a number comes from:
// "300 more npm installs" reads "300 more installs".
const ownerText = t => (typeof t === 'string' ? t.replace(/\bnpm (installs?|downloads?)\b/gi, '$1') : t);
function ownerWords(card) {
  const out = { ...card, title: ownerText(card.title), body: ownerText(card.body), line: ownerText(card.line) };
  out.options = (card.options || []).map(o => ({ ...o, label: ownerText(o.label), ...(o.detail ? { detail: ownerText(o.detail) } : {}) }));
  if (card.table) out.table = { ...card.table, rows: card.table.rows.map(row => row.map(ownerText)) };
  return out;
}

// The card as it is served, in the owner's words. A card with a problem is
// made safe and the problem is said: code is taken out of the words, an
// option that answers other words is dropped, and a card with no way
// forward gets a next.
function enforce(raw, report = () => {}) {
  const card = ownerWords(raw);
  const problems = cardProblems(card);
  if (!problems.length) return card;
  report(problems);
  const fixed = { ...card, title: plainWords(card.title) || 'next', body: card.body && plainWords(card.body), line: card.line && plainWords(card.line) };
  fixed.options = (card.options || []).filter(o => o.nav || o.answers === card.asks).map(o => ({ ...o, label: plainWords(o.label), ...(o.detail ? { detail: plainWords(o.detail) } : {}) }));
  if (fixed.table) fixed.table = { ...fixed.table, rows: fixed.table.rows.map(row => row.map(plainWords)) };
  if (Array.isArray(fixed.progress)) fixed.progress = fixed.progress.map(p => ({ ...p, line: plainWords(p && p.line) }));
  if (!fixed.options.length && !fixed.input) fixed.options = [nav({ id: 'next', label: 'next', action: 'next' })];
  return fixed;
}

// What goes over the wire: the contract fields, without what the desk keeps
// to check and act on (asks, answers, nav, request, binds of its own).
const OPTION_WIRE = ['id', 'label', 'action', 'binds', 'style', 'confirm', 'type', 'detail', 'chosen', 'cell', 'group'];
function wire(card) {
  if (!card) return null;
  const out = {
    id: card.id,
    kind: card.kind,
    title: card.title,
    body: card.body || null,
    options: (card.options || []).map((o) => {
      const w = {};
      for (const k of OPTION_WIRE) if (o[k] !== undefined && o[k] !== null && o[k] !== false) w[k] = o[k];
      return w;
    }),
    input: card.input || null,
    job: card.job || null,
    table: card.table || null,
  };
  for (const k of ['thread', 'line', 'count', 'label', 'time', 'watch']) if (card[k] !== undefined && card[k] !== null && !(Array.isArray(card[k]) && !card[k].length)) out[k] = card[k];
  // the waiting card always says how far along it is, even before the first line
  if (card.kind === 'wait') {
    out.progress = Array.isArray(card.progress) ? card.progress.map(p => ({ at: p.at, line: p.line })) : [];
    if (Number.isFinite(card.started_at)) out.started_at = card.started_at;
    if (Number.isFinite(card.waited_ms)) out.waited_ms = card.waited_ms;
  }
  return out;
}

// The id a card is served under: its own id and a hash of its words and
// every option with what it binds, so new options always mean a new id.
function stamp(card) {
  if (!card) return card;
  const offer = {
    title: card.title,
    options: (card.options || []).map(o => [o.id, o.label, o.action, o.binds || null, o.confirm || null, o.type || null, Boolean(o.chosen)]),
    input: card.input ? [card.input.action, card.input.label] : null,
    request: card.request || null,
  };
  return { ...card, id: `${card.id}#${hash8(offer)}` };
}

module.exports = {
  stamp,
  KINDS,
  TEAM_COLUMNS,
  cardProblems,
  sequenceProblems,
  enforce,
  wire,
  idea,
  started,
  question,
  report,
  choice,
  yes,
  done,
  wait,
  missed,
  reply,
  team,
  member,
  deck,
  swap,
};
