'use strict';

// The standing yes: an opt-in rule the person switches on so the team can
// start safe ideas while they are away. Off unless the person turns it on
// (atris feed settings set standing-yes on). When on, a waiting proposal
// starts by itself, exactly as if the person approved it, only when all hold:
// - it is a proposal (not a question), still waiting for a decision;
// - it has no guarded lane (money, billing, payments, deploy, security,
//   customer, external always wait for a person);
// - at least one teammate other than its author backs it;
// - its author is on and its model can run here;
// - the person has not talked on it or scrolled past it;
// - fewer than the day's cap started this way today. The count fails closed:
//   if it cannot be read, nothing starts.
// It goes through the same decision path as a real approval (same queue, same
// lane refusal) and the record says the standing yes did it, not the person.

const fs = require('fs');
const path = require('path');

const DEFAULT_PER_DAY = 3;
const MAX_PER_DAY = 100;

function core() {
  return require('./feed-core')._internal;
}

function team() {
  return require('./feed-team');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function countFile(root) {
  return path.join(root, '.atris', 'state', 'feed', 'standing-yes.json');
}

// The setting as saved: { on, per_day }. Anything not a clear yes is off.
function standingSetting(root) {
  const saved = core().obj(team().readFeedConfig(root).standing_yes);
  const perDay = Number.isInteger(saved.per_day) && saved.per_day >= 0 ? saved.per_day : DEFAULT_PER_DAY;
  return { on: saved.on === true && perDay > 0, per_day: perDay };
}

// Today's count, or null when it cannot be read (the cap then fails closed).
// No file yet is a day with nothing started.
function readCount(root) {
  const day = today();
  let text;
  try {
    text = fs.readFileSync(countFile(root), 'utf8');
  } catch (error) {
    return error && error.code === 'ENOENT' ? { day, started: 0, cards: [] } : null;
  }
  let saved;
  try { saved = JSON.parse(text); } catch { return null; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  if (saved.day !== day) return { day, started: 0, cards: [] };
  const started = Number(saved.started);
  if (!Number.isInteger(started) || started < 0) return null;
  return { day, started, cards: Array.isArray(saved.cards) ? saved.cards.slice(-MAX_PER_DAY) : [] };
}

function writeCount(root, count) {
  core().writeJsonAtomic(countFile(root), count);
}

// Only a person turns it on or off, or sets the day's cap (0 turns it off).
function setStandingYes(root, name, value, options = {}) {
  const c = core();
  const viewer = c.viewerOf(options.env || process.env);
  if (viewer.agent) throw new c.FeedError(403, `Only a person can change the standing yes. This is running inside an agent (${viewer.agent}).`);
  const saved = c.obj(team().readFeedConfig(root).standing_yes);
  const perDay = Number.isInteger(saved.per_day) && saved.per_day > 0 ? saved.per_day : DEFAULT_PER_DAY;
  let next;
  if (name === 'standing-yes') {
    const word = String(value || '').trim().toLowerCase();
    if (!['on', 'off'].includes(word)) throw new c.FeedError(400, 'usage: atris feed settings set standing-yes on|off');
    next = { on: word === 'on', per_day: perDay };
  } else {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > MAX_PER_DAY) {
      throw new c.FeedError(400, `standing-yes-per-day is a whole number from 0 to ${MAX_PER_DAY} (0 turns it off)`);
    }
    next = number === 0 ? { on: false, per_day: perDay } : { on: saved.on === true, per_day: number };
  }
  team().writeFeedConfig(root, { standing_yes: next });
  return team().settingsView(root, options);
}

// What settings shows: on or off, the cap, and how many started today.
function standingView(root) {
  const setting = standingSetting(root);
  const count = readCount(root);
  return {
    on: setting.on,
    per_day: setting.per_day,
    started_today: count ? count.started : null,
    count_readable: Boolean(count),
  };
}

function passedByAnyone(card) {
  return Object.values(core().obj(card._views)).some((entry) => (Number.parseInt(core().obj(entry).passes, 10) || 0) > 0);
}

function personTalked(db, row) {
  if (core().obj(core().feedOf(row.metadata).thread).last_owner_text) return true;
  const events = db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'message'").all(row.id);
  return events.some((event) => {
    try { return core().obj(core().obj(JSON.parse(event.payload)).feed).from === 'person'; } catch { return true; }
  });
}

// Why this card may not start by the standing yes, or null when it may.
function notEligible(root, card, row, db, env) {
  const c = core();
  if (card.kind !== 'proposal') return 'not a proposal';
  if (!card.needs_decision || card.decision || card.state !== 'pending') return 'not waiting';
  if (card.guarded_lane) return `guarded lane: ${card.guarded_lane}`;
  if (!(card.backer_count >= 1)) return 'no teammate backs it';
  if (!row || row.status !== 'open') return 'not open';
  if (c.feedOf(row.metadata).last_failure) return 'came back after a run that did not finish';
  const author = c.slugOf(card.author && card.author.id);
  if (!author || !c.teamMembers(root).includes(author)) return 'no team member wrote it';
  if (!team().isOn(root, author)) return `${author} is off`;
  if (!team().memberEngine(root, author, { env }).available) return `${author}'s model cannot run here`;
  if (passedByAnyone(card)) return 'the person scrolled past it';
  if (personTalked(db, row)) return 'the person talked on it';
  return null;
}

// Start every card the standing yes may start, oldest first, up to the day's
// cap. Safe to call often: off does nothing, and a card is decided only once.
function applyStandingYes(root, { env = process.env, deps = {} } = {}) {
  const setting = standingSetting(root);
  if (!setting.on) return { on: false, started: [], skipped: [] };
  const c = core();
  return c.withQueueLock(root, () => {
    const { cards, rows } = c.loadCards(root, { env });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const db = c.openWrite();
    const waiting = cards.filter((card) => card.kind === 'proposal' && card.needs_decision)
      .sort((a, b) => (Date.parse(a.created_at || '') || 0) - (Date.parse(b.created_at || '') || 0));
    const started = [];
    const skipped = [];
    for (const card of waiting) {
      const row = byId.get(card.source && card.source.id);
      const why = notEligible(root, card, row, db, env);
      if (why) { skipped.push({ id: card.id, reason: why }); continue; }
      const count = readCount(root);
      if (!count) { skipped.push({ id: card.id, reason: 'the day\'s count cannot be read' }); break; }
      if (count.started >= setting.per_day) { skipped.push({ id: card.id, reason: 'the day\'s cap is reached' }); break; }
      // Count first, then start: a count that cannot be saved starts nothing.
      try {
        writeCount(root, { day: count.day, started: count.started + 1, cards: [...count.cards, card.id] });
      } catch {
        skipped.push({ id: card.id, reason: 'the day\'s count cannot be saved' });
        break;
      }
      let out = null;
      try {
        out = c.takeDecision(root, card.id, 'approve', {
          env, deps, viewer: { agent: '', person: c.STANDING_YES }, actor: c.STANDING_YES, note: null,
        });
      } catch (error) {
        skipped.push({ id: card.id, reason: c.oneLine(error && error.message).slice(0, 200) });
      }
      if (!out || out.replayed) {
        try { writeCount(root, count); } catch {} // not started: give the count back
        continue;
      }
      try {
        team().recordEvent(root, {
          member: c.STANDING_YES, type: 'started', card_id: card.id,
          text: c.oneLine(`started by the standing yes: ${card.title}`).slice(0, 300),
        }, deps);
      } catch {}
      started.push({ id: card.id, title: card.title, outcome: out.outcome });
    }
    return { on: true, started, skipped };
  }, { lockName: 'standing-yes.lock', busy: 'The standing yes is already starting work.' });
}

// For the places that call it in passing (after an idea lands, after a round):
// it never breaks the caller.
function standingYesQuietly(root, options = {}) {
  try { return applyStandingYes(root, options); } catch { return null; }
}

module.exports = {
  applyStandingYes,
  setStandingYes,
  standingView,
  standingYesQuietly,
};
