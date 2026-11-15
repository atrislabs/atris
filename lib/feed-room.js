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
  if (clean.length > NOTE_MAX) throw new c.FeedError(400, `Keep a note under ${NOTE_MAX} characters.`, { field: 'text' });
  return clean;
}

function addNote(root, { by, kind, text }) {
  const c = core();
  return withRoomLock(root, () => {
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

// ------------------------------------------------------------- social

function readSocial(root) {
  return core()._internal.obj(core()._internal.readJsonFile(socialFile(root)));
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
  return entry;
}

function changedAt(social, id) {
  return Date.parse(entryOf(social, id).updated_at || '') || 0;
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

function replyView(reply) {
  return { id: reply.id, author: core()._internal.member(reply.by), text: reply.text, at: reply.at || null };
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
  return card;
}

function cleanEmoji(raw) {
  const text = String(raw || '').trim();
  const bare = text.replace(/️/g, '');
  const found = EMOJI.find((emoji) => emoji.replace(/️/g, '') === bare) || EMOJI_NAMES[text.toLowerCase()];
  if (!found) throw new (core().FeedError)(400, `React with one of ${EMOJI.join(' ')}.`, { field: 'emoji' });
  return found;
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
  const note = addNote(root, { by: who.ref, kind, text });
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

// A short reply on any card. A member's reply is held to plain words.
function reply(root, id, text, options = {}) {
  const c = core();
  const env = options.env || process.env;
  const who = actorOf(root, { as: options.as, env }, 'reply on a card');
  const clean = c._internal.oneLine(text);
  if (!clean) throw new c.FeedError(400, 'Write a reply.', { field: 'text' });
  if (clean.length > REPLY_MAX) throw new c.FeedError(400, `Keep a reply under ${REPLY_MAX} characters.`, { field: 'text' });
  if (who.slug) c._internal.requirePlain('reply', clean);
  const card = c.readCard(root, id, { env });
  if (who.slug) team().checkMemberMayPost(root, who.slug, { fromAsk: options.fromAsk === true, env });
  let saved = null;
  updateSocial(root, (social) => {
    const entry = entryOf(social, id);
    const lower = clean.toLowerCase();
    if (entry.replies.slice(-10).some((r) => r.by === who.ref && c._internal.oneLine(r.text).toLowerCase() === lower)) {
      throw new c.FeedError(409, 'That reply is already on this card.', { code: 'same_reply' });
    }
    saved = { id: newId(), by: who.ref, text: clean, at: new Date().toISOString() };
    const all = [...entry.replies, saved];
    const over = Math.max(0, all.length - REPLIES_KEEP);
    social[id] = { ...entry, replies: all.slice(-REPLIES_KEEP), updated_at: saved.at };
    if (over) social[id].dropped = (entry.dropped || 0) + over;
    return true;
  });
  team().recordEvent(root, { member: who.slug || OWNER_NAME, type: 'reply', card_id: id, text: clean.slice(0, 300) }, options.deps || {});
  if (who.slug) {
    team().logMember(root, who.slug, 'Replied on a card in the feed', { card: id, text: clean });
  } else if (card.author && card.author.type === 'agent' && c._internal.teamMembers(root).includes(c._internal.slugOf(card.author.id))) {
    team().logMember(root, c._internal.slugOf(card.author.id), 'The owner replied on a card', { card: id, said: clean });
  }
  return { version: c.FEED_VERSION, card: c.readCard(root, id, { env }), reply: replyView(saved) };
}

// Every saved comment on one card, oldest first, in the shape a card carries.
// With limit, only the newest that many. truncated says some were left out:
// by the limit, or let go long ago to keep the newest REPLIES_KEEP (dropped).
function replies(root, id, options = {}) {
  const c = core();
  const env = options.env || process.env;
  c.readCard(root, id, { env }); // a card that is not there says so
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
    replies: shown,
    reply_count: all.length,
    truncated: shown.length < all.length || Boolean(entry.dropped),
    dropped: entry.dropped || 0,
  };
}

module.exports = {
  REPLY_MAX,
  EMOJI,
  decorate,
  changedAt,
  isNoteId,
  noteCards,
  notesFile,
  react,
  readNotes,
  readSocial,
  replies,
  reply,
  say,
  socialFile,
};
