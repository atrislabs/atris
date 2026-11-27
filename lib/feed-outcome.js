'use strict';

// How the team talks on a card, so a discussion moves forward and ends.
//
// A teammate's comment on a card is one of four kinds, and says so:
//   Found     a fact it looked up itself, with where it found it
//   Idea      a concrete proposal and why
//   Did       work it did, with the result
//   Disagree  with the reason
// A comment that is only a question is not saved: the teammate answers it
// itself first from what the project knows. What only the owner can decide
// reaches the owner once, on the outcome.
//
// A discussion holds at most COMMENTS_MAX teammate comments after the last
// thing a person said. Nobody comments twice in a row, and a second comment
// from the same teammate must bring something new (Found or Did). Then the
// one who asked writes the outcome: the answer, the one next step and who has
// it next, and one lesson the team keeps (lib/feed-digest.js team notes, the
// same place every teammate already reads before it thinks). A closed card
// takes no more teammate comments; a person's comment opens it again.
//
// Everything here is plain rules. No model is used.

const KINDS = ['found', 'idea', 'did', 'disagree'];
const KIND_WORDS = { found: 'Found', idea: 'Idea', did: 'Did', disagree: 'Disagree', outcome: 'Outcome' };
const COMMENTS_MAX = 3;
const STALE_CLOSE_MS = 30 * 60 * 1000; // a full discussion nobody closed: any teammate may
const ANSWER_MAX = 600;
const NEXT_MAX = 200;
const LESSON_MAX = 160;
const CHOICES_MAX = 3;
const CHOICE_MAX = 60;
const OWNER_WORDS = /^(the\s+)?(owner|you|person)$/i;

const KIND_LINE = /^\s*(FOUND|IDEA|DID|DISAGREE)\s*[:\-–]\s*(.*)$/i;
const FROM_PART = /\s*(?:\||;|\.)?\s*\bFROM\s*:\s*(.+)$/i;

function core() {
  return require('./feed-core');
}

function c() {
  return core()._internal;
}

function isPerson(ref) {
  return /^(user|human):/.test(String(ref || ''));
}

// "FOUND: the page loads in two seconds. FROM: Tuesday's notes" in parts.
// A comment with no kind comes back with kind null.
function parseComment(value) {
  const match = KIND_LINE.exec(String(value || ''));
  if (!match) return { kind: null, text: c().oneLine(value), source: null };
  const kind = match[1].toLowerCase();
  let text = match[2].trim();
  let source = null;
  const from = FROM_PART.exec(text);
  if (from) {
    source = c().oneLine(from[1]).replace(/[.\s]+$/, '').slice(0, 120) || null;
    text = text.slice(0, from.index).trim();
    if (text && !/[.!?]$/.test(text)) text += '.';
  }
  return { kind, text: c().oneLine(text), source };
}

// Only questions: every sentence asks. "We could ship it Friday. Does that
// work?" is not, because it says something first.
function onlyQuestion(text) {
  const clean = c().oneLine(text);
  if (!clean) return false;
  const sentences = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  // A sentence that ends inside a quote ('The buyer asked "When will it ship?"') reports a question, it does not ask one.
  return sentences.every((s) => /\?\)?$/.test(s));
}

function replyList(entry) {
  return (Array.isArray(entry && entry.replies) ? entry.replies : []).filter((r) => r && typeof r.text === 'string' && typeof r.by === 'string');
}

// The teammate comments that count now: after the last thing a person said,
// the outcome itself left out.
function stretch(entry) {
  const all = replyList(entry);
  let lastPerson = -1;
  all.forEach((r, i) => { if (isPerson(r.by)) lastPerson = i; });
  return all.slice(lastPerson + 1).filter((r) => r.kind !== 'outcome');
}

function isClosed(entry) {
  return Boolean(entry && entry.outcome && typeof entry.outcome === 'object' && entry.outcome.answer);
}

function isFull(entry) {
  return stretch(entry).length >= COMMENTS_MAX;
}

// Why this teammate's comment is not saved, or null when it is fine. Every teammate comment, however it was written,
// is refused on a closed card and when it is only a question. strict (a teammate talking with the team in a thought,
// where the pile-ups come from) also asks for the kind, Found for its where, and keeps the count: a few comments a
// card, nobody twice in a row. A teammate reporting from real work (`feed reply --as`) is not counted. note: the card is a note or a question in the feed, which ends with an outcome; any other card (an idea
// waiting for the owner) takes the same few comments and then waits for the owner.
function refusal(entry, ref, { kind, text, source, strict = false, note = true } = {}) {
  if (isClosed(entry)) return 'This discussion is closed. Its outcome is on the card.';
  if (strict && !KINDS.includes(kind)) return 'A comment starts with Found, Idea, Did or Disagree.';
  if (!c().oneLine(text)) return 'A comment needs words.';
  if (onlyQuestion(text)) return 'A comment that is only a question is not saved. Look it up in what the project knows and say what you found.';
  if (strict && kind === 'found' && !source) return 'Found needs where you found it: add FROM: and a few plain words.';
  if (!strict) return null;
  const mine = stretch(entry);
  if (mine.length >= COMMENTS_MAX) return `This card already has ${COMMENTS_MAX} comments from the team, the most. ${note ? 'It is time for the outcome.' : 'It waits for the owner now.'}`;
  const last = replyList(entry).slice(-1)[0];
  if (last && last.by === ref) return 'Not twice in a row on one card. Let a teammate or the owner speak first.';
  if (mine.some((r) => r.by === ref) && kind !== 'found' && kind !== 'did') return 'You already said your piece on this card. Come back only with something you found or did.';
  return null;
}

// Who may write the outcome: the one who asked. On the owner's own post, a
// teammate who took part. A full discussion left open for a while, anyone.
function mayClose(card, entry, ref, now = Date.now()) {
  if (isClosed(entry)) return false;
  const author = card && card.author ? card.author.id : null;
  if (author === ref) return true;
  const said = stretch(entry);
  if ((isPerson(author) || !author) && said.some((r) => r.by === ref)) return true;
  // Left open for a while (the one who asked is asleep or gone): any teammate may close it, so no discussion is stranded.
  const lastAt = Date.parse((said[said.length - 1] || {}).at || '') || 0;
  return said.length > 0 && lastAt > 0 && now - lastAt > STALE_CLOSE_MS;
}

function clip(text, max) {
  const clean = c().oneLine(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function cleanChoices(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || '').split('|')) {
    // Only a list mark is taken off the front ("- ", "1. "), never the choice's own number ("10% off").
    const choice = c().oneLine(part).replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '').slice(0, CHOICE_MAX);
    if (!choice || seen.has(choice.toLowerCase())) continue;
    seen.add(choice.toLowerCase());
    out.push(choice);
    if (out.length >= CHOICES_MAX) break;
  }
  return out;
}

// The one who has the next step: a teammate on this project, or the owner.
function ownerOf(root, raw) {
  const word = c().oneLine(raw).replace(/^@/, '');
  if (!word || OWNER_WORDS.test(word)) return { slug: null, ref: 'owner' };
  const slug = word.toLowerCase();
  if (!c().teamMembers(root).includes(slug)) return null;
  return { slug, ref: c().memberRef(slug) };
}

// A teammate closes a discussion: the answer, the one next step, who has it
// next, and optionally one thing only the owner can decide and one lesson.
function close(root, cardId, fields = {}, options = {}) {
  const cc = core();
  const env = options.env || process.env;
  const deps = options.deps || {};
  const slug = cc._internal.requireMember(root, options.as);
  const ref = c().memberRef(slug);
  const fail = (message, code = 'outcome_refused') => { throw new cc.FeedError(409, message, { code }); };
  const answer = clip(fields.answer, ANSWER_MAX);
  const next = clip(fields.next, NEXT_MAX);
  if (!answer) fail('An outcome needs the answer.');
  if (onlyQuestion(answer)) fail('The answer of an outcome says something. A question only the owner can decide goes in ASK_OWNER.');
  if (!next) fail('An outcome needs the one next step.');
  if (onlyQuestion(next)) fail('The next step is something to do, not a question.');
  const question = fields.ask_owner ? clip(fields.ask_owner, NEXT_MAX) : '';
  const choices = question ? cleanChoices(fields.choices) : [];
  const named = ownerOf(root, fields.owner);
  if (!named) fail(`The next step needs an owner on this team, or the owner. "${c().oneLine(fields.owner).slice(0, 60)}" is neither.`);
  // Something the owner must decide puts the card in the owner's hands first.
  const owner = question ? { slug: null, ref: 'owner' } : named;
  const lesson = fields.lesson ? clip(fields.lesson, LESSON_MAX) : '';
  for (const [field, value] of [['outcome', answer], ['next step', next], ['question', question], ['lesson', lesson], ...choices.map((ch) => ['choice', ch])]) {
    if (value) c().requirePlain(field, value);
  }
  const card = cc.readCard(root, cardId, { env });
  if (card.kind !== 'post' && card.kind !== 'ask') fail('Only a note or a question in the feed is closed with an outcome.');
  const room = require('./feed-room');
  const outcome = {
    answer, next, owner: owner.ref, after: question ? named.ref : null,
    needs_you: question ? { question, choices } : null,
    lesson: lesson || null,
  };
  const out = room.reply(root, cardId, answer, {
    as: slug, fromAsk: options.fromAsk === true, env, deps, outcome, mayClose: (entry) => mayClose(card, entry, ref),
    // The discussion as the one closing it read it: an outcome written before a newer comment is not saved over it.
    lastSeen: options.lastSeen, feedEpoch: options.feedEpoch,
  });
  // One lesson the whole team reads before it next thinks. A lesson that
  // cannot be kept never undoes the outcome.
  let kept = null;
  if (lesson) {
    try {
      kept = require('./feed-digest').addNote(root, { text: lesson, scope: 'team', from: clip(card.title, 60) });
      room._updateEntry(root, cardId, (entry) => {
        if (!entry.outcome || entry.outcome.reply_id !== out.reply.id) return false;
        entry.outcome = { ...entry.outcome, lesson_id: kept.id };
        return true;
      });
    } catch {}
  }
  require('./feed-team').logMember(root, slug, 'Closed a discussion in the feed', { card: cardId, answer, next, owner: owner.slug || 'the owner' });
  if (owner.slug && owner.slug !== slug) require('./feed-team').logMember(root, owner.slug, 'A discussion ended with the next step yours', { card: cardId, next });
  return { version: cc.FEED_VERSION, card: cc.readCard(root, cardId, { env }), reply: out.reply, lesson: kept };
}

// What a card carries as `outcome`, or null while the discussion is open.
function view(entry) {
  if (!isClosed(entry)) return null;
  const o = entry.outcome;
  const who = (ref) => (ref === 'owner' || isPerson(ref) ? { id: 'owner', name: 'You', type: 'user' } : c().member(ref));
  return {
    reply_id: o.reply_id || null,
    by: c().member(o.by),
    at: o.at || null,
    answer: o.answer,
    next: o.next,
    owner: who(o.owner),
    after: o.after && o.after !== 'owner' ? who(o.after) : null,
    needs_you: o.needs_you && o.needs_you.question
      ? { question: o.needs_you.question, choices: Array.isArray(o.needs_you.choices) ? o.needs_you.choices.slice(0, CHOICES_MAX) : [] }
      : null,
    // What the owner chose, once they answered the one thing asked of them.
    decided: o.decided || null,
    lesson: o.lesson || null,
  };
}

// Open discussions this teammate should close now, for its next thought. Only the newest `shown` notes count: the
// ones a thought is shown, so nobody is woken for a card it cannot see.
function toClose(cards, social, slug, { now = Date.now(), shown = Infinity } = {}) {
  const ref = c().memberRef(slug);
  const out = [];
  const time = (card) => Date.parse(card.created_at || '') || 0;
  const notes = cards.filter((card) => card.kind === 'post' || card.kind === 'ask').sort((a, b) => time(b) - time(a)).slice(0, shown);
  for (const card of notes) {
    const entry = c().obj(social[card.id]);
    const said = stretch(entry);
    if (!said.length || isClosed(entry)) continue;
    if (mayClose(card, entry, ref, now)) out.push(card.id);
  }
  return out;
}

module.exports = {
  COMMENTS_MAX,
  KINDS,
  KIND_WORDS,
  close,
  isClosed,
  mayClose,
  onlyQuestion,
  parseComment,
  refusal,
  stretch,
  toClose,
  view,
};
