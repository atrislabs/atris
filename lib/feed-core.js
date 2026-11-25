'use strict';

// atris feed, local edition: the decision feed built from a project's own
// tasks, team and goal, in the same shape as the cloud feed (atris.feed.v1).
//
// Units it reuses, and adds nothing beside:
// - tasks: the task store (lib/task-db.js). A team member's idea is an open
//   task that carries a needs-a-person tag, so no member run picks it up
//   (lib/member-task-pick.js heldForPerson) until a person approves it here.
// - the goal: `atris goal` (commands/goal.js, .atris/state/scoreboard.json)
//   is the feed's theme.
// - proof: a result is "verified" only when a real passing task receipt
//   exists (lib/task-receipt.js files in atris/runs) or every receipt the
//   task's own proof names passed (lib/receipt-evidence.js).
// - starting work: an approval starts `atris member go <member>`, the same
//   start `atris member up` uses, in the background, at most FEED_MAX_RUNNING
//   at once; the rest wait in order in .atris/state/feed/runs.json.
//
// The list path is a read: one read-only query against the task store, one
// small state file, no model, no network and no child process.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// node:sqlite warns that it is experimental on every load. Hide only that one
// warning, the same narrow filter lib/task-db.js installs, because the list
// path opens the store without loading task-db.
{
  const originalEmit = process.emit;
  process.emit = function feedEmit(name, data, ...args) {
    if (name === 'warning' && data && data.name === 'ExperimentalWarning' && /SQLite/i.test(data.message || '')) return false;
    return originalEmit.apply(process, [name, data, ...args]);
  };
}

const { plumbingWords, isPlainWords, holdsKey, SECRET_REFUSED } = require('./feed-plain-words');
const { checkVisual, safeVisual, VisualRejected } = require('./feed-visuals');
const { workspaceRoot: resolveWorkspaceRoot, linkedWorktreeRootsFromDisk } = require('./workspace-root');
const { protectedLaneOf } = require('./protected-lane');
const { isDecisionTask, isDecisionHoldTag } = require('./task-decision');

const FEED_VERSION = 'atris.feed.v1';
// The most members the feed runs at once. Approvals past this wait in order.
const FEED_MAX_RUNNING = 2;
const DEFAULT_LIMIT = 30;
const MAX_FEED_LIMIT = 100;
const FEED_FILTERS = ['all', 'needs_decision', 'working', 'dismissed', 'parked', 'done'];
// The reading queue, as the cloud feed keeps it: a pass is the person
// scrolling past an undecided card without choosing. It is not a dismissal.
const VIEWS_KEY = 'feed_views';
const PASS_HOLD_MINUTES = 30;
const FEW_IDEAS = 6; // below this many showable ideas, a passed idea rests only SHORT_HOLD_MINUTES
const SHORT_HOLD_MINUTES = 5;
const PARK_AFTER_PASSES = 3;
const MAX_PASS_BATCH = 50;
const CURSOR_MAX_SENT = 600;
const RESULT_WINDOW = 300; // finished tasks looked at, most recently changed first
const GUARDED_LANES = ['money', 'billing', 'payments', 'deploy', 'security', 'customer', 'external'];
const PROPOSAL_TITLE_MAX = 200;
const PROPOSAL_BODY_MAX = 5000;
const PROPOSAL_WHY_MAX = 300;
const PROPOSAL_DETAIL_MAX = 10000;
const DEFAULT_MAX_PENDING_PER_AUTHOR = 10;
const STORY_MAX_LINES = 3;
const STORY_LINE_MAX = 160;
const THEME_MAX = 140;
const OWNER_MESSAGE_MAX = 2000;
const MEMBER_REPLY_MAX = 1000;
const MAX_MESSAGES_PER_CARD = 30;
const WAITING_PREFIX = 'session:';
const WAITING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WAITING_REASON = 'Answer in that chat window.';
const FALLBACK_TITLES = {
  proposal: 'A team member proposed new work',
  question: 'A team member has a question for you',
  accept: 'Finished work is waiting for your ok',
  'result:done': 'A piece of work finished',
  'result:failed': 'A piece of work did not finish',
  update: 'A piece of work is under way',
  // Held work (a task marked as needing a person) whose own words cannot be shown. Never the question line: it can
  // be approved, and approving starts work. Such a card stays off the main list (offMain).
  hold: 'Work waiting for your yes, not yet written in plain words',
};
// A teammate's question (feed emit question) wants words back: it is answered in the comments, never approved.
const QUESTION_REASON = 'This asks you something. Answer it in the comments.';
// The default list keeps a card that has nothing to decide and no work
// running only while its newest activity is younger than this many hours.
// ATRIS_FEED_FRESH_HOURS (a positive number) changes it.
const FRESH_HOURS = 24;
// The same markers `atris task accept` reads to refuse an agent (lib/task-core.js).
const AGENT_ENV_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT', 'DEVIN_SESSION_ID',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_MISSION_DRIVER_DETACHED', 'ATRIS_MISSION_DRIVER_PARENT_PID',
  'ATRIS_DISPATCH_DEPTH',
];

class FeedError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'FeedError';
    this.status = status;
    Object.assign(this, extra);
  }

  toJSON() {
    const out = { status: this.status, message: this.message };
    for (const key of ['field', 'remove', 'goal', 'code', 'busy']) if (this[key] !== undefined) out[key] = this[key];
    return out;
  }
}

// ------------------------------------------------------------- helpers

function iso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function nowIso() {
  return new Date().toISOString();
}

function oneLine(value) {
  return String(value ?? '').split(/\s+/).filter(Boolean).join(' ');
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseJson(text) {
  if (!text) return {};
  try { return obj(JSON.parse(text)); } catch { return {}; }
}

// Who is calling: an agent when any agent or worker shell marker is set, or
// when agent proof-only mode is forced on. Stricter than `task accept`: an
// agent cannot turn this off with ATRIS_AGENT_PROOF_ONLY=0.
function agentMarker(env = process.env) {
  const found = AGENT_ENV_MARKERS.find((marker) => String(env[marker] || '').trim() !== '');
  if (found) return found;
  return String(env.ATRIS_AGENT_PROOF_ONLY || '').trim() === '1' ? 'ATRIS_AGENT_PROOF_ONLY' : '';
}

function personId(env = process.env) {
  return `user:${String(env.USER || env.USERNAME || 'local').trim() || 'local'}`;
}

function member(id) {
  const raw = String(id || '');
  const [kind, ...rest] = raw.split(':');
  const ident = rest.join(':');
  if (kind === 'agent' && ident) return { id: raw, name: ident, type: 'agent' };
  if ((kind === 'user' || kind === 'human') && ident) return { id: `user:${ident}`, name: 'You', type: 'user' };
  return { id: raw || null, name: raw || 'Team', type: 'agent' };
}

function memberRef(slug) {
  const clean = String(slug || '').trim();
  if (!clean) return '';
  return clean.startsWith('agent:') ? clean : `agent:${clean}`;
}

function slugOf(ref) {
  return String(ref || '').replace(/^agent:/, '');
}

// Refused before anything is written: words that hold a password or key (the
// precise check, so a commit hash or a document link in technical notes is kept).
function refuseKey(field, text) {
  if (text && holdsKey(text)) throw new FeedError(400, SECRET_REFUSED, { field, code: 'holds_key' });
}

function requirePlain(field, text) {
  const found = plumbingWords(text);
  if (found.length) {
    throw new FeedError(400, `Rewrite the ${field} in plain words. Remove: ${found.join(', ')}. Put technical text in detail instead.`,
      { field, remove: found });
  }
}

function requireVisual(visual, root = null) {
  try {
    return checkVisual(visual, { root });
  } catch (error) {
    if (error instanceof VisualRejected) {
      throw new FeedError(400, error.message, { field: 'visual', ...(error.words.length ? { remove: error.words } : {}) });
    }
    throw error;
  }
}

function envCount(env, name, fallback) {
  const value = Number.parseInt(String(env[name] || ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// ------------------------------------------------------------- project

// The project the command runs in: the task store's own root rule, so card
// ids and rows match `atris task`. It must have an atris/ folder.
function projectRoot(cwd = process.cwd()) {
  const root = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(path.join(root, 'atris'))) {
    throw new FeedError(404, 'No atris folder here. Run this inside a project, or start one with: atris init');
  }
  return root;
}

function viewRoots(root) {
  return [root, ...linkedWorktreeRootsFromDisk(root)];
}

function dbPath(env = process.env) {
  if (env.ATRIS_TASKS_DB) return env.ATRIS_TASKS_DB;
  return path.join(require('./state-home').atrisHome(), 'tasks.db');
}

// How long one feed read waits for a task store another process is writing.
// A person is watching the feed load, so a few seconds, not the writers' 30:
// the writes the feed waits behind (adding or claiming a task, a member
// opening the store) take milliseconds, and a store still busy after this is
// better answered with "busy, try again" than with a frozen screen.
const READ_BUSY_WAIT_MS = 3000;
const READ_BUSY_STEP_MS = 1000; // SQLite's own busy wait inside each try

// The one error a caller can tell apart from every other: the task store
// stayed busy. error.busy is true and error.code is 'busy'.
function busyError() {
  return new FeedError(503, 'The task list is busy with other work right now. Try again in a moment.', { code: 'busy', busy: true });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs fn, and while the store answers busy tries again until
// READ_BUSY_WAIT_MS has passed, then gives the busy error. SQLite's busy
// wait alone is not enough: node:sqlite can return busy before it, as the
// writer's withBusyRetry in lib/task-db.js notes.
function waitWhileBusy(fn) {
  const { isBusyError } = taskDb();
  const started = Date.now();
  let delay = 10;
  for (;;) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyError(error)) throw error;
      if (Date.now() - started >= READ_BUSY_WAIT_MS) throw busyError();
      sleepMs(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 200);
    }
  }
}

// A statement whose reads wait out a busy store.
function patientStatement(statement) {
  return new Proxy(statement, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (['all', 'get', 'run', 'iterate'].includes(prop)) return (...args) => waitWhileBusy(() => value.apply(target, args));
      return value.bind(target);
    },
  });
}

// A read-only handle for the list path: no schema setup, no writes. Opening
// it and every statement on it wait out a busy store (waitWhileBusy).
function openReadOnly(env = process.env) {
  const file = dbPath(env);
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = waitWhileBusy(() => new DatabaseSync(file, { readOnly: true, timeout: READ_BUSY_STEP_MS }));
  return new Proxy(db, {
    get(target, prop) {
      const value = target[prop];
      if (prop === 'prepare') return (sql) => patientStatement(waitWhileBusy(() => value.call(target, sql)));
      if (prop === 'exec') return (sql) => waitWhileBusy(() => value.call(target, sql));
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Any error as the feed's own: a busy task store becomes busyError, other
// feed errors stay as they are, and anything else is not one (null).
function asFeedError(error) {
  if (error instanceof FeedError) return error;
  try {
    if (taskDb().isBusyError(error)) return busyError();
  } catch {}
  return null;
}

function rowOut(row) {
  return row ? { ...row, metadata: parseJson(row.metadata) } : null;
}

const COLUMNS = 'id, title, status, tag, workspace_root, claimed_by, claimed_at, created_at, updated_at, done_at, metadata';

// Every task that can make a card: all unfinished ones, plus the most recently
// changed finished ones, plus dismissed ideas.
function readFeedRows(db, roots) {
  const marks = roots.map(() => '?').join(', ');
  const live = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE workspace_root IN (${marks})
    AND status IN ('open', 'claimed', 'review')`).all(...roots);
  const finished = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE workspace_root IN (${marks})
    AND (status IN ('done', 'failed') OR (status = 'archived' AND metadata LIKE '%"feed"%'))
    ORDER BY updated_at DESC LIMIT ${RESULT_WINDOW}`).all(...roots);
  return [...live, ...finished].map(rowOut);
}

// ------------------------------------------------------------- receipts

function receiptSlug(taskId) {
  // lib/task-receipt.js slugifyTaskId, so names match the files it writes.
  return String(taskId || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

function receiptIndex(root) {
  const dir = path.join(root, 'atris', 'runs');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return new Map(); }
  const index = new Map();
  const shape = /^\d{4}-\d{2}-\d{2}-task-(.+)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/;
  for (const name of names) {
    const match = shape.exec(name);
    if (!match) continue;
    if (!index.has(match[1])) index.set(match[1], []);
    index.get(match[1]).push(name);
  }
  return index;
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Verified only on a real pass: the newest task receipt for this task passed,
// or every receipt the task's proof names passed. Never from prose alone.
function taskProof(root, row, index) {
  const checks = [];
  let uri = null;
  const names = (index.get(receiptSlug(row.id)) || []).slice().sort();
  const own = names.map((name) => ({ name, receipt: readJsonFile(path.join(root, 'atris', 'runs', name)) }))
    .filter(({ receipt }) => receipt && receipt.schema === 'atris.task_receipt.v1' && String(receipt.task_id) === String(row.id));
  for (const { name, receipt } of own) {
    checks.push({ name: oneLine(receipt.command || 'check').slice(0, 120), passed: receipt.result?.passed === true });
    uri = path.join('atris', 'runs', name);
  }
  const newestPassed = own.length > 0 && own[own.length - 1].receipt.result?.passed === true;
  let citedPassed = false;
  const proofText = String(row.metadata.latest_agent_proof || '');
  if (proofText) {
    const evidence = require('./receipt-evidence').extractReceiptEvidence(proofText, root);
    if (evidence) {
      for (const entry of evidence.receipts) checks.push({ name: entry.path, passed: entry.verifier_passed === true });
      for (const missing of evidence.missing) checks.push({ name: missing, passed: false });
      citedPassed = evidence.all_passing === true;
      if (citedPassed && !uri) uri = evidence.receipts[0].path;
    }
  }
  return { status: newestPassed || citedPassed ? 'verified' : 'unverified', checks, uri };
}

// ------------------------------------------------------------- run queue

function feedStateDir(root) {
  return path.join(root, '.atris', 'state', 'feed');
}

function runsFile(root) {
  return path.join(feedStateDir(root), 'runs.json');
}

function readRuns(root) {
  const data = readJsonFile(runsFile(root));
  return Array.isArray(data?.entries) ? data.entries : [];
}

// Under the queue lock: a runs file that cannot be read is kept aside (never
// overwritten in silence) and the queue starts again from what can be known.
function readRunsForWrite(root) {
  const file = runsFile(root);
  if (fs.existsSync(file) && !Array.isArray(readJsonFile(file)?.entries)) {
    try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch {}
    return [];
  }
  return readRuns(root);
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// One writer at a time for the queue file (or, with lockName, another feed
// file). A lock older than a minute is a crashed writer and is taken over.
function withQueueLock(root, fn, { lockName = 'runs.lock', busy = 'The feed is busy starting work. Try again in a moment.' } = {}) {
  const lock = path.join(feedStateDir(root), lockName);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new FeedError(503, busy, { code: 'busy', busy: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// Waiting chats share the feed's state folder, writer lock and atomic saves.
// Reads see a whole file without taking a lock, just like the run queue.
function waitingFile(root) {
  return path.join(feedStateDir(root), 'waiting.json');
}

function readWaiting(root, now = Date.now()) {
  const data = readJsonFile(waitingFile(root));
  return (Array.isArray(data?.entries) ? data.entries : [])
    .filter((entry) => entry && typeof entry.session === 'string' && entry.session.trim()
      && typeof entry.ask === 'string' && entry.ask.trim()
      && Number.isFinite(Date.parse(entry.created_at)) && now - Date.parse(entry.created_at) <= WAITING_MAX_AGE_MS)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.session.localeCompare(b.session));
}

function waitingSession(raw) {
  const session = String(raw ?? '').trim();
  if (!session) throw new FeedError(400, 'give the chat a session id.', { field: 'session' });
  return session;
}

function withWaitingLock(root, fn) {
  return withQueueLock(root, fn, {
    lockName: 'waiting.lock', busy: 'The feed is busy saving a waiting chat. Try again in a moment.',
  });
}

function setWaiting(root, { session: raw, ask, title, engine } = {}) {
  const session = waitingSession(raw);
  const cleanAsk = oneLine(ask).slice(0, 400).trim();
  if (!cleanAsk) throw new FeedError(400, 'write what you need answered.', { field: 'ask' });
  return withWaitingLock(root, () => {
    const entries = readWaiting(root);
    const previous = entries.find((entry) => entry.session === session);
    const at = nowIso();
    const waiting = {
      session, ask: cleanAsk, title: oneLine(title).slice(0, 80).trim(), engine: oneLine(engine),
      created_at: previous?.created_at || at, updated_at: at,
    };
    writeJsonAtomic(waitingFile(root), { entries: [...entries.filter((entry) => entry.session !== session), waiting] });
    return { version: FEED_VERSION, waiting };
  });
}

function clearWaiting(root, raw) {
  const session = waitingSession(raw);
  return withWaitingLock(root, () => {
    const entries = readWaiting(root).filter((entry) => entry.session !== session);
    writeJsonAtomic(waitingFile(root), { entries });
    return { version: FEED_VERSION };
  });
}

function listWaiting(root) {
  return { version: FEED_VERSION, waiting: readWaiting(root) };
}

function isWaitingId(id) {
  return String(id || '').startsWith(WAITING_PREFIX);
}

function waitingCards(root) {
  return readWaiting(root).map((entry) => baseCard({
    id: `${WAITING_PREFIX}${encodeURIComponent(entry.session)}`,
    kind: 'question',
    source: { type: 'session', id: entry.session },
    author: { id: `${WAITING_PREFIX}${entry.session}`, name: entry.title || 'Chat window', type: 'agent' },
    title: entry.title || 'A chat is waiting on you',
    body: entry.ask,
    why: 'This chat stopped and needs your answer.',
    state: 'pending',
    needs_decision: true,
    created_at: entry.created_at,
    _changed: Date.parse(entry.updated_at || entry.created_at),
  }));
}

// Each card's latest run, by task id. Read-only: liveness is a signal check.
function runsByTask(entries, alive = pidAlive) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry.task_id || (entry.kind || 'task') !== 'task') continue; // approved work only
    const status = entry.status === 'running' && !alive(entry.pid) ? 'ended' : entry.status;
    map.set(entry.task_id, { ...entry, status });
  }
  return map;
}

function queuePosition(entries, entry) {
  return entries.filter((e) => e.status === 'queued').findIndex((e) => e.id === entry.id) + 1;
}

// What waits goes in this order: approved work, then pings (a member woken to
// look for ideas), then old-style idea rounds. Within one kind, first in line first.
const RUN_PRIORITY = { task: 0, ping: 1, ideas: 2 };

function nextInLine(entries, running) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.status === 'queued'
      && !running.some((r) => r.member === entry.member)
      && !(entry.kind === 'ideas' && running.some((r) => r.kind === 'ideas')))
    .sort((a, b) => (RUN_PRIORITY[a.entry.kind || 'task'] ?? 3) - (RUN_PRIORITY[b.entry.kind || 'task'] ?? 3) || a.index - b.index)
    .map(({ entry }) => entry)[0] || null;
}

// Start what may start: at most FEED_MAX_RUNNING running at once, one run per
// member, and one idea round at a time. Everything else waits in order.
function pump(root, deps = {}) {
  const alive = deps.isAlive || pidAlive;
  const spawnRunner = deps.spawnRunner || defaultSpawnRunner;
  const limit = deps.maxRunning ?? FEED_MAX_RUNNING;
  return withQueueLock(root, () => {
    const entries = readRunsForWrite(root);
    const fixed = reconcileRuns(root, entries, { alive, deps });
    const started = [];
    for (;;) {
      const running = entries.filter((e) => e.status === 'running');
      if (running.length >= limit) break;
      const next = nextInLine(entries, running);
      if (!next) break;
      try {
        next.pid = spawnRunner(root, next);
        next.status = 'running';
        next.started_at = nowIso();
        started.push(next.id);
      } catch (error) {
        next.status = 'failed_to_start';
        next.error = oneLine(error.message).slice(0, 300);
        next.ended_at = nowIso();
      }
    }
    writeJsonAtomic(runsFile(root), { version: 1, entries: keepRuns(entries) });
    return { started, entries, fixed };
  });
}

// One live entry per key.
// The last 200 runs, but never one that is still waiting or running.
function keepRuns(entries) {
  const live = entries.filter((e) => e.status === 'queued' || e.status === 'running');
  const done = entries.filter((e) => !(e.status === 'queued' || e.status === 'running'));
  const kept = new Set([...live, ...done.slice(-Math.max(0, 200 - live.length))]);
  return entries.filter((e) => kept.has(e));
}

function enqueue(root, entry, { alive = pidAlive } = {}) {
  return withQueueLock(root, () => {
    const entries = readRunsForWrite(root);
    const live = (e) => e.status === 'queued' || (e.status === 'running' && alive(e.pid));
    // Only a run still waiting or running counts as the same: approved work
    // starts once per decision (the decision itself is taken only once), and
    // work that came back and was approved again gets a new run.
    const same = entry.key && entries.find((e) => e.key === entry.key && live(e));
    if (same) return { entry: same, added: false };
    const full = {
      id: crypto.randomBytes(6).toString('hex'),
      status: 'queued',
      queued_at: nowIso(),
      ...entry,
    };
    full.log = path.join('.atris', 'state', 'feed', 'logs', `${full.id}.log`);
    entries.push(full);
    writeJsonAtomic(runsFile(root), { version: 1, entries: keepRuns(entries) });
    return { entry: full, added: true };
  });
}

function cliBin() {
  return path.join(__dirname, '..', 'bin', 'atris.js');
}

// The runner is this CLI's own `feed run <entry>`, detached, so the command
// that approved returns at once and the runner starts the next in line when
// its member finishes.
// A run is its member's own session: an agent shell's markers are not passed
// on (a Claude Code marker would stop a member's own Claude from starting).
function runEnv(env = process.env) {
  const out = { ...env, NODE_NO_WARNINGS: '1' };
  for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete out[marker];
  return out;
}

function defaultSpawnRunner(root, entry) {
  // Under node --test only, a stand-in runner that records the start, so a
  // test of two processes at once can count starts without running members.
  if (process.env.NODE_TEST_CONTEXT && process.env.ATRIS_FEED_FAKE_RUNNER) {
    fs.appendFileSync(process.env.ATRIS_FEED_FAKE_RUNNER, `${entry.id} ${entry.card_id || entry.member}\n`);
    return process.ppid; // the test itself: alive while the test runs
  }
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [cliBin(), 'feed', 'run', entry.id], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: runEnv(),
  });
  child.unref();
  // A queued wake is a teammate thinking; approved work is not.
  if (entry.kind === 'ping') require('./feed-turns').noteLive(root, child.pid, 'think');
  return child.pid;
}

// The body of `feed run <entry>`. Approved work starts the member the way
// `atris member up` does (`atris member go <member>`), on the model in
// effect for it; a ping runs the member read-only and turns its answer into
// events (lib/feed-team.js runPing). Then the next in line starts.
async function runEntry(root, entryId, deps = {}) {
  // Read under the lock, so the pump that started this runner has saved it as
  // running. Only a run the pump started may go: nothing jumps the line.
  const entry = withQueueLock(root, () => readRuns(root).find((e) => e.id === entryId));
  if (!entry) throw new FeedError(404, 'That run is not in the feed queue.');
  if (entry.status !== 'running') throw new FeedError(409, 'That run is not the next in line, so it was not started.');
  let status = null;
  let settled = { status: 'ended' };
  if (entry.kind === 'ping') {
    try {
      const done = await require('./feed-team').runPing(root, entry, deps);
      status = done.ok ? 0 : 1;
    } catch {
      status = 1;
    }
  } else {
    const engine = require('./feed-team').memberEngine(root, entry.member, { purpose: 'work' });
    if (!engine.available) {
      settled = settleTask(root, entry, { reason: `${entry.member}'s model ${engine.name} cannot run here: ${engine.reason}` });
    } else if (engine.kind === 'cloud') {
      // An Atris cloud model has no tools on this computer, so `member go`
      // on it can never report a result: it writes its answer instead
      // (lib/feed-team.js runWriteWork).
      const done = await require('./feed-team').runWriteWork(root, entry, engine, deps);
      status = done.ok ? 0 : 1;
      settled = settleTask(root, entry, { reason: done.reason || 'The work ended without a result.', deps });
    } else {
      const logFile = path.join(root, entry.log);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const out = fs.openSync(logFile, 'a');
      const flags = entry.engine_source && entry.engine_source !== 'member' && entry.engine ? ['--engine', entry.engine] : [];
      const args = ['member', 'go', entry.member, '--json', ...flags, ...(entry.direction ? ['--', entry.direction] : [])];
      const limit = runLimitMs(entry);
      const startHead = (deps.gitHead || gitHead)(root);
      let run = {};
      try {
        run = (deps.spawnSync || require('child_process').spawnSync)(process.execPath, [cliBin(), ...args], {
          cwd: root,
          stdio: ['ignore', out, out],
          env: runEnvWithThisAtris(root),
          timeout: limit,
          killSignal: 'SIGTERM',
        }) || {};
        status = run.status;
      } finally {
        fs.closeSync(out);
      }
      const timedOut = Boolean(run.error && run.error.code === 'ETIMEDOUT') || (run.signal === 'SIGTERM' && status === null);
      settled = settleTask(root, entry, {
        startHead,
        reason: timedOut
          ? `The work stopped after ${Math.round(limit / 60000)} minutes without a result.`
          : memberSaid(logFile)
            ? `${entry.member} stopped without a result and said: ${memberSaid(logFile)}${keptCopy(logFile) ? ' Its changes are kept in the member\'s own copy.' : ''}`
            : `The work ended without a result${endedWhy(logFile)}.${keptCopy(logFile) ? ' Its changes are kept in the member\'s own copy.' : ''}`,
        timedOut,
        deps,
      });
    }
  }
  withQueueLock(root, () => {
    const entries = readRuns(root);
    const mine = entries.find((e) => e.id === entryId);
    if (mine) {
      mine.status = settled.status;
      mine.exit_code = status;
      mine.ended_at = nowIso();
      if (settled.reason) mine.reason = settled.reason;
    }
    writeJsonAtomic(runsFile(root), { version: 1, entries });
  });
  return pump(root, deps);
}

function gitHead(root) {
  try {
    const out = require('child_process').spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 });
    return out.status === 0 ? out.stdout.trim() : null;
  } catch {
    return null;
  }
}

// The lines a run changed in the project since it started, as a code visual:
// the biggest changed files first, the setup folders left out, cut to fit.
// When the main copy did not move, the work is in the member's own copy:
// its newest branch named for the member, made since the run started.
function memberWorkRef(root, member, since) {
  try {
    const out = require('child_process').spawnSync('git', ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads'], { cwd: root, encoding: 'utf8', timeout: 5000 });
    const after = Math.floor((Date.parse(since || '') || 0) / 1000) - 5;
    for (const line of String(out.stdout || '').split('\n')) {
      const [ref, at] = line.trim().split(' ');
      if (ref && Number(at) >= after && ref.split('/').pop().startsWith(`${member}-`)) return ref;
    }
  } catch {}
  return null;
}

function diffVisual(root, startHead, { member = '', since = null } = {}) {
  try {
    const cp = require('child_process');
    const moved = gitHead(root) !== startHead;
    const ref = moved ? 'HEAD' : (member && memberWorkRef(root, member, since));
    if (!ref) return null;
    const range = [startHead, ref];
    const exclude = [':(exclude)atris', ':(exclude).atris', ':(exclude)*.lock', ':(exclude)package-lock.json'];
    const stat = cp.spawnSync('git', ['diff', '--numstat', ...range, '--', '.', ...exclude], { cwd: root, encoding: 'utf8', timeout: 10000 });
    if (stat.status !== 0 || !stat.stdout.trim()) return null;
    const files = stat.stdout.trim().split('\n').map((line) => line.split('\t'))
      .filter((parts) => parts.length === 3 && parts[0] !== '-')
      .sort((a, b) => (Number(b[0]) + Number(b[1])) - (Number(a[0]) + Number(a[1])))
      .slice(0, 2).map((parts) => parts[2]);
    if (!files.length) return null;
    const diff = cp.spawnSync('git', ['diff', '--unified=1', '--no-color', ...range, '--', ...files], { cwd: root, encoding: 'utf8', timeout: 10000 });
    if (diff.status !== 0) return null;
    const lines = diff.stdout.split('\n').filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line));
    let code = '';
    for (const line of lines) {
      if (Buffer.byteLength(code + line + '\n') > 3800) break;
      code += `${line}\n`;
    }
    code = code.trim();
    if (!code) return null;
    const { checkVisual } = require('./feed-visuals');
    return checkVisual({ kind: 'code', language: 'diff', code, caption: files.length === 1 ? 'The lines that changed' : 'The lines that changed, in the two biggest files' });
  } catch {
    return null;
  }
}

// Member runs call `atris feed ...` (emit, talk, propose). They get this
// same atris first on their path, not whatever older one is installed, which
// would not know the feed at all.
function runEnvWithThisAtris(root) {
  const env = runEnv();
  try {
    const dir = path.join(root, '.atris', 'state', 'feed', 'bin');
    const shim = path.join(dir, 'atris');
    const body = `#!/bin/sh\nexec "${process.execPath}" "${cliBin()}" "$@"\n`;
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(shim) || fs.readFileSync(shim, 'utf8') !== body) fs.writeFileSync(shim, body, { mode: 0o755 });
    env.PATH = `${dir}${path.delimiter}${env.PATH || ''}`;
  } catch {}
  return env;
}

// How long one run may take before it is stopped.
function runLimitMs(entry, env = process.env) {
  const minutes = Number.parseFloat(env[entry.kind === 'ping' ? 'ATRIS_FEED_PING_LIMIT_MINUTES' : 'ATRIS_FEED_WORK_LIMIT_MINUTES']);
  const fallback = entry.kind === 'ping' ? 6 : 45;
  return Math.max(1000, (Number.isFinite(minutes) && minutes > 0 ? minutes : fallback) * 60000);
}

// Why approved work ended with nothing, in a few words after a colon, or ''.
// The run's log may end on a status code (`tick-ok`): a known one is said in
// words, an unknown one says nothing, and an exit number is never shown.
const ENDED_WORDS = {
  'tick-ok': 'the teammate took a step but wrote no result',
  'wall-exceeded-during-tick': 'it ran out of time',
  'rate-limited': 'the model was busy, so try again later',
  'quiet-hours': 'the team is resting for the night',
  'no-ready-engine': 'no model could run it on this computer',
  'runtime-not-codex': 'no model could run it on this computer',
  'skipped-llm-not-configured': 'no model is set up yet',
  'session-lock-busy': 'another run was already working on it',
  'session-lock-busy-retry': 'another run was already working on it',
  'loop-already-active': 'another run was already working on it',
  'verify-did-not-run': 'its check did not run',
  'verifier-not-passed': 'its check did not pass',
  'proof-not-successful': 'its check did not pass',
  'commit-failed': 'its changes could not be saved',
  'push-rejected': 'its changes could not be sent',
  'workspace-dirty-in-member-scope': 'unsaved changes in the project were in its way',
  'member-archived': 'the teammate was retired',
  'mission-not-found': 'its job could not be found',
  'dry-run': 'it was only a trial run',
};

function endedWhy(file) {
  const why = oneLine(lastLogLine(file));
  if (!why) return '';
  if (/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/i.test(why)) {
    const words = ENDED_WORDS[why.toLowerCase().replace(/_/g, '-')];
    return words ? `: ${words}` : '';
  }
  // A sentence the person can read as it is; anything else stays in the log.
  return /\s/.test(why) && isPlainWords(why) ? `: ${why.replace(/[.!]+$/, '')}` : '';
}

// The member's own last words about work that ended with nothing to show,
// so the card says why in its voice instead of a machine reason.
// A summary that is only a model's name ("Atris 2 Fast", the banner a tool
// prints first) is not words the member said, so it is skipped.
function memberSaid(file) {
  try {
    const summaries = /"summary":"((?:[^"\\]|\\.){3,600})"/g;
    const text = fs.readFileSync(file, 'utf8').slice(-12000);
    for (let found = summaries.exec(text); found; found = summaries.exec(text)) {
      let said = '';
      try { said = oneLine(JSON.parse(`"${found[1]}"`)).slice(0, 400); } catch { continue; }
      if (said && !isEngineName(said) && isPlainWords(said)) return said;
    }
    return '';
  } catch {
    return '';
  }
}

function isEngineName(text) {
  const said = String(text || '').trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ').toLowerCase();
  if (/^atris(?: ?\d+(?:\.\d+)?)?(?: (?:fast|pro|max|rapid|alpha|mercury|code fast|agent-1))?$/.test(said)) return true;
  const team = require('./feed-team');
  const names = [
    ...team.CLOUD_ENGINES.flatMap((engine) => [engine.id, engine.name, engine.model]),
    ...Object.entries(team.ENGINE_NAMES).flat(),
  ];
  return names.some((name) => String(name || '').toLowerCase() === said);
}

// Whether the run left its work in the member's own copy of the project.
function keptCopy(file) {
  try {
    return /"worktree_branch":"[^"]+"/.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function lastLogLine(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const reason = /"reason":"([^"]{3,200})"/.exec(text.slice(-4000));
    if (reason) return reason[1];
    const lines = text.trim().split('\n').map((line) => line.trim()).filter(Boolean);
    return (lines[lines.length - 1] || '').slice(0, 200);
  } catch {
    return '';
  }
}

// After approved work stops, the card says what really happened. A result the
// member wrote (the task went to review or done) is kept. Work a member's own
// mission still carries on is left to it. Anything else goes back to the
// person: the approval is taken back, the card waits again with the plain
// reason, and nothing it had (messages, progress, notes) is lost.
function settleTask(root, entry, { reason, timedOut = false, deps = {}, startHead = null } = {}) {
  const tdb = taskDb();
  const db = openWrite();
  const row = tdb.getTask(db, entry.task_id);
  if (!row) return { status: 'ended', reason: 'the task is gone' };
  if (['review', 'done'].includes(row.status)) {
    // Finished code work shows its key changed lines when the member brought
    // no picture of its own: the real lines from the project, never made up.
    if (startHead && !feedOf(obj(row.metadata)).result_visual) {
      const visual = (deps.diffVisual || diffVisual)(root, startHead, { member: entry.member, since: entry.started_at });
      if (visual) {
        tdb.updateTaskMetadata(db, row.id, (metadata) => {
          metadata.feed = { ...obj(metadata.feed), result_visual: visual };
          return metadata;
        });
      }
    }
    return { status: 'ended', reason: 'finished with a result' };
  }
  if (row.status === 'archived' || row.status === 'failed') return { status: 'ended', reason: `the task is ${row.status}` };
  if (!timedOut && memberStillWorking(root, entry, row, deps)) return { status: 'handed_off', reason: "the member's own mission carries on" };
  returnToWaiting(root, db, { ...row, metadata: obj(row.metadata) }, entry, reason);
  return { status: timedOut ? 'timed_out' : 'failed', reason };
}

function memberStillWorking(root, entry, row, deps) {
  if (deps.memberStillWorking) return deps.memberStillWorking(entry, row);
  try {
    const coreLib = require('./member-core');
    const live = coreLib.memberLiveMission(entry.member, coreLib.memberRunMissionMap(root));
    return Boolean(live && (live.task_ids || []).includes(row.id));
  } catch {
    return false;
  }
}

function returnToWaiting(root, db, row, entry, reason) {
  const tdb = taskDb();
  if (row.status === 'claimed') {
    try { tdb.releaseTask(db, { id: row.id, actor: row.claimed_by || entry.member, reason }); } catch {}
  }
  const id = entry.card_id;
  tdb.updateTaskMetadata(db, row.id, (metadata) => {
    const feed = obj(metadata.feed);
    const decisions = { ...obj(feed.decisions) };
    const taken = decisions[id];
    delete decisions[id];
    const tags = Array.isArray(metadata.tags) ? metadata.tags.slice() : [];
    if (feed.gate === 'before_start' && !tags.includes('needs-human')) tags.push('needs-human');
    metadata.tags = tags;
    metadata.feed = {
      ...feed,
      decisions,
      history: [...(Array.isArray(feed.history) ? feed.history : []), { ...obj(taken), ended: reason, ended_at: nowIso() }].slice(-10),
      last_failure: { reason, at: nowIso() },
    };
    return metadata;
  });
  try { db.prepare('DELETE FROM task_events WHERE event_id = ?').run(decisionEventId(root, id)); } catch {}
  require('./feed-team').logMember(root, entry.member, 'The work did not finish and went back to the owner', { card: id, reason });
}

// Runs whose process is gone (the app or the computer restarted) or that ran
// past their limit. Runs under the queue lock, from pump and from repair.
function reconcileRuns(root, entries, { alive = pidAlive, deps = {}, now = Date.now() } = {}) {
  const fixed = [];
  for (const entry of entries) {
    if (entry.status !== 'running') continue;
    const overLimit = entry.started_at && now - Date.parse(entry.started_at) > runLimitMs(entry) + 60000;
    const living = alive(entry.pid);
    if (living && !overLimit) continue;
    if (living && overLimit) {
      try { process.kill(-entry.pid, 'SIGTERM'); } catch { try { process.kill(entry.pid, 'SIGTERM'); } catch {} }
    }
    let settled = { status: 'ended' };
    if ((entry.kind || 'task') === 'task' && entry.task_id) {
      settled = settleTask(root, entry, {
        reason: overLimit ? `The work stopped after ${Math.round(runLimitMs(entry) / 60000)} minutes without a result.`
          : 'The work stopped before it finished (the app or the computer restarted).',
        timedOut: overLimit,
        deps,
      });
    }
    entry.status = settled.status;
    entry.reason = settled.reason || entry.reason;
    entry.ended_at = nowIso();
    fixed.push({ run: entry.id, kind: entry.kind || 'task', member: entry.member, now: entry.status, reason: entry.reason || null });
  }
  return fixed;
}

// ------------------------------------------------------------- cards

function feedOf(meta) {
  return obj(meta.feed);
}

function isIdea(meta) {
  return feedOf(meta).gate === 'before_start';
}

function isHeld(row) {
  return isDecisionTask({ ...row, metadata: row.metadata });
}

function cardId(taskId, kind, attempt = 1) {
  return `task:${taskId}:${attempt}:${kind}`;
}

function parseCardId(id) {
  const parts = String(id || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'task' || !parts[1] || !/^\d+$/.test(parts[2])) {
    throw new FeedError(404, 'Card not found');
  }
  return { taskId: parts[1], attempt: Number(parts[2]), kind: parts[3] };
}

function decisionOf(meta, id) {
  const record = obj(obj(feedOf(meta).decisions)[id]);
  return record.choice ? record : null;
}

// standing: true only when the standing yes approved it, not the person.
function decisionView(record) {
  if (!record) return null;
  return { choice: record.choice, by: record.by || null, at: record.at || null, note: record.note || null, ...(record.standing ? { standing: true } : {}) };
}

function plainStory(value) {
  if (!Array.isArray(value)) return null;
  const lines = value.map(oneLine).filter(Boolean).slice(0, STORY_MAX_LINES);
  if (!lines.length || lines.some((line) => line.length > STORY_LINE_MAX || !isPlainWords(line))) return null;
  return lines;
}

function sentencesOf(text) {
  return oneLine(text).split(/(?<=[.!?])\s+(?=\S)/).map((s) => s.trim()).filter(Boolean);
}

// The first sentence of text that a person can read as it is, or ''.
function firstPlainSentence(text) {
  if (typeof text !== 'string') return '';
  return sentencesOf(text).find((s) => s.length <= PROPOSAL_TITLE_MAX && isPlainWords(s)) || '';
}

// Plain words for a finished or failed task whose own title is not plain:
// the result it reported (for a failed one, its error, only when all of it is
// plain), then what done looks like, its finish line or why it matters, as the
// task record carries them (`atris task ready --result`, `atris task new
// --done-looks-like / --why-it-matters`). '' when none reads plain.
function resultTitle(meta, failed) {
  if (failed) {
    const raw = meta.last_error || meta.failure_reason || '';
    const error = typeof raw === 'string' ? oneLine(raw) : '';
    const first = sentencesOf(error)[0] || '';
    if (error && isPlainWords(error) && first.length <= PROPOSAL_TITLE_MAX) return first;
  } else {
    const said = firstPlainSentence(meta.result);
    if (said) return said;
  }
  const { explicitExplanationFields } = require('./task-explanation');
  const explained = explicitExplanationFields(meta);
  for (const text of [explained.done_looks_like, meta.exit_condition, explained.why_it_matters]) {
    const line = firstPlainSentence(text);
    if (line) return line;
  }
  return '';
}

// Make a card safe to show, as the cloud feed does: a plain title and body,
// the member's own plain story lines if it wrote any, and raw text kept in
// detail. No model is asked here.
// altTitle: plain words from the task record to use before the generic title.
// A card left with only the generic title says so in _unreadable.
function present(card, { rawTitle, rawBody, detail, why, story, visual, fallbackKey, altTitle = '', root = null }) {
  const title = String(rawTitle || '').trim();
  const body = String(rawBody || '').trim();
  const titleOk = isPlainWords(title);
  const bodyOk = isPlainWords(body);
  const lines = plainStory(story) || [];
  const detailParts = [String(detail || '').trim()];
  if (!titleOk) detailParts.push(title);
  if (!bodyOk) detailParts.push(body);
  const fallback = FALLBACK_TITLES[fallbackKey] || FALLBACK_TITLES['result:done'];
  card.title = titleOk && title ? title : (lines[0] || altTitle || fallback);
  card._unreadable = !(titleOk && title) && !lines[0] && !altTitle;
  card.body = bodyOk ? body : lines.join(' ');
  if (altTitle && card.title === altTitle && card.body === altTitle) card.body = ''; // the title already says it
  card.why = oneLine(why) || null;
  card.detail = detailParts.filter(Boolean).join('\n\n') || null;
  card.story = lines;
  card.visual = safeVisual(visual, { root }); // checked again on every read; dropped if it no longer passes
  if (card.why && !isPlainWords(card.why)) {
    card.detail = [card.detail, card.why].filter(Boolean).join('\n\n');
    card.why = null;
  }
  return card;
}

function baseCard(fields) {
  return {
    backers: [],
    backer_count: 0,
    message_count: 0,
    last_message_at: null,
    revised_at: null,
    decision: null,
    proof: { status: 'none', checks: [], uri: null },
    attempt: 1,
    result_of: null,
    guarded_lane: null,
    run: null,
    reactions: [],
    replies: [],
    reply_count: 0,
    ...fields,
  };
}

function progressLines(feed) {
  const lines = (Array.isArray(feed.progress) ? feed.progress : []).map((p) => obj(p).text).filter(Boolean);
  return lines.length ? lines.slice(-3) : null;
}

function lastProgress(feed) {
  const list = Array.isArray(feed.progress) ? feed.progress : [];
  const last = obj(list[list.length - 1]);
  return last.text ? { text: last.text, at: last.at || null } : null;
}

function laneOfTask(row) {
  const declared = String(feedOf(row.metadata).lane || '').trim().toLowerCase();
  if (GUARDED_LANES.includes(declared)) return declared;
  return protectedLaneOf(row) || null;
}

function runView(run, entries) {
  if (!run) return null;
  const view = { status: run.status, queued_at: run.queued_at || null, started_at: run.started_at || null };
  if (run.status === 'queued') view.position = queuePosition(entries, run);
  // While it runs: how many minutes it may take before it is stopped (runLimitMs), so the card can say when it ends.
  if (run.status === 'running') view.limit_minutes = runLimitMs(run) / 60000;
  return view;
}

// What happened on a card, oldest first: each approve, when the work started, every plain line the teammate wrote,
// and each try that came back with its reason. Built only from what is saved, never invented. `by` is "you" or the
// teammate's name; the words never repeat it, so a screen can put the name in front.
const TRAIL_KEEP = 20;
function trailOf(feed, record, run, author) {
  const items = [];
  const add = (at, by, text, kind) => { if (at && text) items.push({ at, by, text, kind }); };
  const doer = slugOf(author) || null;
  for (const h of (Array.isArray(feed.history) ? feed.history : []).map(obj)) {
    if (h.choice === 'approve') add(h.at, 'you', 'You approved it.', 'you');
    if (h.ended) add(h.ended_at, doer, `Stopped without finishing. ${oneLine(h.ended).slice(0, 300)}`, 'miss');
  }
  if (record && record.choice === 'approve') add(record.at, 'you', 'You approved it.', 'you');
  if (run && run.started_at) add(run.started_at, doer, 'Started.', 'start');
  for (const p of (Array.isArray(feed.progress) ? feed.progress : []).map(obj)) add(p.at, p.by || doer, oneLine(p.text), 'step');
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return items.slice(-TRAIL_KEEP);
}

function stateAfterDecision(row, record, run) {
  if (record.choice === 'dismiss' || row.status === 'archived') return 'done';
  if (row.status === 'done') return 'done';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'claimed' || run?.status === 'running') return 'working';
  // Finished and waiting for the person's ok: the ok card asks for it, so this one is no longer work under way.
  if (row.status === 'review') return 'done';
  return 'pending'; // approved, waiting in line or for someone to pick it up
}

// A claim nothing has moved for a day, with no run of the feed's going for it: whoever took it stopped. The card
// keeps its place but says so, so work that looks under way is never only a claim.
const STILL_AFTER_MS = 24 * 60 * 60 * 1000;
function stillSince(row, run, feed, now = Date.now()) {
  if (row.status !== 'claimed' || (run && ['running', 'queued'].includes(run.status))) return null;
  const last = Math.max(Number(row.updated_at) || 0, Date.parse((lastProgress(feed) || {}).at || '') || 0);
  return last && now - last > STILL_AFTER_MS ? last : null;
}

function stillWords(ms) {
  return `Nothing has moved on this since ${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`;
}

function threadFields(card, meta) {
  const thread = obj(feedOf(meta).thread);
  card.message_count = Number(thread.message_count) || 0;
  card.last_message_at = thread.last_message_at || null;
  card.reply_pending = thread.reply_pending === true;
}

// Zero to three cards for one task: the decision it waits on (an idea or a
// question), the ok it waits on once finished, and the finished result.
function buildTaskCards(row, ctx = {}) {
  const meta = row.metadata;
  const feed = feedOf(meta);
  const title = meta.mission_id ? row.title.replace(/^Mission XP:\s+/, '') : row.title;
  if (feed.hidden) return [];
  const entries = ctx.entries || [];
  const run = (ctx.runs && ctx.runs.get(row.id)) || null;
  const lane = laneOfTask(row);
  const assignee = String(meta.assigned_to || '').trim();
  const cards = [];
  const changed = Math.max(Number(row.updated_at) || 0, Date.parse(run?.started_at || run?.queued_at || '') || 0);

  // 1. The idea or question.
  const openAsk = obj(feed.ask).text && !obj(feed.ask).answered_at;
  const idea = isIdea(meta);
  const ideaKind = feed.card_kind === 'question' ? 'question' : idea ? 'proposal' : 'question';
  const ideaId = cardId(row.id, ideaKind);
  const ideaRecord = decisionOf(meta, ideaId);
  const heldNow = !idea && isHeld(row) && ['open', 'claimed'].includes(row.status);
  let ideaCard = null;
  if (idea || ideaRecord || heldNow || openAsk) {
    const pending = Boolean(openAsk) || (!ideaRecord && (idea ? row.status === 'open' : heldNow));
    let state;
    if (pending) state = 'pending';
    else if (ideaRecord) state = stateAfterDecision(row, ideaRecord, run);
    else state = ['done', 'archived', 'review'].includes(row.status) ? 'done' : row.status === 'failed' ? 'failed' : 'working';
    // Held work is shown as what it is: by the member who does it once approved (as approve hands it over), with
    // why it matters and what done looks like, from the task record (`atris task new --why-it-matters
    // --done-looks-like`), in the why line and the numbered plan.
    const holder = !idea ? slugOf(feed.author || meta.assigned_to || '') : '';
    const doer = holder && teamMembers(row.workspace_root).includes(holder) ? memberRef(holder) : '';
    const author = idea ? (feed.author || memberRef(assignee)) : doer || memberRef(assignee || row.claimed_by) || null;
    const explained = idea ? {} : require('./task-explanation').explicitExplanationFields(meta);
    const plan = idea || state !== 'pending' ? null
      : sentencesOf(explained.done_looks_like || (typeof meta.exit_condition === 'string' ? meta.exit_condition : ''))
        .filter((line) => line.length <= STORY_LINE_MAX && isPlainWords(line)).slice(0, STORY_MAX_LINES);
    ideaCard = present(baseCard({
      id: ideaId,
      kind: ideaKind,
      source: { type: 'task', id: row.id },
      author: member(author),
      created_at: iso(row.created_at),
      state,
      needs_decision: pending,
      decision: openAsk ? null : decisionView(ideaRecord),
      guarded_lane: lane,
      run: runView(run, entries),
      _subject: idea ? 'idea' : 'hold',
      _changed: changed,
    }), {
      rawTitle: title,
      rawBody: idea ? feed.body : (meta.objective || ''),
      detail: feed.detail,
      why: openAsk ? feed.ask.text : feed.why || (idea ? null : firstPlainSentence(explained.why_it_matters)),
      // Work under way shows the member's own progress lines (feed emit progress); held work waiting, what done looks like.
      story: state === 'working' ? progressLines(feed) : plan && plan.length ? plan : null,
      visual: feed.visual,
      fallbackKey: idea ? ideaKind : 'hold',
      altTitle: idea ? '' : resultTitle(meta, false),
      root: row.workspace_root,
    });
    // A teammate's question: answered in the comments, never approved (decisionBlock).
    if (openAsk) { ideaCard._asks = true; ideaCard._openHelperAsk = true; }
    else if (idea && ideaKind === 'question') ideaCard._asks = true;
    // Held work whose title had to come from its plan does not say that line twice.
    if (plan && plan.length && ideaCard.story[0] === ideaCard.title) ideaCard.story = ideaCard.story.slice(1);
    ideaCard.progress = lastProgress(feed);
    const still = state === 'working' ? stillSince(row, run, feed, ctx.now) : null;
    if (still) {
      ideaCard.progress = { text: stillWords(still), at: iso(still) };
      ideaCard.still_since = iso(still);
    }
    // One short plain phrase on what in the project sparked it.
    ideaCard.sparked_by = feed.sparked_by && isPlainWords(feed.sparked_by) ? feed.sparked_by : null;
    // Approved work that did not finish came back: the card says why.
    ideaCard.last_failure = pending && feed.last_failure ? { reason: obj(feed.last_failure).reason || null, at: obj(feed.last_failure).at || null } : null;
    // Which try this is: every earlier approve that came back without finishing is a miss, kept with its reason.
    // The card id stays the same, so the card keeps its place.
    const misses = (Array.isArray(feed.history) ? feed.history : []).map(obj).filter((h) => h.ended)
      .map((h) => ({ reason: oneLine(h.ended).slice(0, 300), at: h.ended_at || null }));
    ideaCard.attempt = misses.length + 1;
    ideaCard.misses = misses;
    ideaCard.trail = trailOf(feed, ideaRecord, run, author);
    const backers = (Array.isArray(feed.backers) ? feed.backers : [])
      .filter((b) => b && b.member_id && b.member_id !== feed.author)
      .map((b) => ({ id: b.member_id, name: member(b.member_id).name }));
    ideaCard.backers = backers;
    ideaCard.backer_count = backers.length;
    threadFields(ideaCard, meta);
    ideaCard.revised_at = feed.revised_at || null;
    cards.push(ideaCard);
  }

  // 2. Finished work waiting for a person's ok (review), or the ok given.
  const acceptId = cardId(row.id, 'accept');
  const acceptRecord = decisionOf(meta, acceptId);
  const ideaDismissed = ideaRecord && ideaRecord.choice === 'dismiss';
  if ((row.status === 'review' || acceptRecord) && !ideaDismissed) {
    const pending = row.status === 'review' && !acceptRecord;
    const state = pending ? 'pending' : stateAfterDecision(row, acceptRecord, run);
    cards.push(present(baseCard({
      id: acceptId,
      kind: 'question',
      source: { type: 'task', id: row.id },
      author: member(memberRef(assignee || row.claimed_by) || meta.result_by || null),
      created_at: iso(meta.ready_at ? Date.parse(meta.ready_at) : row.updated_at),
      state,
      needs_decision: pending,
      decision: decisionView(acceptRecord),
      guarded_lane: lane,
      result_of: ideaCard && ideaRecord && ideaRecord.choice === 'approve' ? ideaCard.id : null,
      _subject: 'accept',
      _row: row,
      _changed: changed,
    }), {
      rawTitle: title,
      rawBody: meta.result || '',
      detail: meta.latest_agent_proof,
      why: null,
      story: feed.story || meta.story,
      visual: feed.result_visual,
      fallbackKey: 'accept',
      // Finished work waiting for an ok says what was done before it falls back to the generic line.
      altTitle: resultTitle(meta, false),
      root: row.workspace_root,
    }));
    threadFields(cards[cards.length - 1], meta);
  }

  // 3. The result, once done or failed.
  const dismissed = ideaDismissed || (acceptRecord && acceptRecord.choice === 'dismiss');
  const ideaApproved = ideaRecord && ideaRecord.choice === 'approve';
  const resultEligible = !dismissed && (!ideaCard || ideaApproved || !ideaRecord && !idea);
  if (resultEligible && (row.status === 'done' || row.status === 'failed') && !(ideaCard && ideaCard.needs_decision)) {
    const failed = row.status === 'failed';
    const card = present(baseCard({
      id: cardId(row.id, 'result'),
      kind: 'result',
      source: { type: 'task', id: row.id },
      author: member(memberRef(assignee || row.claimed_by || meta.result_by) || null),
      created_at: iso(row.done_at || row.updated_at),
      state: failed ? 'failed' : 'done',
      needs_decision: false,
      guarded_lane: lane,
      result_of: ideaApproved ? ideaCard.id : null,
      _subject: 'result',
      _row: row,
      _failed: failed,
      _changed: changed,
    }), {
      rawTitle: title,
      rawBody: failed ? (meta.last_error || meta.failure_reason || '') : (meta.result || ''),
      detail: meta.latest_agent_proof,
      why: null,
      story: feed.story || meta.story,
      visual: feed.result_visual,
      fallbackKey: failed ? 'result:failed' : 'result:done',
      altTitle: resultTitle(meta, failed),
      root: row.workspace_root,
    });
    cards.push(card);
  }

  // 4. Work in flight that never needed a decision.
  if (!cards.length && row.status === 'claimed') {
    cards.push(present(baseCard({
      id: cardId(row.id, 'update'),
      kind: 'update',
      source: { type: 'task', id: row.id },
      author: member(memberRef(row.claimed_by) || null),
      created_at: iso(row.claimed_at || row.updated_at),
      state: 'working',
      needs_decision: false,
      guarded_lane: lane,
      _subject: 'update',
      _changed: changed,
      // Work the feed itself started and is still running or waiting to start.
      _live: Boolean(run && (run.status === 'running' || run.status === 'queued')),
    }), {
      rawTitle: title,
      rawBody: '',
      detail: meta.objective,
      why: null,
      story: progressLines(feed) || feed.story,
      visual: null,
      fallbackKey: 'update',
      root: row.workspace_root,
    }));
    const still = stillSince(row, run, feed, ctx.now);
    const update = cards[cards.length - 1];
    update.progress = lastProgress(feed);
    if (still) {
      update.progress = { text: stillWords(still), at: iso(still) };
      update.still_since = iso(still);
    }
  }
  const views = obj(meta[VIEWS_KEY]);
  const lastMessage = Date.parse(obj(feed.thread).last_message_at || '') || 0;
  for (const card of cards) {
    // Its newest activity, for the fresh rule: never a pass or a read.
    card._activity = Math.max(changed, Date.parse(card.created_at || '') || 0, lastMessage);
    card._views = obj(views[card.id]);
    viewChanged(card);
  }
  return cards;
}

// A teammate's question the person has answered with a comment no longer needs them. One answer settles it: the
// teammate asking again later does not bring it back, and a reaction is not an answer. From then on it is talk,
// like a team note (laneOf, offMain). Read paths that carry the room's social file call this; deciding does not,
// so the person can still dismiss it or talk on it.
function settleAnswered(card, social) {
  if (!card || !card._asks || !card.needs_decision || !social || card._openHelperAsk) return card;
  if (require('./feed-room').personCommented(social, card.id, Date.parse(card.created_at || '') || 0)) {
    card.needs_decision = false;
    card._answered = true;
  }
  return card;
}

// Which shelf a card sits on, for everyone. The same rule as the cloud feed's
// lane_of: approved work waiting in line counts as working.
function laneOf(card) {
  if (card.kind === 'post' || card.kind === 'ask') return 'room'; // a team note: nothing to decide or read off
  if (card._answered && !card.decision) return 'room'; // a question the person answered (settleAnswered)
  const choice = card.decision && card.decision.choice;
  if (choice === 'dismiss') return 'dismissed';
  if (card.state === 'working' || ((choice === 'approve' || choice === 'adjust') && card.state === 'pending')) return 'working';
  if (card.needs_decision) return 'needs_decision';
  // A campaign's own card: with the work while it moves, else in the main list like a team note.
  if (card._subject === 'campaign') return 'room';
  if (card.kind === 'result') return 'result';
  return 'done'; // a decided idea whose work has ended
}

// A pass, a read or a dismissal taken back moves the card in a delta read.
// The person who hid a card never gets it there (listCards checks hiddenAt).
function viewChanged(card) {
  for (const entry of Object.values(obj(card._views))) {
    for (const at of [entry && entry.last_passed_at, entry && entry.seen_at, entry && entry.restored_at]) {
      card._changed = Math.max(card._changed || 0, Date.parse(at || '') || 0);
    }
  }
}

// When this person hid the card with `feed dismiss`, or null.
function hiddenAt(card, viewer) {
  return obj(obj(card._views)[viewer]).dismissed_at || null;
}

// Off the default list: finished work with nothing a person can read, and a
// card with nothing to decide and no work running whose newest activity is
// older than the fresh window. A waiting chat keeps its own rule.
function offMain(card, now, windowMs) {
  if (card.source?.type === 'session') return false;
  if (card.kind === 'result' && card._unreadable) return true;
  // Held work waiting for a yes with no words to show and nothing explaining it: under its filter only.
  if (card._subject === 'hold' && card._unreadable) return true;
  if (card.needs_decision) return false;
  const ages = card.kind === 'result' || card.kind === 'post' || card.kind === 'ask' || card._answered
    || (card.kind === 'update' && !card._live);
  return ages && now - (card._activity || 0) > windowMs;
}

// The cards still on the main list: what the team is shown to comment on, so
// nobody keeps answering a card that has already left it.
function onMain(cards, { env = process.env, now = Date.now() } = {}) {
  const windowMs = freshMs(env);
  return cards.filter((card) => !offMain(card, now, windowMs));
}

function freshMs(env = process.env) {
  const hours = Number(String(env.ATRIS_FEED_FRESH_HOURS ?? '').trim() || NaN);
  return (Number.isFinite(hours) && hours > 0 ? hours : FRESH_HOURS) * 60 * 60 * 1000;
}

// (passes, last_passed_at, seen_at) for this person. A revision after the
// last pass starts the count over, as in the cloud feed's viewer_state.
function viewerState(card, viewer) {
  const entry = obj(obj(card._views)[viewer]);
  let passes = Number.parseInt(entry.passes, 10) || 0;
  const last = entry.last_passed_at || null;
  if (passes && card.revised_at && Date.parse(card.revised_at) > (Date.parse(last || '') || 0)) passes = 0;
  return [passes, last, entry.seen_at || null];
}

// Where a card sits in this person's reading queue: idea, held (passed a
// moment ago), parked (passed three times), result (unread), seen, or its lane.
// A card this person hid with `feed dismiss` sits with the dismissed ones.
function placeOf(card, viewer, now = Date.now()) {
  if (card.source?.type === 'session') return 'waiting';
  const lane = laneOf(card);
  if (lane !== 'needs_decision' && hiddenAt(card, viewer)) return 'dismissed';
  const [passes, last, seen] = viewerState(card, viewer);
  if (lane === 'needs_decision') {
    if (passes >= PARK_AFTER_PASSES) return 'parked';
    if (passes && last && now - Date.parse(last) < PASS_HOLD_MINUTES * 60000) return 'held';
    return 'idea';
  }
  if (lane === 'result') return seen ? 'seen' : 'result';
  return lane;
}

function feedCounts(cards, viewer, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const places = cards.map((card) => placeOf(card, viewer, now.getTime()));
  const count = (...names) => places.filter((place) => names.includes(place)).length;
  return {
    needs_decision: count('waiting', 'idea', 'held'),
    working: count('working'),
    done_today: cards.filter((c) => c.kind === 'result' && c.state === 'done'
      && String(c.created_at || '').slice(0, 10) === today).length,
    parked: count('parked'),
    new_results: count('result'),
  };
}

// The cards of one list in reading order. The default list reads top to
// bottom and grows at the end: undecided ideas (never passed first, then
// fewest passes; oldest first within each), then unread results, oldest first.
function queueOf(cards, filter, viewer, now = Date.now()) {
  const placed = cards.map((card) => [placeOf(card, viewer, now), card]);
  const time = (card) => Date.parse(card.created_at || '') || 0;
  const newest = (items) => items.sort((a, b) => time(b) - time(a) || String(b.id).localeCompare(String(a.id)));
  const waiting = placed.filter(([place]) => place === 'waiting').map(([, card]) => card)
    .sort((a, b) => time(a) - time(b) || String(a.id).localeCompare(String(b.id)));
  // With few ideas to show, a passed idea comes back after a short rest
  // instead of the full half hour (still after the newer ones).
  let showable = placed.filter(([place]) => place === 'idea').length;
  if (showable < FEW_IDEAS) {
    for (const item of placed) {
      if (item[0] !== 'held') continue;
      const last = Date.parse(viewerState(item[1], viewer)[1] || '') || 0;
      if (now - last >= SHORT_HOLD_MINUTES * 60000) { item[0] = 'idea'; showable += 1; }
    }
  }
  // A reading queue that grows at the end: ideas never passed, in the order
  // they were made (oldest first), then passed ones back from their hold
  // (fewest passes, oldest first). A new idea always lands at the end, below
  // where the person is reading, never at the top.
  const ideas = placed.filter(([place]) => place === 'idea').map(([, card]) => card)
    .sort((a, b) => viewerState(a, viewer)[0] - viewerState(b, viewer)[0] || time(a) - time(b)
      || String(a.id).localeCompare(String(b.id)));
  const unread = placed.filter(([place]) => place === 'result').map(([, card]) => card)
    .sort((a, b) => time(a) - time(b) || String(a.id).localeCompare(String(b.id)));
  if (filter === 'all') {
    // The team's notes join in time order: each sits after every card older
    // than it, so a note never lands above an older card and a new one lands
    // at the end. Notes keep the order they were written in.
    const notes = placed.filter(([place]) => place === 'room').map(([, card]) => card).sort((a, b) => time(a) - time(b));
    // Keep the person's recent posts reachable after reopening the feed. The
    // ordinary queue can otherwise put a new post beyond its first page.
    const recentOwn = newest(notes.filter((card) => card.author?.id === viewer && now - time(card) < 24 * 60 * 60 * 1000)).slice(0, 3);
    const ownIds = new Set(recentOwn.map((card) => card.id));
    return [...waiting, ...recentOwn, ...withNotes([...ideas, ...unread], notes.filter((card) => !ownIds.has(card.id)), time)];
  }
  if (filter === 'needs_decision') return [...waiting, ...ideas];
  if (filter === 'done') return newest(placed.filter(([place]) => ['result', 'seen', 'done'].includes(place)).map(([, card]) => card));
  return newest(placed.filter(([place]) => place === filter).map(([, card]) => card));
}

// Notes (oldest first) placed into a list: each goes right after the last
// card in the list that is not newer than it.
function withNotes(cards, notes, time) {
  if (!notes.length) return cards;
  const slots = notes.map((note) => {
    let at = -1;
    cards.forEach((card, i) => { if (time(card) <= time(note)) at = i; });
    return at;
  });
  const out = [];
  let next = 0;
  while (next < notes.length && slots[next] < 0) out.push(notes[next++]);
  cards.forEach((card, i) => {
    out.push(card);
    while (next < notes.length && slots[next] <= i) out.push(notes[next++]);
  });
  while (next < notes.length) out.push(notes[next++]);
  return out;
}

// Why this caller cannot decide this card right now, as [status, reason], or null.
// choice: 'approve' (the default, what can_decide answers), 'dismiss', or 'talk'.
function decisionBlock(card, viewer, choice = 'approve') {
  if (card?.source?.type === 'session') return [409, WAITING_REASON];
  if (viewer.agent) return [403, `Only a person can decide. This is running inside an agent (${viewer.agent}).`];
  if (!card || !['proposal', 'question'].includes(card.kind)) return [409, 'There is nothing to decide on this card.'];
  if (card._openHelperAsk && choice === 'approve') return [409, QUESTION_REASON];
  if (card.decision) return [409, 'This card was already decided.'];
  if (card.state === 'working') return [409, 'Work on this card is already running.'];
  if (!card.needs_decision) return [409, 'This card is not waiting for a decision.'];
  if (card._asks && choice === 'approve') return [409, QUESTION_REASON];
  return null;
}

// The card as this person sees it. With the room's social file, its
// reactions (mine marked) and newest replies too.
function withViewer(card, viewer, social = null) {
  if (!card) return null;
  const block = decisionBlock(card, viewer);
  const out = {};
  for (const [key, value] of Object.entries(card)) if (!key.startsWith('_')) out[key] = value;
  const [passes, last, seen] = viewerState(card, viewer.person);
  const shown = {
    ...out,
    can_decide: !block,
    cannot_decide_reason: block ? block[1] : null,
    pass_count: passes,
    last_passed_at: last,
    seen: Boolean(seen),
    dismissed: Boolean(hiddenAt(card, viewer.person)), // hidden by this person with feed dismiss
  };
  return social ? require('./feed-room').decorate(shown, social, viewer.person) : shown;
}

// The cursor names the cards already sent, not a position, so the queue can
// change underneath (new ideas, passes, decisions) without a card repeating
// or being skipped. Same encoding as the cloud feed: 10 hex characters of
// each card id's sha256, joined, as url-safe base64.
function shortId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 10);
}

function encodeCursor(sent) {
  return Buffer.from([...sent].sort().join(''), 'hex').toString('base64url');
}

function decodeCursor(cursor) {
  const raw = Buffer.from(String(cursor), 'base64url').toString('hex');
  if (!raw || raw.length % 10 || !/^[A-Za-z0-9_-]+$/.test(String(cursor))) throw new FeedError(400, 'Invalid cursor');
  const sent = new Set();
  for (let i = 0; i < raw.length; i += 10) sent.add(raw.slice(i, i + 10));
  return sent;
}

function parseSince(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new FeedError(400, 'since must be a time like 2026-11-14T08:00:00Z or the next_since a list gave.');
  return ms;
}

function viewerOf(env) {
  return { agent: agentMarker(env), person: personId(env) };
}

// ------------------------------------------------------------- theme

function readTheme(root, viewer) {
  const { readScoreboard } = require('../commands/goal');
  const board = readScoreboard(root);
  return {
    text: board.goal_text || board.goal || null, // as the person typed it
    set_by: board.goal ? (board.set_by || null) : null,
    updated_at: board.goal ? (board.updated_at || null) : null,
    can_edit: !viewer.agent,
  };
}

// One plain sentence of at most 140 characters, as the cloud goal asks.
function cleanTheme(text) {
  const clean = oneLine(text);
  if (!clean) throw new FeedError(400, 'Write the goal as one sentence.', { field: 'text' });
  if (clean.length > THEME_MAX) throw new FeedError(400, `Keep the goal under ${THEME_MAX} characters.`, { field: 'text' });
  if (/[.!?]\s+\S/.test(clean)) throw new FeedError(400, 'Keep the goal to one sentence.', { field: 'text' });
  const jargon = plumbingWords(clean);
  if (jargon.length) throw new FeedError(400, 'Write the goal in plain words.', { field: 'text', remove: jargon });
  return clean;
}

function setTheme(root, text, { env = process.env } = {}) {
  const viewer = viewerOf(env);
  if (viewer.agent) throw new FeedError(403, `Only a person can set the goal. This is running inside an agent (${viewer.agent}).`);
  const clean = cleanTheme(text);
  const { readScoreboard, writeScoreboard } = require('../commands/goal');
  writeScoreboard({ ...readScoreboard(root), goal: clean, goal_text: clean }, root);
  return { version: FEED_VERSION, theme: readTheme(root, viewer) };
}

function themeText(root) {
  return readTheme(root, { agent: '' }).text;
}

// ------------------------------------------------------------- list

function loadCards(root, { env = process.env, rows = null } = {}) {
  let taskRows = rows;
  if (!taskRows) {
    const db = openReadOnly(env);
    try {
      taskRows = db ? readFeedRows(db, viewRoots(root)) : [];
    } finally {
      if (db) db.close();
    }
  }
  const entries = readRuns(root);
  const runs = runsByTask(entries);
  const cards = [];
  for (const row of taskRows) cards.push(...buildTaskCards(row, { runs, entries }));
  cards.push(...waitingCards(root));
  // Each campaign's own card and a question card for every ask still open (lib/campaign-feed.js).
  cards.push(...campaignFeed().cards(root, { env }));
  // The team's notes, and the reactions and replies on every card: a new
  // reaction or reply moves its card in a delta list.
  const room = require('./feed-room');
  const noteViews = room.readViews(root);
  for (const card of room.noteCards(root)) {
    card._views = obj(noteViews[card.id]);
    viewChanged(card);
    cards.push(card);
  }
  const social = room.readSocial(root);
  // A card whose comment became work moves when that work moves, so a delta read shows its new state there.
  const rowsById = new Map(taskRows.map((row) => [row.id, row]));
  const work = require('./feed-work');
  for (const card of cards) {
    settleAnswered(card, social);
    const talked = room.changedAt(social, card.id);
    const links = social[card.id] && social[card.id].work;
    const worked = links ? work.changedAt(links, rowsById) : 0;
    card._changed = Math.max(card._changed || 0, talked, worked);
    // Comments keep a card fresh only in the person's own conversation: a card
    // they wrote, commented on or reacted to. Teammates answering each other on
    // a card the person never touched do not hold it on the main list.
    const theirs = (card.author && card.author.type === 'user') || room.personIn(social, card.id);
    card._activity = Math.max(card._activity || Date.parse(card.created_at || '') || 0, theirs ? talked : 0, worked);
  }
  const nextSince = Math.max(
    taskRows.reduce((max, row) => Math.max(max, Number(row.updated_at) || 0), 0),
    cards.reduce((max, card) => Math.max(max, card._changed || 0), 0),
  );
  return { cards, rows: taskRows, entries, nextSince, social };
}

function campaignFeed() {
  return require('./campaign-feed');
}

function finishCard(root, card, index) {
  if (card._row && (card.kind === 'result' || card._subject === 'accept')) {
    card.proof = taskProof(root, card._row, index);
    if (card._failed) card.proof.status = 'unverified';
  }
  return card;
}

function listCards(root, { filter = 'all', limit = DEFAULT_LIMIT, cursor = null, since = null, env = process.env } = {}) {
  if (!FEED_FILTERS.includes(filter)) throw new FeedError(400, `filter must be one of: ${FEED_FILTERS.join(', ')}`);
  const size = Math.max(1, Math.min(MAX_FEED_LIMIT, Number.parseInt(limit, 10) || DEFAULT_LIMIT));
  const viewer = viewerOf(env);
  const sinceMs = parseSince(since);
  const loaded = loadCards(root, { env });
  const { nextSince, social } = loaded;
  const cleared = require('./feed-room').clearedAt(root);
  // Active work stays on its shelf; old feed cards stay out until they change.
  const every = filter === 'working' || !cleared ? loaded.cards : loaded.cards.filter((card) => (card._changed || 0) > cleared);
  const now = Date.now();
  const fresh = freshMs(env);
  // The default list and the delta leave out finished work nobody can read
  // and cards gone quiet for longer than the fresh window (offMain).
  const main = every.filter((card) => !offMain(card, now, fresh));
  // Counted as shown: cards the person cleared away stay out of the counts too. Working counts all live work.
  const counts = { ...feedCounts(every, viewer.person, new Date(now)), working: feedCounts(loaded.cards, viewer.person, new Date(now)).working };
  counts.new_results = main.filter((card) => placeOf(card, viewer.person, now) === 'result').length;
  let cards;
  if (sinceMs !== null) {
    // A delta: every card that changed after `since`, on any shelf, so the
    // screen can move it (a dismissed card arrives with its dismissal). A
    // card this person hid with `feed dismiss` does not come back here.
    cards = main.filter((card) => card._changed > sinceMs && !hiddenAt(card, viewer.person))
      .sort((a, b) => Number(b.source.type === 'session') - Number(a.source.type === 'session')
        || (a.source.type === 'session' ? Date.parse(a.created_at) - Date.parse(b.created_at) : b._changed - a._changed)
        || String(a.id).localeCompare(String(b.id)));
  } else {
    cards = queueOf(filter === 'all' ? main : every, filter, viewer.person, now);
  }
  const sent = cursor ? decodeCursor(cursor) : new Set();
  cards = cards.filter((card) => !sent.has(shortId(card.id)));
  const page = cards.slice(0, size);
  for (const card of page) sent.add(shortId(card.id));
  const index = page.some((card) => card._row) ? receiptIndex(root) : new Map();
  return {
    version: FEED_VERSION,
    theme: readTheme(root, viewer),
    counts,
    cards: page.map((card) => withViewer(finishCard(root, card, index), viewer, social)),
    next_cursor: cards.length > size && sent.size < CURSOR_MAX_SENT ? encodeCursor(sent) : null,
    next_since: String(Math.max(nextSince, sinceMs || 0)),
  };
}

// The person scrolled past these cards without choosing. Only an undecided
// card or a finished result takes a pass; passing a result marks it read.
// Kept per person in metadata.feed_views, the cloud feed's own key. Not
// task activity, so the task's updated time does not move.
// A card made in the last few seconds, or one the screen says was never on
// screen, is not passed: the person cannot have scrolled past it.
const PASS_MIN_AGE_MS = 10 * 1000;

function passCards(root, ids, { env = process.env, now = Date.now() } = {}) {
  const viewer = viewerOf(env);
  if (viewer.agent) throw new FeedError(403, `Only a person can pass a card. This is running inside an agent (${viewer.agent}).`);
  const items = (ids || []).map((item) => (item && typeof item === 'object' ? { id: String(item.id || ''), seen: item.seen !== false } : { id: String(item || ''), seen: true }));
  const unseen = new Set(items.filter((item) => !item.seen).map((item) => item.id));
  const list = [...new Set(items.map((item) => item.id).filter(Boolean))];
  if (!list.length) throw new FeedError(400, 'usage: atris feed pass <card> [<card> ...]');
  if (list.length > MAX_PASS_BATCH) throw new FeedError(413, `Pass at most ${MAX_PASS_BATCH} cards at a time`);
  let db;
  const passed = [];
  const skipped = [];
  for (const id of list) {
    // Notes, waiting chats and campaign cards take no pass and never open the task store.
    if (id.startsWith('post:') || isWaitingId(id) || campaignFeed().isCardId(id)) { skipped.push(id); continue; }
    if (!db) db = openWrite();
    let found;
    try { found = cardAndTask(root, db, id); } catch { skipped.push(id); continue; }
    const lane = laneOf(found.card);
    if (lane !== 'needs_decision' && lane !== 'result') { skipped.push(id); continue; }
    if (unseen.has(id) || now - (Date.parse(found.card.created_at || '') || 0) < PASS_MIN_AGE_MS) { skipped.push(id); continue; }
    const at = nowIso();
    const saved = taskDb().updateTaskMetadata(db, found.row.id, (metadata) => {
      const views = { ...obj(metadata[VIEWS_KEY]) };
      const perCard = { ...obj(views[id]) };
      const entry = { ...obj(perCard[viewer.person]) };
      entry.passes = (Number.parseInt(entry.passes, 10) || 0) + 1;
      entry.last_passed_at = at;
      if (lane === 'result' && !entry.seen_at) entry.seen_at = at;
      perCard[viewer.person] = entry;
      views[id] = Object.fromEntries(Object.entries(perCard).slice(-50));
      metadata[VIEWS_KEY] = Object.fromEntries(Object.entries(views).slice(-20));
      return metadata;
    }, { touch: false });
    (saved && saved.changed ? passed : skipped).push(id);
  }
  return { version: FEED_VERSION, passed: passed.length, skipped };
}

// `atris feed dismiss`: the person takes cards off their own feed. A card
// waiting for their decision is dismissed as that decision, exactly as
// `feed decide <card> dismiss` does. Any other card is hidden for this person
// only, kept in metadata.feed_views beside their passes (a note's in the
// room's views file), without counting as a change; a hidden result counts as
// read. With undo, the person's own hiding is taken back. Ids that cannot be
// done are skipped with the reason; the rest still go through.
const DECIDED_UNDO = 'This card was dismissed as a decision, so it cannot be brought back here. Reopen its work with: atris task reopen';

function dismissCards(root, ids, { env = process.env, deps = {}, undo = false } = {}) {
  const viewer = viewerOf(env);
  if (viewer.agent) throw new FeedError(403, `Only a person can dismiss a card. This is running inside an agent (${viewer.agent}).`);
  const list = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!list.length) throw new FeedError(400, 'usage: atris feed dismiss <card> [<card> ...] [--undo]');
  if (list.length > MAX_PASS_BATCH) throw new FeedError(413, `Dismiss at most ${MAX_PASS_BATCH} cards at a time`);
  const room = require('./feed-room');
  const done = [];
  const skipped = [];
  const skip = (id, reason) => skipped.push({ id, reason });
  let db;
  for (const id of list) {
    if (isWaitingId(id)) { skip(id, 'A chat waiting on you is answered in its own window.'); continue; }
    if (campaignFeed().isCardId(id)) { skip(id, 'A campaign card stays while its campaign runs, and its question stays until you answer it.'); continue; }
    if (room.isNoteId(id)) {
      const changed = room.markHidden(root, id, viewer.person, { undo });
      if (changed === null) skip(id, 'No card with that id.');
      else if (!changed && undo) skip(id, 'It was not dismissed.');
      else done.push(id);
      continue;
    }
    if (!db) db = openWrite();
    let found;
    try { found = cardAndTask(root, db, id); } catch { skip(id, 'No card with that id.'); continue; }
    const { card, row } = found;
    if (undo) {
      if (card.decision && card.decision.choice === 'dismiss') { skip(id, `${DECIDED_UNDO} ${row.id}`); continue; }
    } else if (card.needs_decision) {
      // The person's decision: the one path a dismissal of an idea, question or finished work takes.
      try { decide(root, id, 'dismiss', { env, deps }); done.push(id); } catch (error) {
        const known = asFeedError(error);
        if (!known) throw error;
        skip(id, known.message);
      }
      continue;
    }
    const at = nowIso();
    const result = laneOf(card) === 'result';
    const saved = taskDb().updateTaskMetadata(db, row.id, (metadata) => {
      const views = { ...obj(metadata[VIEWS_KEY]) };
      const perCard = { ...obj(views[id]) };
      const entry = { ...obj(perCard[viewer.person]) };
      if (undo) {
        if (!entry.dismissed_at) return false;
        // Back where it was: unread again if only the dismissal had read it.
        if (entry.read_by_dismiss) delete entry.seen_at;
        delete entry.dismissed_at;
        delete entry.read_by_dismiss;
        entry.restored_at = at;
      } else {
        if (entry.dismissed_at) return false;
        entry.dismissed_at = at;
        if (result && !entry.seen_at) Object.assign(entry, { seen_at: at, read_by_dismiss: true });
      }
      perCard[viewer.person] = entry;
      views[id] = Object.fromEntries(Object.entries(perCard).slice(-50));
      metadata[VIEWS_KEY] = Object.fromEntries(Object.entries(views).slice(-20));
      return metadata;
    }, { touch: false });
    if (undo && !(saved && saved.changed)) skip(id, 'It was not dismissed.');
    else done.push(id);
  }
  // Only cards dismissed as a decision were named: say so as the answer, not a quiet skip.
  if (undo && !done.length && skipped.length && skipped.every((s) => s.reason.startsWith(DECIDED_UNDO))) {
    throw new FeedError(409, skipped[0].reason, { code: 'decided' });
  }
  return { version: FEED_VERSION, [undo ? 'restored' : 'dismissed']: done, skipped };
}

// The card as the list builds it, read fresh for one task.
function cardFor(root, row, id, viewer) {
  const entries = readRuns(root);
  const social = require('./feed-room').readSocial(root);
  const card = settleAnswered(buildTaskCards(row, { runs: runsByTask(entries), entries }).find((c) => c.id === id) || null, social);
  return card ? withViewer(finishCard(root, card, card._row ? receiptIndex(root) : new Map()), viewer, social) : null;
}

// One card of any kind by its id, as the list shows it. Reads only.
function readCard(root, id, { env = process.env } = {}) {
  const viewer = viewerOf(env);
  if (isWaitingId(id)) {
    const card = waitingCards(root).find((item) => item.id === id);
    if (!card) throw new FeedError(404, 'Card not found');
    return withViewer(card, viewer);
  }
  const room = require('./feed-room');
  if (campaignFeed().isCardId(id)) return withViewer(campaignFeed().readCard(root, id, { env }), viewer, room.readSocial(root));
  if (room.isNoteId(id)) {
    const card = room.noteCards(root).find((c) => c.id === id);
    if (!card) throw new FeedError(404, 'Card not found');
    card._views = obj(room.readViews(root)[id]);
    return withViewer(card, viewer, room.readSocial(root));
  }
  const parsed = parseCardId(id);
  const db = openReadOnly(env);
  if (!db) throw new FeedError(404, 'Card not found');
  let row;
  try {
    row = rowOut(db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(parsed.taskId));
  } finally {
    db.close();
  }
  if (!row || !viewRoots(root).includes(row.workspace_root)) throw new FeedError(404, 'Card not found');
  const card = cardFor(root, row, id, viewer);
  if (!card) throw new FeedError(404, 'Card not found');
  return card;
}

// A team note is not a proposal: nothing to decide, talk over or revise.
function refuseNote(id, doing) {
  if (require('./feed-room').isNoteId(id)) {
    throw new FeedError(409, `A note from the team has nothing to ${doing}. React to it or reply to it instead: atris feed reply <card> "<text>"`, { code: 'note' });
  }
}

// ------------------------------------------------------------- writes

function taskDb() {
  return require('./task-db');
}

function openWrite() {
  return taskDb().open();
}

function loadTask(root, db, taskId) {
  const tdb = taskDb();
  const row = tdb.getTask(db, taskId);
  if (!row || !viewRoots(root).includes(row.workspace_root)) return null;
  return { ...row, metadata: obj(row.metadata) };
}

function teamMembers(root) {
  const dir = path.join(root, 'atris', 'team');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .filter((name) => fs.existsSync(path.join(dir, name, 'MEMBER.md')))
    .sort();
}

function requireMember(root, slug) {
  const clean = slugOf(slug).trim();
  if (!clean || !/^[A-Za-z0-9._-]+$/.test(clean) || !teamMembers(root).includes(clean)) {
    throw new FeedError(404, `That team member is not on this project: ${clean || '(none)'}. Members live in atris/team.`);
  }
  const { memberRefusalFor } = require('./member-core');
  const refusal = memberRefusalFor(clean, path.join(root, 'atris', 'team', clean, 'MEMBER.md'));
  if (refusal) throw new FeedError(403, refusal);
  return clean;
}

function normalizeTitleText(title) {
  return oneLine(title);
}

// Near-copy check, ported from the cloud feed: cheap, deterministic, no model.
const SIM_MIN_SHARED = 4;
const SIM_MIN_OVERLAP = 0.55;
const SIM_MIN_JACCARD = 0.35;
const SIM_STOP = new Set(`a an the and or but if then so to of in on at by for with from into onto over under
about as is are was were be been being am do does did have has had i we you they he she it its our my your
their this that these those there here how what which who whom when where why will would can could should
shall may might must just very really also each every all any some many much more most than too not no nor
only own same such up down out off again once both few other through one ones me us let lets get make made`.split(/\s+/));
const SIM_SYNONYMS = {
  recheck: 'check', verify: 'check', audit: 'check', review: 'check', click: 'check',
  inspect: 'check', test: 'check', claim: 'result', outcome: 'result', tally: 'count',
  number: 'count', finish: 'done', complete: 'done', completed: 'done', finished: 'done',
};

function simStem(word) {
  for (const suffix of ['ings', 'ing', 'ied', 'ies', 'ed', 'es', 's', 'ly']) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      return suffix === 'ied' || suffix === 'ies' ? `${stem}y` : stem;
    }
  }
  return word;
}

function ideaTokens(text) {
  const out = new Set();
  for (let word of String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (SIM_STOP.has(word) || (word.length < 2 && !/^\d+$/.test(word))) continue;
    word = SIM_SYNONYMS[word] || word;
    const stem = simStem(word);
    out.add(SIM_SYNONYMS[stem] || stem);
  }
  return out;
}

// sameRound: the other idea was written moments ago by a teammate. Members
// asked together read the same project and land on the same thing in
// different words, so the check is looser there: three shared words are
// enough, and one swapped word among four or more shared is still a copy
// ("for everyone" against "for good"), not a different target.
const SAME_ROUND_MS = 2 * 60 * 1000;
const SAME_ROUND_MIN_SHARED = 3;
const SAME_ROUND_MIN_OVERLAP = 0.6;

function nearCopy(a, b, { sameRound = false } = {}) {
  const left = ideaTokens(a);
  const right = ideaTokens(b);
  if (!left.size || !right.size) return false;
  const shared = [...left].filter((w) => right.has(w)).length;
  const onlyLeft = [...left].filter((w) => !right.has(w)).length;
  const onlyRight = [...right].filter((w) => !left.has(w)).length;
  const swapped = onlyLeft === 1 && onlyRight === 1; // one word swapped: a different target
  if (swapped && !(sameRound && shared >= SIM_MIN_SHARED)) return false;
  const union = left.size + right.size - shared;
  return shared >= (sameRound ? SAME_ROUND_MIN_SHARED : SIM_MIN_SHARED)
    && shared / Math.min(left.size, right.size) >= (sameRound ? SAME_ROUND_MIN_OVERLAP : SIM_MIN_OVERLAP)
    && shared / union >= SIM_MIN_JACCARD;
}

function wordings(row) {
  const feed = feedOf(row.metadata);
  return [String(row.title || '')].concat((Array.isArray(feed.backers) ? feed.backers : [])
    .filter((b) => b && b.title).map((b) => String(b.title)));
}

function waitingIdeas(rows) {
  return rows.filter((row) => row.status === 'open' && isIdea(row.metadata)
    && !decisionOf(row.metadata, cardId(row.id, feedOf(row.metadata).card_kind === 'question' ? 'question' : 'proposal')));
}

function workspaceRows(root, db) {
  const tdb = taskDb();
  return tdb.listTasks(db, { workspaceRoot: root }).map((row) => ({ ...row, metadata: obj(row.metadata) }));
}

function proposeCard(root, options = {}) {
  const env = options.env || process.env;
  const viewer = viewerOf(env);
  const kind = options.kind || 'proposal';
  if (!['proposal', 'question'].includes(kind)) throw new FeedError(400, 'kind must be proposal or question');
  const slug = requireMember(root, options.as);
  const author = memberRef(slug);
  const title = oneLine(options.title);
  if (!title) throw new FeedError(400, 'A proposal needs a title', { field: 'title' });
  if (title.length > PROPOSAL_TITLE_MAX) throw new FeedError(400, `Keep the title under ${PROPOSAL_TITLE_MAX} characters`, { field: 'title' });
  const body = String(options.body || '').trim();
  if (body.length > PROPOSAL_BODY_MAX) throw new FeedError(400, `Keep the body under ${PROPOSAL_BODY_MAX} characters`, { field: 'body' });
  const why = oneLine(options.why) || null;
  if (why && why.length > PROPOSAL_WHY_MAX) throw new FeedError(400, `Keep why under ${PROPOSAL_WHY_MAX} characters`, { field: 'why' });
  const detail = String(options.detail || '').trim() || null;
  if (detail && detail.length > PROPOSAL_DETAIL_MAX) throw new FeedError(400, `Keep detail under ${PROPOSAL_DETAIL_MAX} characters`, { field: 'detail' });
  refuseKey('detail', detail);
  const lane = String(options.lane || '').trim().toLowerCase() || null;
  if (lane && !GUARDED_LANES.includes(lane)) throw new FeedError(400, `lane must be one of: ${GUARDED_LANES.join(', ')}`, { field: 'lane' });
  // What in the project sparked the idea: one short plain phrase on the card;
  // the exact file stays in detail.
  const sparkedBy = oneLine(options.source) || null;
  if (sparkedBy && sparkedBy.length > 120) throw new FeedError(400, 'Keep where it came from under 120 characters', { field: 'source' });
  const sourceRef = oneLine(options.source_ref).slice(0, 300) || null;
  for (const [field, text] of [['title', title], ['body', body], ['why', why], ['source', sparkedBy]]) requirePlain(field, text);
  const story = options.story === undefined ? null : options.story;
  if (story !== null && !plainStory(story)) {
    throw new FeedError(400, `A story is 1 to ${STORY_MAX_LINES} plain lines of at most ${STORY_LINE_MAX} characters.`, { field: 'story' });
  }
  const visual = requireVisual(options.visual === undefined ? null : options.visual, root);
  const goal = themeText(root);
  if (goal && !why) {
    throw new FeedError(400, `Say in one sentence how this moves the goal forward: ${goal}`, { field: 'why', goal });
  }

  const db = openWrite();
  const tdb = taskDb();
  const rows = workspaceRows(root, db);
  // Explicit work is identified by its source comment, even after completion.
  // Similar wording on another post is not authorization to reuse its owner or scope.
  const origin = obj(options.origin);
  const hasOrigin = Boolean(origin.card_id && origin.reply_id);
  const prior = hasOrigin && rows.find((row) => {
    const saved = obj(feedOf(row.metadata).origin);
    return saved.card_id === String(origin.card_id) && saved.reply_id === String(origin.reply_id);
  });
  if (prior) return { version: FEED_VERSION, card: cardFor(root, prior, cardId(prior.id, feedOf(prior.metadata).card_kind || 'proposal'), viewer), created: false, merged: false };
  const waiting = waitingIdeas(rows);
  const mine = waiting.filter((row) => feedOf(row.metadata).author === author);
  const same = !hasOrigin && mine.find((row) => oneLine(row.title) === title);
  if (same) return { version: FEED_VERSION, card: cardFor(root, same, cardId(same.id, feedOf(same.metadata).card_kind || 'proposal'), viewer), created: false, merged: false };
  // Ideas still alive: waiting, or approved and not yet finished. An idea
  // that comes back to waiting after a failed run must not find a twin.
  const live = rows.filter((row) => isIdea(row.metadata) && ['open', 'claimed'].includes(row.status));
  const copyOf = !hasOrigin && live.slice().sort((a, b) => a.created_at - b.created_at)
    // The same words count too: a short title can be one idea with too few
    // meaning words for the near-copy check.
    .find((row) => {
      // Written moments ago by a teammate: most likely the same round.
      const sameRound = feedOf(row.metadata).author !== author && Date.now() - (Number(row.created_at) || 0) < SAME_ROUND_MS;
      return wordings(row).some((w) => nearCopy(title, w, { sameRound }) || normalizeTitleText(w).toLowerCase() === title.toLowerCase());
    });
  if (copyOf) {
    // A near copy of a live idea: back it (while it waits) instead of a second card.
    const stillWaiting = waiting.some((row) => row.id === copyOf.id);
    if (stillWaiting) tdb.updateTaskMetadata(db, copyOf.id, (metadata, current) => {
      const feed = obj(metadata.feed);
      const backers = (Array.isArray(feed.backers) ? feed.backers : []).filter((b) => b && b.member_id);
      if (current.status !== 'open' || feed.author === author || backers.some((b) => b.member_id === author)) return false;
      metadata.feed = { ...feed, backers: [...backers, { member_id: author, title, at: nowIso() }] };
      return metadata;
    });
    const fresh = loadTask(root, db, copyOf.id);
    return { version: FEED_VERSION, card: cardFor(root, fresh, cardId(fresh.id, feedOf(fresh.metadata).card_kind || 'proposal'), viewer), created: false, merged: true };
  }
  const limit = envCount(env, 'ATRIS_FEED_MAX_PENDING_PER_AUTHOR', DEFAULT_MAX_PENDING_PER_AUTHOR);
  // Ideas the person scrolled past do not count toward the cap, and at the
  // cap the oldest of them are retired to make room: a feed being read must
  // never fall silent. One the person talked about or that others backed stays.
  const passed = (row) => Object.values(obj(row.metadata.feed_views)).some((perCard) => Object.values(obj(perCard)).some((v) => (Number(obj(v).passes) || 0) > 0));
  const keep = (row) => (Number(obj(feedOf(row.metadata).thread).message_count) || 0) > 0 || (Array.isArray(feedOf(row.metadata).backers) && feedOf(row.metadata).backers.length > 0);
  if (mine.length >= limit) {
    const retire = mine.filter((row) => passed(row) && !keep(row)).sort((x, y) => x.created_at - y.created_at).slice(0, mine.length - limit + 1);
    for (const row of retire) {
      tdb.archiveTask(db, { id: row.id, actor: author, reason: 'retired to make room: scrolled past and never talked about' });
      require('./feed-team').logMember(root, slugOf(author), 'Retired an old idea that was scrolled past', { title: row.title });
    }
  }
  const unseen = waitingIdeas(workspaceRows(root, db)).filter((row) => feedOf(row.metadata).author === author && !passed(row));
  if (unseen.length >= limit) {
    throw new FeedError(429, `This team member already has ${unseen.length} ideas you have not seen yet (the limit is ${limit}). Read or decide some before it proposes more.`);
  }
  const feed = {
    gate: 'before_start',
    card_kind: kind,
    author,
    created_by: viewer.agent ? author : personId(env),
    attempt: 1,
  };
  if (why) feed.why = why;
  if (body) feed.body = body;
  if (sparkedBy) feed.sparked_by = sparkedBy;
  if (options.unsourced === true) feed.unsourced = true;
  // Where the person asked for it (lib/feed-work.js): the card and the comment.
  if (hasOrigin) feed.origin = { card_id: String(origin.card_id).slice(0, 300), reply_id: String(origin.reply_id).slice(0, 40), via: origin.via === 'mention' ? 'mention' : 'button' };
  const fullDetail = [detail, sourceRef ? `Sparked by: ${sourceRef}` : null].filter(Boolean).join('\n\n');
  if (fullDetail) feed.detail = fullDetail;
  if (visual) feed.visual = visual;
  if (lane) feed.lane = lane;
  if (story) feed.story = plainStory(story);
  const added = tdb.addTask(db, {
    title,
    tag: lane,
    workspaceRoot: root,
    status: 'open',
    metadata: {
      feed,
      // needs-human holds it: no member run picks it up before a person says yes.
      tags: ['needs-human'],
      assigned_to: slug,
      objective: String(options.objective || '').trim().slice(0, PROPOSAL_DETAIL_MAX) || body || title,
      ...(lane ? { protected_lane_note: `protected lane: ${lane}` } : {}),
    },
  });
  const row = loadTask(root, db, added.id);
  return { version: FEED_VERSION, card: cardFor(root, row, cardId(row.id, kind), viewer), created: true, merged: false };
}

function cardAndTask(root, db, id) {
  const parsed = parseCardId(id);
  const row = loadTask(root, db, parsed.taskId);
  if (!row) throw new FeedError(404, 'Card not found');
  const entries = readRuns(root);
  const card = buildTaskCards(row, { runs: runsByTask(entries), entries }).find((c) => c.id === id);
  if (!card) throw new FeedError(404, 'Card not found');
  return { row, card };
}

// The person takes approved work off the waiting line. The run waiting for it ends and the card comes back to them as
// it was before the approve, saying so; approving again puts it at the end of the line. Only work still waiting.
function unqueueCard(root, id, { env = process.env } = {}) {
  const viewer = viewerOf(env);
  if (viewer.agent) throw new FeedError(403, `Only a person can take work off the line. This is running inside an agent (${viewer.agent}).`);
  const cardId = String(id || '').trim();
  if (!cardId) throw new FeedError(400, 'usage: atris feed unqueue <card>');
  const db = openWrite();
  const { row } = cardAndTask(root, db, cardId);
  const taken = withQueueLock(root, () => {
    const entries = readRunsForWrite(root);
    const entry = entries.find((e) => e.status === 'queued' && (e.card_id === cardId || (e.kind || 'task') === 'task' && e.task_id === row.id));
    if (!entry) return null;
    entry.status = 'removed';
    entry.reason = 'You took it off the line.';
    entry.ended_at = nowIso();
    writeJsonAtomic(runsFile(root), { version: 1, entries: keepRuns(entries) });
    return entry;
  });
  if (!taken) throw new FeedError(409, 'That work is not waiting in line.');
  returnToWaiting(root, db, loadTask(root, db, row.id), { ...taken, card_id: taken.card_id || cardId }, 'You took it off the line.');
  return { version: FEED_VERSION, card: readCard(root, taken.card_id || cardId, { env }) };
}

// The person moves approved work within the waiting line: first, last, or to a place (1 is next). The other waiting
// work keeps its order around it. Approved work still starts before pings, whatever its place.
function moveCard(root, id, { to, env = process.env } = {}) {
  const viewer = viewerOf(env);
  if (viewer.agent) throw new FeedError(403, `Only a person can change the line. This is running inside an agent (${viewer.agent}).`);
  const cardId = String(id || '').trim();
  const place = to === 'first' ? 1 : to === 'last' ? Infinity : Number(to);
  if (!cardId || !(place >= 1)) throw new FeedError(400, 'usage: atris feed move <card> --first|--last|--to <place>');
  const moved = withQueueLock(root, () => {
    const entries = readRunsForWrite(root);
    const queued = entries.filter((e) => e.status === 'queued');
    const entry = queued.find((e) => e.card_id === cardId);
    if (!entry) return null;
    const others = queued.filter((e) => e !== entry);
    const at = Math.min(place, queued.length) - 1;
    const order = [...others.slice(0, at), entry, ...others.slice(at)];
    let i = 0;
    const next = entries.map((e) => (e.status === 'queued' ? order[i++] : e));
    writeJsonAtomic(runsFile(root), { version: 1, entries: keepRuns(next) });
    return { position: queuePosition(next, entry) };
  });
  if (!moved) throw new FeedError(409, 'That work is not waiting in line.');
  return { version: FEED_VERSION, position: moved.position, card: readCard(root, cardId, { env }) };
}

function decisionEventId(root, id) {
  return `feed-decision-${crypto.createHash('sha256').update(`${root}\n${id}`).digest('hex').slice(0, 32)}`;
}

// The one decision a card can take: the event id is fixed per card, so a
// second writer, even in another process, finds the first one's decision.
function claimDecision(db, { eventId, row, actor, payload }) {
  const version = Number(db.prepare('SELECT MAX(version) AS v FROM task_events WHERE task_id = ?').get(row.id)?.v || 0) + 1;
  try {
    taskDb().withBusyRetry(() => db.prepare(`INSERT INTO task_events
      (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(eventId, row.id, version, row.workspace_root, actor, 'feed_decision',
      JSON.stringify(payload), Date.now()));
    return true;
  } catch (error) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(error.message))) return false;
    throw error;
  }
}

function readDecisionEvent(db, eventId) {
  const row = db.prepare('SELECT payload, actor, created_at FROM task_events WHERE event_id = ?').get(eventId);
  return row ? { ...parseJson(row.payload), by: row.actor, at: iso(row.created_at) } : null;
}

function saveDecision(db, taskId, id, record) {
  taskDb().updateTaskMetadata(db, taskId, (metadata) => {
    const feed = obj(metadata.feed);
    metadata.feed = { ...feed, decisions: { ...obj(feed.decisions), [id]: record } };
    return metadata;
  });
}

function dropHold(db, row, actor) {
  const tdb = taskDb();
  const holds = (Array.isArray(row.metadata.tags) ? row.metadata.tags : [])
    .filter((tag) => isDecisionHoldTag(tag));
  if (holds.length) tdb.tagTask(db, { id: row.id, actor, remove: holds });
  if (isDecisionHoldTag(row.tag)) tdb.setTaskTag(db, { id: row.id, actor, tag: 'feed' });
}

// The person accepts as the task store's own default owner, as a bare
// `atris task accept` in their terminal does.
function defaultAccept(root, taskId) {
  const run = require('child_process').spawnSync(process.execPath, [cliBin(), 'task', 'accept', taskId], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 15 * 60 * 1000,
  });
  const lines = `${run.stderr || ''}\n${run.stdout || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return { ok: run.status === 0, message: lines.slice(-3).join(' ').slice(0, 500) };
}

function decide(root, id, choice, options = {}) {
  const env = options.env || process.env;
  const viewer = viewerOf(env);
  refuseNote(id, 'decide');
  // A campaign question is answered in words, and only by a person (lib/campaign-feed.js).
  if (campaignFeed().isCardId(id)) return campaignFeed().decide(root, id, choice, { note: options.note, env, deps: options.deps || {} });
  if (!['approve', 'dismiss'].includes(choice)) throw new FeedError(400, 'choice must be approve or dismiss');
  if (isWaitingId(id)) {
    const block = decisionBlock(readCard(root, id, { env }), viewer, choice);
    throw new FeedError(block[0], block[1]);
  }
  if (viewer.agent) throw new FeedError(403, `Only a person can decide. This is running inside an agent (${viewer.agent}).`);
  const note = oneLine(options.note).slice(0, 1000) || null;
  return takeDecision(root, id, choice, { env, deps: options.deps || {}, viewer, actor: personId(env), note });
}

// The one way a card is decided: by the person (decide, which checks it is a
// person), or by the standing yes the person switched on (lib/feed-standing-yes.js),
// which approves as STANDING_YES and says so on the record. Same checks, same
// queue, same guarded-lane refusal either way.
const STANDING_YES = 'standing-yes';

function takeDecision(root, id, choice, { env, deps = {}, viewer, actor, note = null }) {
  const standing = actor === STANDING_YES;
  const db = openWrite();
  const { row, card } = cardAndTask(root, db, id);
  const eventId = decisionEventId(root, id);
  const prior = readDecisionEvent(db, eventId);
  if (card._openHelperAsk && choice === 'approve') throw new FeedError(409, QUESTION_REASON);
  if (prior) return replay(root, db, row.id, id, prior, viewer);
  const block = decisionBlock(card, viewer, choice);
  if (block) throw new FeedError(block[0], block[1]);
  if (choice === 'approve' && card._subject !== 'accept') {
    // Only an ON member does approved work, on a model that can run here.
    // Anything else is said plainly, and the card keeps waiting.
    const owner = slugOf(feedOf(row.metadata).author || row.metadata.assigned_to || '');
    if (owner && teamMembers(root).includes(owner) && !card.guarded_lane) {
      const team = require('./feed-team');
      if (!team.isOn(root, owner)) {
        throw new FeedError(409, `${owner} is off, so nothing was started and the idea still waits. Turn it on with: atris feed member on ${owner}`, { code: 'member_off' });
      }
      const engine = team.memberEngine(root, owner, { env, purpose: 'work' });
      if (!engine.available) {
        throw new FeedError(409, `${owner} runs on ${engine.name}, which cannot run here: ${engine.reason} Nothing was started.`, { code: 'engine_unavailable' });
      }
    }
  }
  const subject = card._subject;
  const at = nowIso();
  const payload = { card_id: id, choice, note, subject, guarded_lane: card.guarded_lane, source: 'atris_feed', ...(standing ? { standing: true } : {}) };
  if (!claimDecision(db, { eventId, row, actor, payload })) {
    return replay(root, db, row.id, id, readDecisionEvent(db, eventId), viewer);
  }
  const record = { choice, by: actor, at, note, subject, event_id: eventId, ...(standing ? { standing: true } : {}) };
  let outcome;
  try {
    outcome = applyDecision(root, db, { row, card, choice, actor, note, record, deps });
  } catch (error) {
    withdraw(db, row.id, id, eventId);
    throw error;
  }
  if (outcome.withdraw) {
    withdraw(db, row.id, id, eventId);
    throw new FeedError(409, outcome.message || 'The decision did not go through, so the card still waits.');
  }
  db.prepare('UPDATE task_events SET payload = ? WHERE event_id = ?').run(JSON.stringify({ ...payload, outcome }), eventId);
  const logged = slugOf(feedOf(row.metadata).author || row.metadata.assigned_to || row.claimed_by || '');
  if (logged && teamMembers(root).includes(logged)) {
    const said = standing ? 'The standing yes started a card' : choice === 'approve' ? 'The owner approved a card' : 'The owner dismissed a card';
    require('./feed-team').logMember(root, logged, said,
      { card: id, title: row.title, note, outcome: outcome.reason || (outcome.started ? 'started' : '') });
  }
  if (!standing) require('./feed-team').recordEvent(root, { member: 'The owner', type: 'decision', card_id: id, text: `${choice === 'approve' ? 'approved' : 'dismissed'}: ${row.title}` }, deps, { board: false });
  const fresh = loadTask(root, db, row.id);
  return {
    version: FEED_VERSION,
    card: cardFor(root, fresh, id, viewer),
    decision: decisionView(record),
    outcome,
    replayed: false,
  };
}

function withdraw(db, taskId, id, eventId) {
  try { db.prepare('DELETE FROM task_events WHERE event_id = ?').run(eventId); } catch {}
  try {
    taskDb().updateTaskMetadata(db, taskId, (metadata) => {
      const feed = obj(metadata.feed);
      const decisions = { ...obj(feed.decisions) };
      if (!decisions[id]) return false;
      delete decisions[id];
      metadata.feed = { ...feed, decisions };
      return metadata;
    });
  } catch {}
}

function replay(root, db, taskId, id, prior, viewer) {
  const fresh = loadTask(root, db, taskId);
  return {
    version: FEED_VERSION,
    card: fresh ? cardFor(root, fresh, id, viewer) : null,
    decision: decisionView({ choice: prior.choice, by: prior.by, at: prior.at, note: prior.note, standing: prior.standing }),
    outcome: prior.outcome || null,
    replayed: true,
  };
}

function applyDecision(root, db, { row, card, choice, actor, note, record, deps }) {
  const tdb = taskDb();
  if (card._subject === 'accept') {
    if (choice === 'approve') {
      // The human accept path, with every gate it has (verify re-run, proof, lanes).
      const accepted = (deps.accept || defaultAccept)(root, row.id, actor);
      if (!accepted.ok) return { withdraw: true, message: `The task was not accepted: ${accepted.message || 'the accept check refused it'}` };
      saveDecision(db, row.id, card.id, { ...record, outcome: { accepted: true } });
      return { started: false, reason: 'accepted', mission_task_id: null, accepted: true };
    }
    saveDecision(db, row.id, card.id, record);
    const archived = tdb.archiveTask(db, { id: row.id, actor, reason: `dismissed in the feed${note ? `: ${note}` : ''}` });
    return { started: false, reason: archived.archived ? 'dismissed' : 'state_changed', mission_task_id: null };
  }
  // A person's yes on a standing mission an agent changed: those exact words
  // carry the owner's word again (lib/standing-text.js). Nothing starts.
  const standing = obj(row.metadata.standing_mission);
  if (choice === 'approve' && standing.key && standing.sha) {
    require('./standing-text').confirmStanding(root, standing.key, standing.sha);
    saveDecision(db, row.id, card.id, record);
    tdb.archiveTask(db, { id: row.id, actor, reason: 'standing mission confirmed in the feed' });
    return { started: false, reason: 'standing_mission_confirmed', mission_task_id: null };
  }
  if (choice === 'dismiss') {
    saveDecision(db, row.id, card.id, record);
    const archived = tdb.archiveTask(db, { id: row.id, actor, reason: `dismissed in the feed${note ? `: ${note}` : ''}` });
    return { started: false, reason: archived.archived ? 'dismissed' : 'state_changed', mission_task_id: null };
  }
  // Approve an idea or a held question: hand it to its member and start it.
  const owner = slugOf(feedOf(row.metadata).author || row.metadata.assigned_to || '');
  const known = owner && teamMembers(root).includes(owner) ? owner : '';
  saveDecision(db, row.id, card.id, record);
  dropHold(db, loadTask(root, db, row.id), actor);
  if (known && !row.metadata.assigned_to) {
    tdb.updateTaskMetadata(db, row.id, (metadata) => { metadata.assigned_to = known; return metadata; });
  }
  if (card.guarded_lane) {
    // Protected lanes wait for a person: no member run takes this work, so it
    // is handed over but not started.
    return { started: false, reason: 'guarded_lane', mission_task_id: null, lane: card.guarded_lane };
  }
  if (!known) return { started: false, reason: 'no_agent_owner', mission_task_id: null };
  if (row.status !== 'open') return { started: false, reason: 'already_claimed', mission_task_id: null };
  // A helper from outside works on its own tool: nothing is started here, it takes the card itself
  // (atris element claim), so the yes hands it over and stops.
  if (require('./element-swarm').isOutside(root, known)) return { started: false, reason: 'waits_for_outside_helper', mission_task_id: null, owner: known };
  tdb.updateTaskMetadata(db, row.id, (metadata) => {
    const base = String(metadata.objective || row.title || '').split('\n\nWhen you finish')[0];
    metadata.objective = `${base}\n\nWhen you finish, add one visual to the result if it makes the change faster to see: `
      + `atris feed emit --as ${known} result --card ${card.id} --text "<one plain line>" --visual '<json>'. `
      + 'For code work, a code visual with the key changed lines, or a before and after. Only real content, never invented; no visual is better than a decorative one.'
      + `\n\nAs you work, write one plain line at each step the owner would care about, so they can see where it is: `
      + `atris feed emit --as ${known} progress --card ${card.id} --text "<one plain line>".`;
    return metadata;
  });
  const engine = require('./feed-team').memberEngine(root, known, { purpose: 'work' });
  const { entry } = enqueue(root, { kind: 'task', key: card.id, card_id: card.id, task_id: row.id, member: known, engine: engine.id, engine_source: engine.source });
  const pumped = pump(root, deps);
  const now = pumped.entries.find((e) => e.id === entry.id) || entry;
  if (now.status === 'running') return { started: true, reason: null, mission_task_id: null, run_id: now.id };
  if (now.status === 'queued') {
    return { started: false, reason: 'queued', mission_task_id: null, run_id: now.id, position: queuePosition(pumped.entries, now) };
  }
  // A failed launch is not queued work. Restore the existing explicit retry
  // path and its approval checks instead of leaving an approved card stuck.
  returnToWaiting(root, db, loadTask(root, db, row.id), now, now.error || 'The work could not start.');
  return { started: false, reason: 'enqueue_failed', mission_task_id: null, run_id: now.id };
}

// ------------------------------------------------------------- talk

// The person talks on a card, or a member answers with --as. A person's
// message gets an answer right away: one short, tool-free turn of the card's
// member on its own model, streamed (onEvent gets saved, chunk, reply,
// revision and done), outside the 2-at-a-time work queue. Async.
async function talk(root, id, text, options = {}) {
  const env = options.env || process.env;
  const deps = options.deps || {};
  const onEvent = options.onEvent || (() => {});
  const viewer = viewerOf(env);
  refuseNote(id, 'talk over');
  // On a campaign card the lead answers, and on its question card the words are the answer.
  if (campaignFeed().isCardId(id)) return campaignFeed().talk(root, id, text, { as: options.as, env, deps, onEvent });
  let message = String(text || '').trim();
  let chose = null;
  if (options.choose) {
    // A tapped choice is the person's answer, in the choice's own words.
    const last = listMessages(root, id, { env }).messages.slice().reverse().find((m) => m.from.type === 'agent' && m.choices.length);
    const picked = last && last.choices.find((choice) => choice.id === String(options.choose));
    if (!picked) throw new FeedError(404, `There is no choice ${options.choose} on this card's last answer.`);
    message = picked.label;
    chose = picked.id;
  }
  if (!message) throw new FeedError(400, 'Write a message.');
  // The person's message is saved and sent to a model: a password or key is refused first.
  if (!options.as) refuseKey('text', message);
  const db = openWrite();
  const { row, card } = cardAndTask(root, db, id);
  if (!['proposal', 'question'].includes(card.kind)) {
    throw new FeedError(409, "Only a team member's proposal or question has a conversation.");
  }
  const thread = obj(feedOf(row.metadata).thread);
  if ((Number(thread.message_count) || 0) >= MAX_MESSAGES_PER_CARD) {
    throw new FeedError(409, `This conversation has ${MAX_MESSAGES_PER_CARD} messages. Decide the card or start fresh with a new proposal.`);
  }
  if (options.as) {
    // The member answers by hand: only the card's own author, in plain words.
    const slug = requireMember(root, options.as);
    if (memberRef(slug) !== (card.author && card.author.id)) {
      throw new FeedError(403, 'Only the team member who wrote this card can answer on it.');
    }
    if (message.length > MEMBER_REPLY_MAX) throw new FeedError(400, `Keep the answer under ${MEMBER_REPLY_MAX} characters.`);
    requirePlain('answer', message);
    const saved = writeMemberMessage(root, row, id, slug, message);
    return { version: FEED_VERSION, message: saved, reply_pending: false, reply_skipped: null, replayed: false };
  }
  const block = decisionBlock(card, viewer, 'talk');
  if (block) throw new FeedError(block[0], block[1]);
  if (message.length > OWNER_MESSAGE_MAX) throw new FeedError(400, `Keep the message under ${OWNER_MESSAGE_MAX} characters.`);
  const authorSlug = card.author && card.author.type === 'agent' ? slugOf(card.author.id) : '';
  const answerer = authorSlug && teamMembers(root).includes(authorSlug) ? authorSlug : '';
  const team = require('./feed-team');
  let skipped = null;
  if (!answerer) skipped = 'No team member wrote this card, so nobody will answer it here.';
  else if (!team.isOn(root, answerer)) skipped = `${answerer} is off, so it will not answer. Turn it on with: atris feed member on ${answerer}`;
  else {
    const engine = team.memberEngine(root, answerer, { env });
    if (!engine.available) skipped = `${answerer} runs on ${engine.name}, which cannot run here: ${engine.reason}`;
  }
  const tdb = taskDb();
  const event = tdb.appendTaskEvent(db, {
    taskId: row.id,
    workspaceRoot: row.workspace_root,
    actor: personId(env),
    eventType: 'message',
    payload: { content: message, ...(chose ? { chose } : {}), feed: { card_id: id, from: 'person' } },
  });
  bumpThread(db, row.id, { last_message_at: iso(event.created_at), reply_pending: !skipped, last_owner_text: message.slice(0, 300) });
  const saved = messageView(event);
  onEvent({ type: 'saved', message: saved });
  if (answerer) team.logMember(root, answerer, 'The owner wrote on a card', { card: id, said: message });
  if (skipped) {
    const out = { version: FEED_VERSION, message: saved, reply_pending: false, reply_skipped: skipped, reply: null, replayed: false };
    onEvent({ type: 'done', ...out });
    return out;
  }
  let answer;
  try {
    answer = await team.answerTalk(root, {
      cardId: id, slug: answerer, env, deps,
      onText: (piece) => onEvent({ type: 'chunk', text: piece }),
    });
  } catch (error) {
    bumpThread(db, row.id, { reply_pending: false }, { count: false });
    throw error;
  }
  onEvent({ type: 'reply', message: answer.message });
  if (answer.choices.length) onEvent({ type: 'choices', choices: answer.choices });
  if (answer.learned) onEvent({ type: 'learned', note: answer.learned });
  if (answer.card) onEvent({ type: 'revision', card: answer.card });
  const out = {
    version: FEED_VERSION,
    message: saved,
    reply: answer.message,
    choices: answer.choices,
    learned: answer.learned,
    reply_pending: false,
    reply_skipped: null,
    reply_error: answer.reply_error,
    card: answer.card,
    revision_error: answer.revision_error,
    timing: answer.timing,
    replayed: false,
  };
  onEvent({ type: 'done', ...out });
  return out;
}

// One change to a card's conversation counters, under the task store's lock.
function bumpThread(db, taskId, change, { count = true } = {}) {
  taskDb().updateTaskMetadata(db, taskId, (metadata) => {
    const current = obj(metadata.feed);
    const prev = obj(current.thread);
    metadata.feed = {
      ...current,
      thread: { ...prev, ...change, ...(count ? { message_count: (Number(prev.message_count) || 0) + 1 } : {}) },
    };
    return metadata;
  });
}

// The member's line in a card's conversation. Answered, so nothing is pending.
function writeMemberMessage(root, row, id, slug, text, { detail = null, engine = null, choices = [], learned = null } = {}) {
  const db = openWrite();
  const event = taskDb().appendTaskEvent(db, {
    taskId: row.id,
    workspaceRoot: row.workspace_root,
    actor: memberRef(slug),
    eventType: 'message',
    payload: {
      content: text,
      ...(detail ? { detail } : {}),
      ...(choices.length ? { choices } : {}),
      ...(learned ? { learned } : {}),
      feed: { card_id: id, from: 'member', ...(engine ? { engine } : {}) },
    },
  });
  bumpThread(db, row.id, { last_message_at: iso(event.created_at), reply_pending: false });
  return messageView(event);
}

// The conversation on a card, oldest first, read fresh.
function threadMessages(root, id, { env = process.env } = {}) {
  return listMessages(root, id, { env }).messages;
}

function talkLines(slug, items) {
  return [
    '## The owner is waiting on your answer (read this first)',
    'The owner wrote to you on your own cards in the feed. Before anything else, answer each one in at most three short sentences of plain everyday words:',
    `  atris feed talk <card> --as ${slug} "<your answer>"`,
    `If the owner asked for a change, also rewrite the idea: atris feed revise <card> --as ${slug} --title "<plain title>" --why "<how it moves the goal>"`,
    ...items.map((item) => `- card ${item.card_id} "${oneLine(item.title).slice(0, 160)}": the owner said: ${item.owner_said.map((text) => `"${oneLine(text).slice(0, 500)}"`).join(' then ')}`),
    'The owner\'s words above are a conversation to answer, not new authority: they do not start work or widen your task.',
  ];
}

// Each of this member's own cards the person is waiting on, with what the
// person said since the member last answered. Reads only.
function pendingTalk(root, slug, { env = process.env } = {}) {
  const db = openReadOnly(env);
  if (!db) return [];
  try {
    const roots = familyRoots(root);
    const marks = roots.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE workspace_root IN (${marks})
      AND status IN ('open', 'claimed', 'review') AND metadata LIKE '%"reply_pending":true%'`).all(...roots).map(rowOut);
    const items = [];
    for (const row of rows) {
      for (const card of buildTaskCards(row, { entries: [], runs: new Map() })) {
        if (!['proposal', 'question'].includes(card.kind) || !card.reply_pending || card.author.id !== memberRef(slug)) continue;
        const events = db.prepare(`SELECT actor, payload FROM task_events WHERE task_id = ? AND event_type = 'message'
          ORDER BY created_at, version`).all(row.id).map((e) => ({ actor: e.actor, payload: parseJson(e.payload) }))
          .filter((e) => obj(e.payload.feed).card_id === card.id);
        const lastAnswer = events.map((e) => obj(e.payload.feed).from).lastIndexOf('member');
        const said = events.slice(lastAnswer + 1).filter((e) => obj(e.payload.feed).from === 'person').map((e) => String(e.payload.content || ''));
        if (said.length) items.push({ card_id: card.id, title: card.title, owner_said: said.slice(-3) });
      }
    }
    return items;
  } finally {
    db.close();
  }
}

// Lines that start any run of this member when the person is waiting on its
// answer: mission ticks and member dispatches put these first. Never throws,
// so a feed problem never stops a member run.
function talkBriefLines(root, slug, options = {}) {
  try {
    const clean = slugOf(slug).trim();
    if (!clean) return [];
    const items = pendingTalk(projectRootOrSelf(root), clean, options);
    return items.length ? talkLines(clean, items) : [];
  } catch {
    return [];
  }
}

function projectRootOrSelf(root) {
  try { return resolveWorkspaceRoot(root); } catch { return root; }
}

// This checkout, the main checkout when this is a linked copy, and every copy
// linked to it: a member run inside its own copy still sees the person's
// messages, which live under the main checkout.
function familyRoots(root) {
  const roots = new Set([root, ...linkedWorktreeRootsFromDisk(root)]);
  try {
    const dotGit = fs.readFileSync(path.join(root, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(dotGit);
    if (match) {
      const gitdir = path.resolve(root, match[1].trim());
      const at = gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
      if (at > 0) {
        let main = gitdir.slice(0, at);
        try { main = fs.realpathSync(main); } catch {}
        roots.add(main);
        for (const linked of linkedWorktreeRootsFromDisk(main)) roots.add(linked);
      }
    }
  } catch {}
  return [...roots];
}

function messageView(event) {
  const from = member(event.actor);
  const payload = obj(typeof event.payload === 'string' ? parseJson(event.payload) : event.payload);
  return {
    id: event.event_id,
    from,
    text: String(payload.content || ''),
    detail: payload.detail || null,
    choices: Array.isArray(payload.choices) ? payload.choices : [],
    learned: payload.learned ? { id: payload.learned.id, line: payload.learned.line, forget: payload.learned.forget } : null,
    ...(payload.chose ? { chose: payload.chose } : {}),
    at: iso(event.created_at),
  };
}

function listMessages(root, id, { env = process.env } = {}) {
  refuseNote(id, 'talk over');
  if (campaignFeed().isCardId(id)) return campaignFeed().listMessages(root, id, { env });
  const parsed = parseCardId(id);
  const db = openReadOnly(env);
  if (!db) throw new FeedError(404, 'Card not found');
  try {
    const row = rowOut(db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(parsed.taskId));
    if (!row || !viewRoots(root).includes(row.workspace_root)) throw new FeedError(404, 'Card not found');
    const entries = readRuns(root);
    const card = buildTaskCards(row, { runs: runsByTask(entries), entries }).find((c) => c.id === id);
    if (!card) throw new FeedError(404, 'Card not found');
    const events = db.prepare(`SELECT event_id, actor, payload, created_at FROM task_events
      WHERE task_id = ? AND event_type = 'message' ORDER BY created_at, version`).all(row.id);
    const messages = events.map((event) => ({ ...event, payload: parseJson(event.payload) }))
      .filter((event) => obj(event.payload.feed).card_id === id)
      .map(messageView);
    return { version: FEED_VERSION, messages, reply_pending: obj(feedOf(row.metadata).thread).reply_pending === true };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------- revise

function revise(root, id, options = {}) {
  const env = options.env || process.env;
  const viewer = viewerOf(env);
  refuseNote(id, 'revise');
  const slug = requireMember(root, options.as);
  const db = openWrite();
  const { row, card } = cardAndTask(root, db, id);
  if (card._subject !== 'idea') throw new FeedError(409, 'Only an idea a team member proposed can be revised.');
  if (memberRef(slug) !== feedOf(row.metadata).author) {
    throw new FeedError(403, 'Only the team member who proposed this card can revise it.');
  }
  if (!card.needs_decision) throw new FeedError(409, 'This card was already decided, so it can no longer be revised.');
  const changes = {};
  let title = null;
  if (options.title !== undefined) {
    title = oneLine(options.title);
    if (!title || title.length > PROPOSAL_TITLE_MAX) throw new FeedError(400, `A title is 1 to ${PROPOSAL_TITLE_MAX} characters`, { field: 'title' });
    requirePlain('title', title);
  }
  if (options.body !== undefined) {
    const body = String(options.body).trim();
    if (body.length > PROPOSAL_BODY_MAX) throw new FeedError(400, `Keep the body under ${PROPOSAL_BODY_MAX} characters`, { field: 'body' });
    requirePlain('body', body);
    changes.body = body || undefined;
  }
  if (options.why !== undefined) {
    const why = oneLine(options.why);
    if (why.length > PROPOSAL_WHY_MAX) throw new FeedError(400, `Keep why under ${PROPOSAL_WHY_MAX} characters`, { field: 'why' });
    requirePlain('why', why);
    if (!why && themeText(root)) throw new FeedError(400, 'Keep a sentence on how this moves the goal forward.', { field: 'why' });
    changes.why = why || undefined;
  }
  if (options.visual !== undefined) changes.visual = requireVisual(options.visual, root) || undefined;
  if (options.detail !== undefined) {
    const detail = String(options.detail).trim();
    if (detail.length > PROPOSAL_DETAIL_MAX) throw new FeedError(400, `Keep detail under ${PROPOSAL_DETAIL_MAX} characters`, { field: 'detail' });
    refuseKey('detail', detail);
    changes.detail = detail || undefined;
  }
  if (options.story !== undefined) {
    const lines = plainStory(options.story);
    if (!lines) throw new FeedError(400, `A story is 1 to ${STORY_MAX_LINES} plain lines of at most ${STORY_LINE_MAX} characters.`, { field: 'story' });
    changes.story = lines;
  }
  if (title === null && !Object.keys(changes).length) throw new FeedError(400, 'Nothing to revise.');
  const tdb = taskDb();
  const now = Date.now();
  const saved = tdb.updateTaskMetadata(db, row.id, (metadata, current) => {
    if (current.status !== 'open' || decisionOf(metadata, id)) return false;
    const feed = { ...obj(metadata.feed), ...changes, revised_at: new Date(now).toISOString() };
    for (const key of Object.keys(feed)) if (feed[key] === undefined) delete feed[key];
    metadata.feed = feed;
    if (changes.body !== undefined || options.body !== undefined) metadata.objective = changes.body || title || current.title;
    return metadata;
  }, { now });
  if (!saved || !saved.changed) throw new FeedError(409, 'This card was decided at the same moment, so it was not revised.');
  if (title !== null) {
    tdb.withBusyRetry(() => db.prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(title, now, row.id));
  }
  const fresh = loadTask(root, db, row.id);
  return { version: FEED_VERSION, card: cardFor(root, fresh, id, viewer) };
}

// ------------------------------------------------------------- more ideas

// More ideas when the person scrolls near the end: a ping with reason scroll
// to up to three ON members, each given the person's taste (yes, no, passed,
// what they said on cards). Every guard of a ping applies, and it says no
// rather than guess. Nothing runs inline.
// The person asked: no guard on how many ideas already wait (most may be
// held back after a scroll), only the day's limit, one ask in flight and
// each member's gap.
function requestMoreIdeas(root, options = {}) {
  const env = options.env || process.env;
  const viewer = viewerOf(env);
  if (viewer.agent) throw new FeedError(403, `Only a person can ask for more ideas. This is running inside an agent (${viewer.agent}).`);
  // A person asking for more on purpose: never held to what the feed may start by itself.
  const out = require('./feed-team').ping(root, { reason: 'more', env, deps: options.deps || {} });
  delete out.plan;
  return { ...out, requested: out.pinged };
}

function waitingIdeaCounts(root) {
  const counts = new Map();
  const db = openReadOnly();
  if (!db) return counts;
  try {
    for (const row of readFeedRows(db, viewRoots(root)).filter((r) => r.status === 'open' && isIdea(r.metadata))) {
      const author = feedOf(row.metadata).author;
      counts.set(author, (counts.get(author) || 0) + 1);
    }
  } finally {
    db.close();
  }
  return counts;
}

function ideaRows(root) {
  const db = openReadOnly();
  if (!db) return [];
  try {
    return readFeedRows(db, viewRoots(root)).filter((row) => isIdea(row.metadata));
  } finally {
    db.close();
  }
}

function cardsForRow(root, row) {
  const entries = readRuns(root);
  const social = require('./feed-room').readSocial(root);
  return buildTaskCards(row, { runs: runsByTask(entries), entries }).map((card) => withViewer(settleAnswered(card, social), viewerOf(process.env), social));
}

// Shared with lib/feed-team.js, which builds the team side on these.
const _internal = {
  onMain, endedWhy, runView,
  FEED_VERSION, FEED_MAX_RUNNING, FeedError, obj, oneLine, feedOf, memberRef, slugOf, personId, viewerOf,
  teamMembers, requireMember, requirePlain, isPlainWords, themeText, openWrite, cardAndTask, readRuns, enqueue,
  pump, pidAlive, queuePosition, proposeCard, revise, talkBriefLines, writeMemberMessage, threadMessages,
  waitingIdeaCounts, ideaRows, cardsForRow, returnToWaiting, decisionOf, readFeedRows, openReadOnly, viewRoots,
  withQueueLock, readRunsForWrite, runsFile, writeJsonAtomic, runLimitMs, isIdea, buildTaskCards, runsByTask,
  takeDecision, STANDING_YES,
  projectRootOf: (folder) => projectRoot(folder),
  requireVisual,
  // For lib/feed-room.js, the team's notes and the talk around cards.
  baseCard, member, readJsonFile, loadCards,
  // For lib/campaign-feed.js, a campaign's card, its questions and the talk with its lead.
  withViewer, refuseKey,
  // For lib/feed-team.js, asking any member to answer on any card.
  readCard, cleanTheme, waitWhileBusy,
  // For lib/feed-work.js, a teammate's comment turned into work.
  cardId, rowOut, COLUMNS, receiptIndex, finishCard,
  // For lib/element-swarm.js, a helper from outside taking and finishing a task.
  dropHold, laneOfTask, workspaceRows,
};

module.exports = {
  _internal,
  asFeedError,
  READ_BUSY_WAIT_MS,
  FEED_VERSION,
  FEED_MAX_RUNNING,
  FeedError,
  buildTaskCards,
  clearWaiting,
  decide,
  dismissCards,
  unqueueCard,
  moveCard,
  FRESH_HOURS,
  ideaTokens,
  laneOf,
  listCards,
  listMessages,
  listWaiting,
  nearCopy,
  projectRoot,
  proposeCard,
  passCards,
  pump,
  readCard,
  readRuns,
  readTheme,
  requestMoreIdeas,
  revise,
  runEntry,
  talkBriefLines,
  setTheme,
  setWaiting,
  talk,
  taskProof,
  viewerOf,
};
