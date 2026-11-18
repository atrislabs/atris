'use strict';

// A teammate's comment becomes real work, from the feed. The person taps
// "Do this" on a member's comment (or writes "@member do it" on that card),
// and that member's suggestion goes down the one path approved work already
// takes: it is proposed as that member's idea (lib/feed-core.js proposeCard,
// with its copy checks and limits) and approved by the person at once
// (decide: the same yes as the Approve button, with every guard it has: an
// asleep member or a model that cannot run says so, a protected lane waits
// for the person, the run queue keeps two at a time).
//
// The link from the comment to its work is kept on the card it came from, in
// .atris/state/feed/work.json under the room lock, and the task remembers
// where it came from (feed.origin). So the work's state, and its result or
// failure, show on that same card, across restarts, and a second tap (or a
// tap from another window) never makes a second task.
//
// No model runs here, nothing outside the project is touched, and an agent
// can never start work this way: only a person.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function core() {
  return require('./feed-core');
}

function c() {
  return core()._internal;
}

function room() {
  return require('./feed-room');
}

const LINKS_PER_CARD = 20;
const CARDS_KEPT = 500;
// A tap that started and never finished saving (the app closed in between) is
// taken up again by the next tap after this long; before it, a tap waits for it.
const STARTING_STALE_MS = 2 * 60 * 1000;
const TITLE_MAX = 120;

// "@writer do it", "yes @writer, go ahead please!": the whole comment, and
// nothing else. Any other words, or a mention alone, are ordinary talk.
const WORK_WORDS = '(?:do it|do this|do that|go ahead|go for it|build it|make it|start it|start on it|take it|run with it)';
const WORK_COMMAND = new RegExp(`^\\s*(?:(?:yes|ok|okay)[,!.]?\\s+)?@([A-Za-z0-9._-]+)[,:]?\\s+(?:please\\s+)?${WORK_WORDS}(?:\\s+please)?[\\s.!]*$`, 'i');

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function workFile(root) {
  return path.join(root, '.atris', 'state', 'feed', 'work.json');
}

function readAll(root) {
  return c().obj(c().readJsonFile(workFile(root)));
}

// The links on every card, for the room's read (feed-room readSocial).
function linksByCard(root) {
  const all = readAll(root);
  const out = {};
  for (const [id, links] of Object.entries(all)) {
    const clean = list(links).filter((l) => l && typeof l.id === 'string' && typeof l.reply_id === 'string');
    if (clean.length) out[id] = clean;
  }
  return out;
}

// Changes one card's links under the room lock. A file that cannot be read is
// refused, never overwritten in silence.
function changeLinks(root, cardId, change) {
  return room()._withRoomLock(root, () => {
    const file = workFile(root);
    const stored = c().readJsonFile(file);
    if (fs.existsSync(file) && stored === null) throw new (core().FeedError)(500, 'Could not read where the feed keeps started work.');
    const all = c().obj(stored);
    const links = list(all[cardId]).filter((l) => l && typeof l.id === 'string');
    const out = change(links);
    all[cardId] = links.slice(-LINKS_PER_CARD);
    const ids = Object.keys(all).sort((a, b) => {
      if (a === cardId) return -1;
      if (b === cardId) return 1;
      const latest = (id) => Math.max(0, ...list(all[id]).map((l) => Date.parse(l.updated_at || l.at || '') || 0));
      return latest(b) - latest(a);
    });
    c().writeJsonAtomic(file, Object.fromEntries(ids.slice(0, CARDS_KEPT).map((id) => [id, all[id]])));
    return out;
  });
}

function patchLink(root, cardId, linkId, patch) {
  return changeLinks(root, cardId, (links) => {
    const link = links.find((l) => l.id === linkId);
    if (!link) return null;
    Object.assign(link, patch, { updated_at: nowIso() });
    return { ...link };
  });
}

// ------------------------------------------------------------- what to start

// The member a comment is from, when it is a teammate on this project.
function memberOfReply(root, reply) {
  if (!reply || !reply.author || reply.author.type === 'user') return null;
  const slug = c().slugOf(reply.author.id);
  return slug && c().teamMembers(root).includes(slug) ? slug : null;
}

function firstSentence(text) {
  const clean = c().oneLine(text);
  const end = clean.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? clean.slice(0, end + 1) : clean;
  if (sentence.length <= TITLE_MAX) return sentence;
  const cut = sentence.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function plainOr(text, fallback) {
  return text && c().isPlainWords(text) ? text : fallback;
}

// The task, from the comment and the post it answers. Plain words on the
// card; the person's own words (which may hold names of files) go in detail.
function workFields(slug, card, reply, conversation) {
  const excerpt = (value, max) => {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max)}\n[excerpt; read the source for the rest]` : text;
  };
  const said = c().oneLine(reply.text);
  const title = plainOr(firstSentence(said), `${slug}'s suggestion on your post`);
  const body = plainOr(said, '');
  const others = list(conversation.replies).filter((entry) => entry.id !== reply.id).slice(-8);
  const snapshot = excerpt([
    'Handoff context snapshot. Sources belong to this project; no other project files or private memory are attached.',
    `Source card: ${excerpt(card.id, 200)}. Author: ${excerpt(card.author?.id || 'unknown', 100)}. Recorded: ${excerpt(card.created_at, 80)}`,
    `Selected teammate: ${slug}. Selected reply: ${excerpt(reply.id, 200)}. Recorded: ${excerpt(reply.at, 80)}`,
    card.title ? `${!card.body && card.author?.type === 'user' ? "The owner's post" : 'Source title'}: ${excerpt(card.title, 1200)}` : '',
    card.body ? `${card.author?.type === 'user' ? "The owner's post" : 'Source body'}: ${excerpt(card.body, 3000)}` : '',
    `${slug} said: ${excerpt(reply.text, 1000)}`,
    `Conversation: ${others.length} other recent comments, at most eight of the retained thread. Earlier comments may be omitted${conversation.truncated ? '; the source history is also truncated' : ''}.`,
    ...others.map((entry) => `[${excerpt(entry.id, 100)}] ${excerpt(entry.author?.id || 'unknown', 100)}: ${excerpt(entry.text, 350)}`),
    'Later comments do not change this saved handoff. Reuse this snapshot on retry; corrections need explicit follow-up.',
  ].filter(Boolean).join('\n\n'), 8800);
  const detail = `${snapshot}\n\nThe owner said: do this.`;
  const objective = [
    'Carry out the selected teammate suggestion using the saved context below.',
    snapshot,
    'Stay inside this project. Anything that would reach outside it (sending, publishing, paying, going live) waits for the owner.',
  ].join('\n\n');
  return { title, body, why: 'You asked for this on your post.', detail, objective };
}

// ------------------------------------------------------------- start

// The idea card that belongs to this task, as it is now.
function ideaCardOf(root, taskId, { env }) {
  const kinds = ['proposal', 'question'];
  for (const kind of kinds) {
    try {
      return core().readCard(root, c().cardId(taskId, kind), { env });
    } catch {}
  }
  return null;
}

// Whether a started link may be started again by the person: its work came
// back to waiting (a failed run), or it never got past the yes.
function retryable(view) {
  return Boolean(view && view.can_retry);
}

// An approved idea whose run ended without a result and that nothing has put
// back yet (the runner died before the queue noticed, or could not start).
const STOPPED_RUNS = new Set(['ended', 'failed_to_start']);
function stoppedRun(idea) {
  return Boolean(idea && !idea.needs_decision && idea.run && STOPPED_RUNS.has(idea.run.status)
    && !['working', 'done', 'failed'].includes(idea.state) && !(idea.decision && idea.decision.choice === 'dismiss'));
}

// `atris feed work <card> --reply <id> [--retry]`: the person turns a
// teammate's comment on the card into work. Returns the link as the card
// shows it, and the card.
function startWork(root, cardId, options = {}) {
  const env = options.env || process.env;
  const deps = options.deps || {};
  const viewer = core().viewerOf(env);
  const via = options.via === 'mention' ? 'mention' : 'button';
  if (viewer.agent) {
    throw new (core().FeedError)(403, `Only a person can turn a comment into work. This is running inside an agent (${viewer.agent}).`, { code: 'agent_caller' });
  }
  const id = String(cardId || '');
  const replyId = String(options.replyId || '');
  if (!id || !replyId) throw new (core().FeedError)(400, 'usage: atris feed work <card> --reply <comment id> [--retry]');
  const card = core().readCard(root, id, { env }); // 404 when the card is not in this project
  const conversation = room().replies(root, id, { env });
  const reply = conversation.replies.find((r) => r.id === replyId);
  if (!reply) throw new (core().FeedError)(404, 'That comment is not on this card.', { code: 'no_comment' });
  // The outcome of a discussion becomes work as its one next step, for the teammate it named.
  const closed = reply.kind === 'outcome' && card.outcome && card.outcome.reply_id === reply.id ? card.outcome : null;
  // An outcome the owner has since talked past is no longer how the discussion ended.
  if (reply.kind === 'outcome' && !closed) throw new (core().FeedError)(409, 'This discussion was opened again, so that outcome no longer stands.', { code: 'outcome_gone' });
  // The one thing the outcome asks of the owner comes first; and a next step that is the owner's own is not a teammate's work.
  if (closed && closed.needs_you) throw new (core().FeedError)(409, 'Answer the question on this card first. The work starts from your answer.', { code: 'needs_you' });
  if (closed && closed.owner && closed.owner.type === 'user' && !closed.after) throw new (core().FeedError)(409, 'This next step is yours, so there is nothing for a teammate to start.', { code: 'owner_step' });
  const named = closed && [closed.owner, closed.after].find((who) => who && who.type !== 'user' && c().teamMembers(root).includes(c().slugOf(who.id)));
  const slug = named ? c().slugOf(named.id) : memberOfReply(root, reply);
  if (!slug) throw new (core().FeedError)(409, 'Only a teammate\'s comment can become work.', { code: 'not_a_member' });
  const basis = closed ? { ...reply, text: `${/[.!?]$/.test(closed.next) ? closed.next : `${closed.next}.`} ${closed.answer}${closed.decided ? ` The owner chose: ${closed.decided}` : ''}` } : reply;

  // One link per comment. A tap while one is starting, or once it started,
  // answers with it; only a link whose work came back (or failed to start)
  // starts again, and only when the person asks (--retry, or a new tap on it).
  const before = viewOf(root, linksByCard(root)[id] || []).find((v) => v.reply_id === replyId) || null;
  const reserved = changeLinks(root, id, (links) => {
    const link = links.find((l) => l.reply_id === replyId);
    const now = Date.now();
    if (link) {
      const startingFresh = link.state === 'starting' && now - (Date.parse(link.updated_at || link.at || '') || 0) < STARTING_STALE_MS;
      if (startingFresh) return { link: { ...link }, go: false };
      const again = link.state === 'failed' || link.state === 'starting' || (options.retry === true && retryable(before));
      if (!again) return { link: { ...link }, go: false };
      Object.assign(link, { state: 'starting', message: null, updated_at: nowIso(), tries: (Number(link.tries) || 1) + 1 });
      return { link: { ...link }, go: true };
    }
    const fresh = {
      id: newId(), reply_id: replyId, member: slug, via, by: viewer.person,
      state: 'starting', task_id: null, card_id: null, outcome: null, message: null,
      at: nowIso(), updated_at: nowIso(), tries: 1,
    };
    links.push(fresh);
    return { link: { ...fresh }, go: true };
  });
  if (!reserved.go) return answer(root, id, reserved.link.id, { env, started: false, replayed: true });

  const link = reserved.link;
  let taskId = link.task_id;
  try {
    if (!taskId) {
      const fields = workFields(slug, card, basis, conversation);
      const proposed = core().proposeCard(root, {
        as: slug, title: fields.title, why: fields.why, body: fields.body, detail: fields.detail,
        objective: fields.objective, origin: { card_id: id, reply_id: replyId, via }, env,
      });
      taskId = proposed.card.source.id;
      patchLink(root, id, link.id, { task_id: taskId, card_id: proposed.card.id, member: c().slugOf(proposed.card.author.id) || slug, merged: proposed.merged === true });
    }
    let idea = ideaCardOf(root, taskId, { env });
    if (stoppedRun(idea)) {
      // The person asked again for work whose run is gone. Settle dead runs the
      // way repair does, and give back a yes that never ran, so the approval
      // below starts it again through the same guards.
      core().pump(root, { ...deps, maxRunning: 0 });
      idea = ideaCardOf(root, taskId, { env });
      if (stoppedRun(idea)) {
        const db = c().openWrite();
        const row = require('./task-db').getTask(db, taskId);
        if (row) c().returnToWaiting(root, db, { ...row, metadata: c().obj(row.metadata) }, { card_id: idea.id, member: slug }, 'The work stopped before it finished.');
        idea = ideaCardOf(root, taskId, { env });
      }
    }
    if (!idea) throw new (core().FeedError)(404, 'The work for this comment is gone.');
    let outcome = link.outcome || null;
    if (idea.needs_decision) {
      const decided = core().decide(root, idea.id, 'approve', { env, deps, note: `Started from ${slug}'s comment on your post` });
      outcome = decided.outcome || null;
    } else if (idea.decision && idea.decision.choice === 'dismiss') {
      throw new (core().FeedError)(409, 'You said no to this idea before, so it was not started.', { code: 'dismissed' });
    }
    patchLink(root, id, link.id, { state: 'started', card_id: idea.id, outcome, message: null });
    require('./feed-team').recordEvent(root, { member: 'the owner', type: 'work', card_id: id, text: `${slug} started on: ${c().oneLine(idea.title).slice(0, 200)}` }, deps, { board: false });
    require('./feed-team').logMember(root, slug, 'The owner turned your comment into work', { card: id, work: idea.id });
    return answer(root, id, link.id, { env, started: Boolean(outcome && outcome.started), replayed: false });
  } catch (error) {
    const known = core().asFeedError(error);
    if (!known) {
      patchLink(root, id, link.id, { state: 'failed', message: 'The work did not start.' });
      throw error;
    }
    patchLink(root, id, link.id, { state: 'failed', message: known.message.slice(0, 300) });
    return answer(root, id, link.id, { env, started: false, replayed: false });
  }
}

function answer(root, cardId, linkId, { env, started, replayed }) {
  const card = core().readCard(root, cardId, { env });
  const work = (card.work || []).find((w) => w.id === linkId) || null;
  return { version: core().FEED_VERSION, started, replayed, work, card };
}

// ------------------------------------------------------------- "@member do it"

// The member a person's comment tells to do it, when the whole comment is
// that and the member has a comment on this card to act on. Else null.
function workCommand(root, text, replies) {
  const match = WORK_COMMAND.exec(String(text || ''));
  if (!match) return null;
  const slug = match[1].toLowerCase();
  if (!c().teamMembers(root).includes(slug)) return null;
  const theirs = list(replies).filter((r) => r && r.by === c().memberRef(slug));
  const last = theirs[theirs.length - 1];
  return last ? { member: slug, reply_id: last.id } : null;
}

// ------------------------------------------------------------- the view

const STARTED_LINES = {
  queued: (o) => (o.position ? `Waiting to start, number ${o.position} in line` : 'Waiting to start'),
  guarded_lane: (o) => (o.lane ? `This touches ${o.lane}, so it waits for you` : 'This touches a protected area, so it waits for you'),
  no_agent_owner: () => 'No teammate could take this, so it waits for you',
  already_claimed: () => 'Someone already has this',
  enqueue_failed: () => 'It could not be put in line',
};

// One link, as the card shows it: read from the task it started, never from
// what was hoped. A task in another project is never read.
function viewLink(link, tasks) {
  const base = {
    id: link.id,
    reply_id: link.reply_id,
    member: link.member,
    via: link.via || 'button',
    card_id: link.card_id || null,
    result_card_id: null,
    status: 'starting',
    message: null,
    progress: null,
    position: null,
    proof: null,
    can_retry: false,
    at: link.at || null,
    updated_at: link.updated_at || link.at || null,
  };
  const cards = link.task_id ? tasks.get(link.task_id) : null;
  const idea = cards && cards.find((card) => card.kind === 'proposal' || card.kind === 'question');
  // A receipt write can fail after the task has already advanced. The task
  // wins once it has started, reached review, or produced a result.
  const guarded = idea && idea.guarded_lane && idea.decision?.choice === 'approve';
  const advanced = guarded || cards && cards.some((card) => card.kind === 'result' || card._subject === 'accept'
    || (!card.needs_decision && (['working', 'done'].includes(card.state) || ['running', 'queued'].includes(card.run?.status))));
  if (!advanced && link.state === 'starting') {
    const stale = Date.now() - (Date.parse(link.updated_at || link.at || '') || 0) >= STARTING_STALE_MS;
    return stale ? { ...base, status: 'failed', message: 'It stopped before the work started.', can_retry: true } : base;
  }
  if (!advanced && link.state === 'failed') return { ...base, status: 'failed', message: link.message || 'The work did not start.', can_retry: true };
  if (!cards || !cards.length) return { ...base, status: 'failed', message: 'The work for this comment is gone.' };
  const accept = cards.find((card) => card._subject === 'accept') || null;
  const result = cards.find((card) => card.kind === 'result') || null;
  if (result) {
    return {
      ...base,
      status: result.state === 'failed' ? 'failed' : 'done',
      result_card_id: result.id,
      message: c().oneLine(result.body || '').slice(0, 300) || (result.state === 'failed' ? 'The work did not finish.' : null),
      proof: result.proof ? result.proof.status : null,
    };
  }
  if (accept && accept.needs_decision) return { ...base, status: 'review', result_card_id: accept.id, message: 'Finished. Waiting for your ok' };
  if (!idea) return { ...base, status: 'working' };
  if (idea.needs_decision) {
    return { ...base, status: 'failed', message: idea.last_failure && idea.last_failure.reason ? `It did not finish: ${c().oneLine(idea.last_failure.reason).slice(0, 200)}` : 'It is waiting for your yes again.', can_retry: true };
  }
  if (idea.decision && idea.decision.choice === 'dismiss') return { ...base, status: 'failed', message: 'You said no to this idea.' };
  if (idea.state === 'working') return { ...base, status: 'working', progress: idea.progress ? idea.progress.text : null };
  if (idea.state === 'done') return { ...base, status: 'done' };
  if (idea.state === 'failed') return { ...base, status: 'failed', message: 'The work did not finish.' };
  const outcome = c().obj(link.outcome);
  if (guarded && !idea.run) return { ...base, status: 'needs_you', message: STARTED_LINES.guarded_lane({ lane: idea.guarded_lane }) };
  // Its run is gone (the runner died, or could not start) and nothing put the card back yet: not waiting, stopped.
  if (stoppedRun(idea)) return { ...base, status: 'failed', message: 'The work stopped before it finished.', can_retry: true };
  if (idea.run && idea.run.status === 'queued') return { ...base, status: 'waiting', position: idea.run.position || null, message: STARTED_LINES.queued({ position: idea.run.position }) };
  if (idea.run && idea.run.status === 'running') return { ...base, status: 'working', progress: idea.progress ? idea.progress.text : null };
  if (outcome.reason && STARTED_LINES[outcome.reason]) return { ...base, status: outcome.reason === 'guarded_lane' ? 'needs_you' : 'waiting', message: STARTED_LINES[outcome.reason](outcome) };
  return { ...base, status: 'waiting', message: 'Waiting to start' };
}

// The task cards behind these links, read once, from this project only.
function taskCards(root, links) {
  const ids = [...new Set(links.map((l) => l.task_id).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const db = c().openReadOnly(process.env);
  if (!db) return out;
  const roots = c().viewRoots(root);
  try {
    const entries = c().readRuns(root);
    const runs = c().runsByTask(entries);
    const index = c().receiptIndex(root);
    for (const id of ids) {
      const row = c().rowOut(db.prepare(`SELECT ${c().COLUMNS} FROM tasks WHERE id = ?`).get(id));
      if (!row || !roots.includes(row.workspace_root)) continue;
      out.set(id, c().buildTaskCards(row, { runs, entries }).map((card) => ({
        ...c().finishCard(root, card, index),
        _work_owner: c().memberRef(row.claimed_by || row.metadata.assigned_to || ''),
      })));
    }
  } finally {
    db.close();
  }
  return out;
}

function viewOf(root, links) {
  const clean = list(links);
  if (!clean.length) return [];
  let tasks = new Map();
  try { tasks = taskCards(root, clean); } catch {}
  return clean.map((link) => {
    const view = viewLink(link, tasks);
    const owner = (tasks.get(link.task_id) || []).find((card) => card._work_owner)?._work_owner || c().memberRef(link.member);
    const person = link.by || null;
    const next = {
      starting: ['pending', owner, 'wait_for_start'],
      waiting: ['accepted', owner, 'wait_for_start'],
      working: ['running', owner, 'continue_work'],
      review: ['blocked', person, 'review_result'],
      needs_you: ['blocked', person, 'resolve_approval'],
      failed: ['blocked', person, view.can_retry ? 'retry_work' : 'inspect_work'],
      done: ['done', null, 'inspect_result'],
    }[view.status];
    return { ...view, receipt_state: next[0], next_owner: next[1], next_action: next[2] };
  });
}

// When a card's links last moved, counting the tasks they started, so a delta
// read carries the card when its work moves (lib/feed-core.js loadCards).
function changedAt(links, rowsById) {
  let at = 0;
  for (const link of list(links)) {
    at = Math.max(at, Date.parse(link.updated_at || link.at || '') || 0);
    const row = link.task_id ? rowsById.get(link.task_id) : null;
    if (row) at = Math.max(at, Number(row.updated_at) || 0);
  }
  return at;
}

module.exports = {
  changedAt,
  linksByCard,
  startWork,
  viewOf,
  workCommand,
  workFile,
};
