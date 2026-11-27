'use strict';

// The feed as a shared room: the team's light notes (a post, or an ask that
// anyone may answer) and reactions and replies on any card. A note is not
// work, so it is not a task. Notes are lines in .atris/state/feed/posts.jsonl
// and the talk around cards is one small file, social.json, both next to the
// feed's events. Every write happens under one lock and lands whole. No
// model, no network.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function core() {
  return require('./feed-core');
}

function team() {
  return require('./feed-team');
}

const EMOJI = ['👍', '❤️', '😂', '🔥', '👀'];
// Names a terminal can type, for the same five.
const EMOJI_NAMES = {
  'thumbs-up': '👍', thumbsup: '👍', like: '👍', '+1': '👍', yes: '👍',
  heart: '❤️', love: '❤️', laugh: '😂', funny: '😂', joy: '😂', fire: '🔥', eyes: '👀', looking: '👀',
};
const NOTE_PREFIX = 'post:';
const NOTE_KINDS = ['post', 'ask'];
const NOTE_MAX = 280;
// The person's own post holds as much as a comment; a member's note stays short.
const OWNER_NOTE_MAX = 1000;
const NOTES_READ = 200;
const NOTES_ON_DISK = 400; // past this the file is cut back to the newest NOTES_READ
const COPY_WINDOW = 40;
// A comment on a card, from a person or a member alike. Only the newest
// REPLIES_SHOWN ride on a card; `atris feed replies <card>` reads them all.
const REPLY_MAX = 1000;
const REPLIES_KEEP = 50;
const REPLIES_SHOWN = 3;
const REPLIES_READ_MAX = 500;
const SOCIAL_CARDS_MAX = 500;
const OWNER_NAME = 'the owner';

function stateFile(root, name) {
  return path.join(root, '.atris', 'state', 'feed', name);
}

function notesFile(root) {
  return stateFile(root, 'posts.jsonl');
}

// Clearing hides older task cards in the feed without deleting the tasks.
function clearedAt(root) {
  const value = core()._internal.readJsonFile(stateFile(root, 'cleared.json'));
  return Number(value?.at) || 0;
}

function socialFile(root) {
  return stateFile(root, 'social.json');
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function withRoomLock(root, fn) {
  return core()._internal.withQueueLock(root, fn, {
    lockName: 'room.lock',
    busy: 'The feed is busy saving a note. Try again in a moment.',
  });
}

function isNoteId(id) {
  return String(id || '').startsWith(NOTE_PREFIX);
}

// ------------------------------------------------------------- notes

function readAllNotes(root) {
  let text = '';
  try { text = fs.readFileSync(notesFile(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const note = JSON.parse(line);
      if (note && /^[a-f0-9]{12}$/.test(String(note.id)) && NOTE_KINDS.includes(note.kind)
        && typeof note.text === 'string' && note.text && typeof note.by === 'string') out.push(note);
    } catch {}
  }
  return out;
}

// The newest notes, oldest first, as many as a read ever shows.
function readNotes(root) {
  return readAllNotes(root).slice(-NOTES_READ);
}

function sentenceCount(text) {
  return text.split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean).length;
}

function cleanNote(text) {
  const c = core();
  const clean = c._internal.oneLine(text);
  if (!clean) throw new c.FeedError(400, 'Write the note as one or two sentences.', { field: 'text' });
  if (clean.length > NOTE_MAX) throw new c.FeedError(400, `Keep a note under ${NOTE_MAX} characters.`, { field: 'text' });
  if (sentenceCount(clean) > 2) throw new c.FeedError(400, 'Keep a note to one or two sentences.', { field: 'text' });
  c._internal.requirePlain('text', clean);
  return clean;
}

// The person writes in their own words: only the length is held.
function cleanOwnerNote(text) {
  const c = core();
  const clean = c._internal.oneLine(text);
  if (!clean) throw new c.FeedError(400, 'Write a note.', { field: 'text' });
  if (clean.length > OWNER_NOTE_MAX) throw new c.FeedError(400, `Keep a post under ${OWNER_NOTE_MAX} characters.`, { field: 'text' });
  return clean;
}

function addNote(root, { by, kind, text, feedEpoch }) {
  const c = core();
  return withRoomLock(root, () => {
    // Written for a feed that has been cleared since: not posted onto the empty one.
    if (feedEpoch !== undefined && clearedAt(root) !== feedEpoch) throw new c.FeedError(409, 'The feed was cleared before this was posted.', { code: 'feed_cleared' });
    const all = readAllNotes(root);
    const lower = text.toLowerCase();
    const recent = all.slice(-COPY_WINDOW);
    if (recent.some((note) => c._internal.oneLine(note.text).toLowerCase() === lower || c.nearCopy(text, note.text))) {
      throw new c.FeedError(409, 'That was already said in the feed lately, so it was not posted again.', { field: 'text', code: 'near_copy' });
    }
    const note = { id: newId(), at: new Date().toISOString(), by, kind, text };
    const file = notesFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (all.length + 1 > NOTES_ON_DISK) {
      const kept = [...all, note].slice(-NOTES_READ);
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temp, kept.map((n) => JSON.stringify(n)).join('\n') + '\n', 'utf8');
      fs.renameSync(temp, file);
    } else {
      fs.appendFileSync(file, `${JSON.stringify(note)}\n`, 'utf8');
    }
    return note;
  });
}

function noteCard(note) {
  const c = core()._internal;
  return c.baseCard({
    id: `${NOTE_PREFIX}${note.id}`,
    kind: note.kind,
    source: { type: 'note', id: note.id },
    author: c.member(note.by),
    created_at: note.at,
    state: 'done',
    needs_decision: false,
    title: note.text,
    body: '',
    why: null,
    detail: null,
    story: [],
    visual: null,
    _subject: 'note',
    _changed: Date.parse(note.at) || 0,
  });
}

// The newest notes as cards, oldest first. A note that no longer reads as
// plain words (the file was changed by hand) is left out.
function noteCards(root) {
  const c = core()._internal;
  return readNotes(root).filter((note) => String(note.by).startsWith('user:') || c.isPlainWords(note.text)).map(noteCard);
}

// ------------------------------------------------------------- views

// Each person's own view of a note, as metadata.feed_views keeps it for a task
// card: { [card id]: { [person]: { dismissed_at, seen_at, restored_at } } }.
// Its own file, beside social.json, so a write there (or an older feed
// process rewriting it) never touches it, and hiding a note is not a change.
const VIEWS_CARDS_MAX = 500;
const VIEWS_PEOPLE_MAX = 50;

function viewsFile(root) {
  return stateFile(root, 'views.json');
}

function readViews(root) {
  return core()._internal.obj(core()._internal.readJsonFile(viewsFile(root)));
}

// Hide a note for one person, or (undo) show it again. true when it changed,
// false when there was nothing to change, null when there is no such note.
function markHidden(root, id, person, { undo = false } = {}) {
  const c = core()._internal;
  return withRoomLock(root, () => {
    if (!readNotes(root).some((note) => `${NOTE_PREFIX}${note.id}` === id)) return null;
    const file = viewsFile(root);
    const stored = c.readJsonFile(file);
    if (fs.existsSync(file) && stored === null) {
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch {}
    }
    const views = { ...c.obj(stored) };
    const perCard = { ...c.obj(views[id]) };
    const entry = { ...c.obj(perCard[person]) };
    const at = new Date().toISOString();
    if (undo) {
      if (!entry.dismissed_at) return false;
      if (entry.read_by_dismiss) delete entry.seen_at;
      delete entry.dismissed_at;
      delete entry.read_by_dismiss;
      entry.restored_at = at;
    } else {
      if (entry.dismissed_at) return false;
      entry.dismissed_at = at;
      if (!entry.seen_at) Object.assign(entry, { seen_at: at, read_by_dismiss: true });
    }
    delete perCard[person]; // the newest person last, so the bound keeps the newest
    perCard[person] = entry;
    delete views[id];
    views[id] = Object.fromEntries(Object.entries(perCard).slice(-VIEWS_PEOPLE_MAX));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    c.writeJsonAtomic(file, Object.fromEntries(Object.entries(views).slice(-VIEWS_CARDS_MAX)));
    return true;
  });
}

// ------------------------------------------------------------- social

function readSocial(root) {
  const c = core()._internal;
  const social = c.obj(c.readJsonFile(socialFile(root)));
  // Older feed processes rewrite individual social entries without fields they
  // don't know. Keep hosting state separately so their replies cannot erase it.
  const discussions = c.obj(c.readJsonFile(stateFile(root, 'discussions.json')));
  for (const [id, discussion] of Object.entries(discussions)) {
    if (discussion && typeof discussion === 'object') {
      social[id] = { ...c.obj(social[id]), discussion };
    }
  }
  // Comments turned into work (lib/feed-work.js), kept beside the room for the same reason.
  for (const [id, links] of Object.entries(require('./feed-work').linksByCard(root))) {
    // Not enumerable: a write of social.json never carries a copy of it.
    const target = { ...c.obj(social[id]) };
    Object.defineProperty(target, 'work', { value: links, enumerable: false });
    social[id] = target;
  }
  // Which project this was read from, for the card's work view. Never written out.
  Object.defineProperty(social, '__root', { value: root, enumerable: false });
  return social;
}

function entryOf(social, id) {
  const raw = core()._internal.obj(social[id]);
  const entry = {
    reactions: core()._internal.obj(raw.reactions),
    replies: list(raw.replies).filter((r) => r && typeof r.text === 'string' && typeof r.by === 'string'),
    updated_at: raw.updated_at || null,
  };
  // How many of the oldest comments were let go to keep REPLIES_KEEP, kept only once there are some.
  const dropped = Number(raw.dropped) || 0;
  if (dropped > 0) entry.dropped = dropped;
  // Atris hosting the card's discussion (lib/feed-host.js), kept whole.
  if (raw.discussion && typeof raw.discussion === 'object') entry.discussion = raw.discussion;
  // How the team's discussion on the card ended (lib/feed-outcome.js), kept whole.
  if (raw.outcome && typeof raw.outcome === 'object') entry.outcome = raw.outcome;
  // Comments on the card that became work, read from work.json (never written into social.json).
  if (Array.isArray(raw.work) && raw.work.length) Object.defineProperty(entry, 'work', { value: raw.work, enumerable: false });
  return entry;
}

function changedAt(social, id) {
  return Date.parse(entryOf(social, id).updated_at || '') || 0;
}

// A person commented or reacted on this card. Teammates talking among
// themselves is not the person's conversation, so it does not keep a card on
// their main list (feed-core loadCards).
function personIn(social, id) {
  const person = (ref) => /^(user|human):/.test(String(ref));
  const entry = entryOf(social, id);
  return entry.replies.some((reply) => person(reply.by))
    || Object.values(entry.reactions).some((refs) => list(refs).some(person));
}

// The person wrote a comment on this card at or after sinceMs. A reaction is not a comment.
function personCommented(social, id, sinceMs = 0) {
  return entryOf(social, id).replies.some((reply) => /^(user|human):/.test(String(reply.by))
    && (Date.parse(reply.at || '') || sinceMs) >= sinceMs);
}

// Under the lock: read, change, keep the newest SOCIAL_CARDS_MAX cards, write
// whole. A file that cannot be read is kept aside, never overwritten in silence.
function updateSocial(root, change) {
  return withRoomLock(root, () => {
    const file = socialFile(root);
    if (fs.existsSync(file) && core()._internal.readJsonFile(file) === null) {
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch {}
    }
    const social = readSocial(root);
    if (change(social) === false) return false;
    const ids = Object.keys(social).sort((a, b) => changedAt(social, b) - changedAt(social, a));
    const kept = {};
    for (const id of ids.slice(0, SOCIAL_CARDS_MAX)) kept[id] = social[id];
    core()._internal.writeJsonAtomic(file, kept);
    return true;
  });
}

// One card's entry, changed under the lock (lib/feed-host.js keeps its
// discussion here). change gets the entry and returns false to write nothing.
function updateEntry(root, id, change) {
  return updateSocial(root, (social) => {
    const entry = entryOf(social, id);
    if (change(entry) === false) return false;
    social[id] = { ...entry, updated_at: new Date().toISOString() };
    return true;
  });
}

function replyView(reply) {
  return {
    id: reply.id, author: core()._internal.member(reply.by), text: reply.text, at: reply.at || null,
    ...(reply.command ? { command: reply.command } : {}),
    // A teammate's comment says what it is: found, idea, did, disagree, or the outcome (lib/feed-outcome.js).
    ...(reply.kind ? { kind: reply.kind } : {}),
    ...(reply.source ? { source: reply.source } : {}),
  };
}

// Reactions, the newest replies and the reply count on one card, for this person.
function decorate(card, social, person) {
  const member = core()._internal.member;
  const entry = entryOf(social || {}, card.id);
  const reactions = [];
  for (const emoji of EMOJI) {
    const refs = [...new Set(list(entry.reactions[emoji]).filter((ref) => typeof ref === 'string' && ref))];
    if (!refs.length) continue;
    reactions.push({ emoji, count: refs.length, by: refs.map((ref) => ({ id: ref, name: member(ref).name })), mine: refs.includes(person) });
  }
  card.reactions = reactions;
  card.replies = entry.replies.slice(-REPLIES_SHOWN).map(replyView);
  card.reply_count = entry.replies.length;
  card.discussion = entry.discussion ? require('./feed-host').view(entry) : null;
  // How the team's discussion ended: the answer, the one next step and who has it next. null while it is open.
  card.outcome = require('./feed-outcome').view(entry);
  // What came of comments turned into work on this card, read from the work itself.
  card.work = entry.work && social && social.__root ? require('./feed-work').viewOf(social.__root, entry.work) : [];
  return card;
}

function cleanEmoji(raw) {
  const text = String(raw || '').trim();
  const bare = text.replace(/️/g, '');
  const found = EMOJI.find((emoji) => emoji.replace(/️/g, '') === bare) || EMOJI_NAMES[text.toLowerCase()];
  if (!found) throw new (core().FeedError)(400, `React with one of ${EMOJI.join(' ')}.`, { field: 'emoji' });
  return found;
}

// The person's own words, checked before anything is written, on every
// project: a password or key is refused, so it never reaches the comments,
// the events log, a member's log, the business's hosted feed or a model. The
// check is the precise one, so a commit hash or a document link still saves.
function refuseKey(text) {
  const plain = require('./feed-plain-words');
  if (plain.holdsKey(text)) {
    throw new (core().FeedError)(400, plain.SECRET_REFUSED, { field: 'text', code: 'holds_key' });
  }
}

// ------------------------------------------------------------- who acts

// A member acts with --as; without it the caller is the person, and an owner
// action is refused inside an agent, the same rule a pass follows.
function actorOf(root, { as, env }, doing) {
  const c = core();
  if (as) {
    const slug = c._internal.requireMember(root, as);
    return { ref: c._internal.memberRef(slug), slug };
  }
  const viewer = c.viewerOf(env);
  if (viewer.agent) throw new c.FeedError(403, `Only a person can ${doing} without --as. This is running inside an agent (${viewer.agent}).`);
  return { ref: viewer.person, slug: null };
}

// Delete the room's posts and comments, without touching project tasks. Stage
// every file before replacing any, and serialize with the normal room writes.
function clear(root, { env = process.env, confirmed = false } = {}) {
  const c = core();
  if (confirmed !== true) throw new c.FeedError(400, 'Confirm before clearing the feed.');
  actorOf(root, { env }, 'clear the feed');
  return withRoomLock(root, () => {
    const folder = stateFile(root, '');
    fs.mkdirSync(folder, { recursive: true });
    const socialPath = socialFile(root);
    const raw = c._internal.readJsonFile(socialPath);
    if (fs.existsSync(socialPath) && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new c.FeedError(500, 'Could not read the feed. Nothing was cleared.');
    const social = c._internal.obj(raw);
    const kept = {};
    let comments = 0;
    for (const [id, value] of Object.entries(social)) {
      const entry = c._internal.obj(value);
      comments += list(entry.replies).length;
      if (isNoteId(id)) continue;
      const { replies, dropped, discussion, work, outcome, ...other } = entry;
      kept[id] = { ...other, replies: [] };
    }
    const posts = readAllNotes(root).length;
    const at = Date.now();
    const files = [
      [notesFile(root), ''],
      [socialPath, `${JSON.stringify(kept, null, 2)}\n`],
      [stateFile(root, 'discussions.json'), '{}\n'],
      [stateFile(root, 'work.json'), '{}\n'],
      [stateFile(root, 'cleared.json'), `${JSON.stringify({ at })}\n`],
    ];
    const originals = new Map();
    for (const [file] of files) originals.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
    const staged = [];
    const replaced = [];
    try {
      for (const [file, content] of files) {
        const temp = `${file}.clear-${process.pid}-${newId()}`;
        fs.writeFileSync(temp, content, { flag: 'wx' });
        staged.push([temp, file]);
      }
      for (const [temp, file] of staged) {
        fs.renameSync(temp, file);
        replaced.push(file);
      }
    } catch (error) {
      // Restore files already replaced if the filesystem refuses a later step.
      for (const file of replaced.reverse()) {
        const previous = originals.get(file);
        if (previous === null) { try { fs.unlinkSync(file); } catch {} }
        else {
          const temp = `${file}.restore-${process.pid}-${newId()}`;
          try { fs.writeFileSync(temp, previous, { flag: 'wx' }); fs.renameSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch {} }
        }
      }
      throw error;
    } finally {
      for (const [temp] of staged) { try { fs.unlinkSync(temp); } catch {} }
    }
    return { version: c.FEED_VERSION, cleared: true, posts, comments };
  });
}

// ------------------------------------------------------------- actions

// A note in the room: a post, or an ask anyone on the team or the owner may
// answer. A member writes with --as (only one that is on, held to its day's
// limit unless the note came from an ask round); without --as it is the
// person's own note, refused inside an agent like every owner action.
function say(root, options = {}) {
  const c = core();
  const env = options.env || process.env;
  const who = actorOf(root, { as: options.as, env }, 'post a note');
  if (who.slug) team().checkMemberMayPost(root, who.slug, { fromAsk: options.fromAsk === true, env });
  const kind = options.ask ? 'ask' : 'post';
  const text = who.slug ? cleanNote(options.text) : cleanOwnerNote(options.text);
  if (!who.slug) refuseKey(text);
  const note = addNote(root, { by: who.ref, kind, text, feedEpoch: options.feedEpoch });
  const id = `${NOTE_PREFIX}${note.id}`;
  team().recordEvent(root, { member: who.slug || OWNER_NAME, type: kind, card_id: id, text: text.slice(0, 300) }, options.deps || {});
  if (who.slug) team().logMember(root, who.slug, kind === 'ask' ? 'Asked the team a question in the feed' : 'Posted a note in the feed', { card: id, text });
  return { version: c.FEED_VERSION, card: c.readCard(root, id, { env }) };
}

// Taps a reaction on or off for the caller. With only: 'on' (an ask round),
// a reaction already there is refused instead of taken off.
function react(root, id, emoji, options = {}) {
  const c = core();
  const env = options.env || process.env;
  const who = actorOf(root, { as: options.as, env }, 'react to a card');
  const mark = cleanEmoji(emoji);
  const card = c.readCard(root, id, { env });
  if (who.slug) {
    if (card.author && card.author.id === who.ref) throw new c.FeedError(409, 'A team member does not react to its own card.');
    team().checkMemberMayPost(root, who.slug, { fromAsk: options.fromAsk === true, env });
  }
  let on = false;
  updateSocial(root, (social) => {
    // The card may have been cleared after the initial read.
    if (isNoteId(id) && !readNotes(root).some((note) => `${NOTE_PREFIX}${note.id}` === id)) throw new c.FeedError(404, 'Card not found');
    const entry = entryOf(social, id);
    const refs = list(entry.reactions[mark]).filter((ref) => typeof ref === 'string');
    const had = refs.includes(who.ref);
    if (had && options.only === 'on') {
      throw new c.FeedError(409, `That ${mark} is already on this card.`, { code: 'already_reacted' });
    }
    const next = had ? refs.filter((ref) => ref !== who.ref) : [...refs, who.ref];
    const reactions = { ...entry.reactions, [mark]: next };
    if (!next.length) delete reactions[mark];
    social[id] = { ...entry, reactions, updated_at: new Date().toISOString() };
    on = !had;
    return true;
  });
  // A reaction is too small for the business board; it stays in the events log.
  team().recordEvent(root, {
    member: who.slug || OWNER_NAME, type: 'react', card_id: id,
    text: c._internal.oneLine(`${mark} ${on ? 'on' : 'off'}: ${card.title}`).slice(0, 300),
  }, options.deps || {}, { board: false });
  return { version: c.FEED_VERSION, card: c.readCard(root, id, { env }) };
}

// Validate everything that can refuse a reply before writing to social.json or
// any campaign store.
function prepareReply(root, id, text, options = {}) {
  const c = core();
  const env = options.env || process.env;
  const who = actorOf(root, { as: options.as, env }, 'reply on a card');
  const clean = c._internal.oneLine(text);
  if (!clean) throw new c.FeedError(400, 'Write a reply.', { field: 'text' });
  if (clean.length > REPLY_MAX) throw new c.FeedError(400, `Keep a reply under ${REPLY_MAX} characters.`, { field: 'text' });
  if (who.slug) c._internal.requirePlain('reply', clean);
  const rules = require('./feed-outcome');
  // A teammate talking with the team (not answering the owner one to one) says what kind of comment it is.
  const kind = who.slug && options.outcome ? 'outcome' : who.slug && rules.KINDS.includes(options.kind) ? options.kind : null;
  const source = who.slug && kind && options.source ? c._internal.oneLine(options.source).slice(0, 120) : null;
  if (source) c._internal.requirePlain('reply', source);
  // A teammate answering the person directly is free of the count rules, never of saying something:
  // an answer that is only a question back is not saved.
  if (who.slug && options.direct === true && !options.outcome && rules.onlyQuestion(clean)) {
    throw new c.FeedError(422, `${who.slug} only asked a question back, so nothing was saved.`, { code: 'only_question' });
  }
  const card = c.readCard(root, id, { env });
  if (!who.slug) {
    // A password or key answering a setup question: nothing is saved and the question stays open.
    const plain = require('./feed-plain-words');
    const setupRefused = isNoteId(id) && plain.holdsKey(clean) ? require('./feed-setup').refused(root, id, plain.SECRET_REFUSED) : null;
    if (setupRefused) return { early: { version: c.FEED_VERSION, card, reply: null, setup: setupRefused } };
    refuseKey(clean);
  }
  if (who.slug) team().checkMemberMayPost(root, who.slug, { fromAsk: options.fromAsk === true, env });
  return { env, who, clean, rules, kind, source, card };
}

function checkCampaignSocialReady(root, id, who, clean, options) {
  const c = core();
  if (options.feedEpoch !== undefined && clearedAt(root) !== options.feedEpoch) {
    throw new c.FeedError(409, 'The feed was cleared before this answer arrived.');
  }
  const entry = entryOf(readSocial(root), id);
  const lower = clean.toLowerCase();
  if (!options.outcome && entry.replies.slice(-10).some((r) => r.by === who.ref && c._internal.oneLine(r.text).toLowerCase() === lower)) {
    throw new c.FeedError(409, 'That reply is already on this card.', { code: 'same_reply' });
  }
}

function commitReply(root, id, prepared, options, campaignAnswer) {
  const c = core();
  const { env, who, clean, rules, kind, source, card } = prepared;
  let saved = null;
  let command = null;
  try {
    updateSocial(root, (social) => {
      if (isNoteId(id) && !readNotes(root).some((note) => `${NOTE_PREFIX}${note.id}` === id)) throw new c.FeedError(404, 'Card not found');
      if (options.feedEpoch !== undefined && clearedAt(root) !== options.feedEpoch) {
        if (campaignAnswer) return false;
        throw new c.FeedError(409, 'The feed was cleared before this answer arrived.');
      }
      const entry = entryOf(social, id);
      // "@member do it", from the person, on a card where that member said something to do.
      command = who.slug ? null : require('./feed-work').workCommand(root, clean, entry.replies);
      const lower = clean.toLowerCase();
      const duplicate = !options.outcome
        ? entry.replies.slice(-10).find((r) => r.by === who.ref && c._internal.oneLine(r.text).toLowerCase() === lower)
        : null;
      if (duplicate) {
        if (campaignAnswer) {
          saved = duplicate;
          return false;
        }
        throw new c.FeedError(409, 'That reply is already on this card.', { code: 'same_reply' });
      }
      // The team's own discussion keeps its rules under the lock, so two teammates writing at once cannot both slip past.
      if (who.slug && options.outcome) {
        if (typeof options.mayClose === 'function' && !options.mayClose(entry)) {
          throw new c.FeedError(409, rules.isClosed(entry) ? 'This discussion is already closed.' : 'The one who asked writes the outcome.', { code: 'outcome_refused' });
        }
        const newest = entry.replies.length ? entry.replies[entry.replies.length - 1].id : null;
        if (options.lastSeen !== undefined && options.lastSeen !== newest) {
          throw new c.FeedError(409, 'The discussion moved on while this outcome was being written.', { code: 'outcome_stale' });
        }
      } else if (who.slug && options.direct === true && options.answering
        && entry.replies.some((r) => r.by === who.ref && r.answers === String(options.answering))) {
        // A member named in a comment answers that comment once.
        throw new c.FeedError(409, `${who.slug} already answered that comment.`, { code: 'comment_refused' });
      } else if (who.slug && options.direct !== true && options.ownerQuestion !== true) {
        // Every teammate comment, however it was written (a thought, `feed reply --as`), keeps the discussion rules.
        // Only a teammate answering the person who asked it by name (direct) is outside them.
        const why = rules.refusal(entry, who.ref, { kind: options.kind, text: clean, source, strict: options.team === true, note: isNoteId(id) });
        if (why) throw new c.FeedError(409, why, { code: 'comment_refused' });
        // An answer to one comment of the person's: the first teammate to answer it is the only one.
        if (options.answering) {
          // Answered means a teammate answered that very comment, or commented after it (not as an answer to an older one) with nothing newer from the person.
          const at = entry.replies.findIndex((r) => r.id === options.answering);
          const after = at < 0 ? [] : entry.replies.slice(at + 1);
          const person = (r) => /^(user|human):/.test(String(r.by));
          const newest = !after.some(person);
          if (at < 0 || after.some((r) => r.answers === options.answering) || (newest && after.some((r) => !person(r) && !r.answers))) {
            throw new c.FeedError(409, 'A teammate already answered that comment.', { code: 'comment_refused' });
          }
        }
      }
      saved = {
        id: newId(), by: who.ref, text: clean, at: new Date().toISOString(),
        ...(command ? { command: 'work' } : {}), ...(kind ? { kind } : {}), ...(source ? { source } : {}),
        ...(who.slug && options.answering ? { answers: String(options.answering) } : {}),
      };
      const all = [...entry.replies, saved];
      const over = Math.max(0, all.length - REPLIES_KEEP);
      const next = { ...entry, replies: all.slice(-REPLIES_KEEP), updated_at: saved.at };
      if (who.slug && options.outcome) next.outcome = { ...options.outcome, reply_id: saved.id, by: who.ref, at: saved.at };
      // The person answering the one thing the outcome asked of them: the card goes to the teammate with the next step.
      else if (!who.slug && next.outcome && next.outcome.needs_you) {
        next.outcome = { ...next.outcome, needs_you: null, decided: clean.slice(0, 200), owner: next.outcome.after || next.outcome.owner, after: null };
      // A person speaking on any other closed card opens it again; the old outcome stays in the comments.
      } else if (!who.slug && next.outcome) delete next.outcome;
      social[id] = next;
      if (over) social[id].dropped = (entry.dropped || 0) + over;
      return true;
    });
  } catch (error) {
    if (!campaignAnswer) throw error;
  }
  if (!who.slug && String(id).startsWith('task:')) {
    const db = c._internal.openWrite();
    const { row } = c._internal.cardAndTask(root, db, id);
    const ask = c._internal.obj(c._internal.feedOf(row.metadata).ask);
    if (ask.text && !ask.answered_at) {
      const tdb = require('./task-db');
      tdb.updateTaskMetadata(db, row.id, (metadata) => {
        const feed = c._internal.obj(metadata.feed);
        const closed = { ...feed.ask, answered_at: saved.at, answer: clean.slice(0, 600) };
        const asks = Array.isArray(feed.asks) ? feed.asks.slice() : [];
        const index = asks.findIndex((a) => a.at === closed.at && a.by === closed.by);
        if (index >= 0) asks[index] = closed;
        metadata.feed = { ...feed, ask: closed, asks };
        if (!feed.ask_had_hold) metadata.tags = (Array.isArray(metadata.tags) ? metadata.tags : []).filter((tag) => tag !== 'needs-human');
        return metadata;
      });
    }
  }
  team().recordEvent(root, { member: who.slug || OWNER_NAME, type: options.ownerQuestion ? 'asked' : 'reply', card_id: id, text: clean.slice(0, 300) }, options.deps || {});
  if (who.slug) {
    team().logMember(root, who.slug, 'Replied on a card in the feed', { card: id, text: clean });
  } else if (card.author && card.author.type === 'agent' && c._internal.teamMembers(root).includes(c._internal.slugOf(card.author.id))) {
    team().logMember(root, c._internal.slugOf(card.author.id), 'The owner replied on a card', { card: id, said: clean });
  }
  // The comment is saved even if starting the work fails.
  let work = null;
  let workError = null;
  if (command) {
    try {
      work = require('./feed-work').startWork(root, id, { replyId: command.reply_id, via: 'mention', env, deps: options.deps || {} }).work;
    } catch (error) {
      const known = c.asFeedError(error);
      workError = known ? known.message.slice(0, 300) : 'The work did not start.';
    }
  }
  // The person naming members with @ (not "@member do it"): each named, awake member answers this comment once,
  // right away, in the background (lib/feed-host.js). The comment is saved even if asking fails.
  let tags = null;
  if (!who.slug && !command && saved) {
    try {
      tags = require('./feed-host').tagged(root, id, saved, { env, deps: options.deps || {}, asked: options.asked });
    } catch (error) {
      if (!c.asFeedError(error)) throw error;
      tags = { tagged: [], note: 'The named team members could not be asked just now.' };
    }
  }
  // The person answering a setup question (lib/feed-setup.js): the answer
  // goes into the project's lessons and the next question is asked.
  let setup = null;
  let setupError = null;
  if (!who.slug && isNoteId(id)) {
    try {
      setup = require('./feed-setup').answered(root, id, clean, { env, deps: options.deps || {} });
    } catch (error) {
      const known = c.asFeedError(error);
      if (!known) throw error;
      setupError = known.message.slice(0, 300);
    }
  }
  return {
    version: c.FEED_VERSION,
    card: campaignAnswer ? campaignAnswer.card : c.readCard(root, id, { env }),
    reply: saved ? replyView(saved) : null,
    ...(campaignAnswer ? { answered: campaignAnswer.answered, ask_id: campaignAnswer.ask_id, ...(campaignAnswer.via ? { via: campaignAnswer.via } : {}) } : {}),
    ...(command ? { work, ...(workError ? { work_error: workError } : {}) } : {}),
    // The members who will answer because the comment named them; tag_note says why a named one will not.
    ...(tags ? { tagged: tags.tagged, ...(tags.note ? { tag_note: tags.note } : {}) } : {}),
    ...(setup ? { setup } : {}),
    ...(setupError ? { setup_error: setupError } : {}),
  };
}

// A short reply on any card. A member's reply is held to plain words.
// On a campaign card, record the campaign answer/talk before touching social.json
// so a failed campaign write never leaves a comment behind on an open ask.
function reply(root, id, text, options = {}) {
  const prepared = prepareReply(root, id, text, options);
  if (prepared.early) return prepared.early;
  const campaigns = require('./campaign-feed');
  let campaignAnswer = null;
  if (!prepared.who.slug && campaigns.isCardId(id)) {
    checkCampaignSocialReady(root, id, prepared.who, prepared.clean, options);
    campaignAnswer = campaigns.comment(root, id, prepared.clean, { env: prepared.env, deps: options.deps || {} });
  }
  return commitReply(root, id, prepared, options, campaignAnswer);
}

// Same reply from the command line: a campaign question answered here also
// reaches the campaign's cloud copy when it has one.
async function replySynced(root, id, text, options = {}) {
  const prepared = prepareReply(root, id, text, options);
  if (prepared.early) return prepared.early;
  const campaigns = require('./campaign-feed');
  let campaignAnswer = null;
  if (!prepared.who.slug && campaigns.isCardId(id)) {
    checkCampaignSocialReady(root, id, prepared.who, prepared.clean, options);
    campaignAnswer = await campaigns.comment(root, id, prepared.clean, { env: prepared.env, deps: options.deps || {}, sync: true });
  }
  return commitReply(root, id, prepared, options, campaignAnswer);
}

// Every saved comment on one card, oldest first, in the shape a card carries.
// With limit, only the newest that many. truncated says some were left out:
// by the limit, or let go long ago to keep the newest REPLIES_KEEP (dropped).
function replies(root, id, options = {}) {
  const c = core();
  const env = options.env || process.env;
  const card = c.readCard(root, id, { env }); // a card that is not there says so
  const entry = entryOf(readSocial(root), id);
  let size = REPLIES_READ_MAX;
  if (options.limit !== undefined && options.limit !== null && options.limit !== '') {
    size = Number.parseInt(options.limit, 10);
    if (!Number.isInteger(size) || size < 1) throw new c.FeedError(400, 'limit is a whole number of at least 1.', { field: 'limit' });
    size = Math.min(size, REPLIES_READ_MAX);
  }
  const all = entry.replies.map(replyView);
  const shown = all.slice(-size);
  return {
    version: c.FEED_VERSION,
    card_id: id,
    card,
    replies: shown,
    reply_count: all.length,
    truncated: shown.length < all.length || Boolean(entry.dropped),
    dropped: entry.dropped || 0,
  };
}

module.exports = {
  clear,
  clearedAt,
  REPLY_MAX,
  _updateEntry: updateEntry,
  _withRoomLock: withRoomLock,
  EMOJI,
  decorate,
  changedAt,
  isNoteId,
  markHidden,
  personIn,
  personCommented,
  noteCards,
  notesFile,
  react,
  readNotes,
  readSocial,
  readViews,
  replies,
  reply,
  replySynced,
  say,
  socialFile,
};
