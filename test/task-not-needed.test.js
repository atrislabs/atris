'use strict';

// `atris task archive <id> --not-needed --reason "<why>"`: a person confirms
// that a job a worker dropped never needed doing (already fixed, or the wrong
// ask). The drop then stops counting against the worker, because nobody could
// have confirmed "not needed" before and a correct "already fixed" read from a
// worker was scored as a plain miss.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tasks = require('../lib/task-db');
const { loadSeason, rosterRows } = require('../lib/gm-season');
const { ratingCommand } = require('../commands/rating');
const { scrubAgentEnv } = require('./helpers/agent-env');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const HOUR = 3600000;
const DAY = 86400000;

// ---------------------------------------------------------------------------
// The record: who confirmed it, and what that does to a job's status.

function sandboxDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-needed-'));
  const dbPath = path.join(dir, 'tasks.db');
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = dbPath;
  const db = tasks.open(dbPath);
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

const eventsOf = (db, id, type) => db.prepare('SELECT actor, payload FROM task_events WHERE task_id = ? AND event_type = ? ORDER BY version')
  .all(id, type).map((row) => ({ actor: row.actor, ...JSON.parse(row.payload) }));

test('archiveNotNeeded needs a reason and a real job', (t) => {
  const { dir, db } = sandboxDb(t);
  const { id } = tasks.addTask(db, { title: 'Fix the form', workspaceRoot: dir });
  assert.throws(() => tasks.archiveNotNeeded(db, { id, actor: 'keshav', reason: '   ' }), /reason required/);
  assert.throws(() => tasks.archiveNotNeeded(db, { id, actor: 'keshav' }), /reason required/);
  assert.throws(() => tasks.archiveNotNeeded(db, { actor: 'keshav', reason: 'already fixed' }), /id required/);
  assert.deepEqual(tasks.archiveNotNeeded(db, { id: 'no-such-job', actor: 'keshav', reason: 'already fixed' }), { archived: false, recorded: false, reason: 'not_found' });
  assert.equal(tasks.getTask(db, id).status, 'open', 'a refused call changes nothing');
  assert.deepEqual(eventsOf(db, id, 'not_needed'), []);
});

test('it archives the job and writes down who confirmed it and why', (t) => {
  const { dir, db } = sandboxDb(t);
  const { id } = tasks.addTask(db, { title: 'Fix the form', workspaceRoot: dir });
  assert.equal(tasks.claimTask(db, { id, claimedBy: 'fleet-codex' }).claimed, true);
  const result = tasks.archiveNotNeeded(db, { id, actor: 'keshav', reason: 'already fixed in 3.74.20' });
  assert.equal(result.archived, true);
  assert.equal(result.recorded, true);
  const row = tasks.getTask(db, id);
  assert.equal(row.status, 'archived');
  assert.equal(row.metadata.archived_by, 'keshav');
  assert.equal(row.metadata.archived_reason, 'already fixed in 3.74.20');
  assert.deepEqual(eventsOf(db, id, 'archived'), [{ actor: 'keshav', reason: 'already fixed in 3.74.20' }]);
  assert.deepEqual(eventsOf(db, id, 'not_needed'), [{ actor: 'keshav', reason: 'already fixed in 3.74.20', previous_status: 'claimed' }]);
});

test('on a job that is already archived it only adds the note: no error, no status change', (t) => {
  const { dir, db } = sandboxDb(t);
  const { id } = tasks.addTask(db, { title: 'Fix the form', workspaceRoot: dir });
  assert.equal(tasks.archiveTask(db, { id, actor: 'orb', reason: 'duplicate' }).archived, true);
  const before = tasks.getTask(db, id);

  const first = tasks.archiveNotNeeded(db, { id, actor: 'keshav', reason: 'it was already fixed' });
  assert.equal(first.archived, false);
  assert.equal(first.recorded, true);
  const second = tasks.archiveNotNeeded(db, { id, actor: 'keshav', reason: 'said it again' });
  assert.equal(second.recorded, true);

  const after = tasks.getTask(db, id);
  assert.equal(after.status, 'archived');
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(after.metadata.archived_by, 'orb', 'the original archive stays as it was');
  assert.equal(after.metadata.archived_reason, 'duplicate');
  assert.equal(eventsOf(db, id, 'archived').length, 1);
  assert.deepEqual(eventsOf(db, id, 'not_needed').map((e) => [e.actor, e.reason, e.previous_status]), [
    ['keshav', 'it was already fixed', 'archived'],
    ['keshav', 'said it again', 'archived'],
  ]);
});

test('it cannot rewrite a job that finished: done and failed stay as they are', (t) => {
  const { dir, db } = sandboxDb(t);
  const done = tasks.addTask(db, { title: 'finished', workspaceRoot: dir }).id;
  const failed = tasks.addTask(db, { title: 'failed', workspaceRoot: dir }).id;
  assert.equal(tasks.doneTask(db, { id: done, status: 'done', actor: 'codex' }).updated, true);
  assert.equal(tasks.doneTask(db, { id: failed, status: 'failed', actor: 'codex' }).updated, true);
  assert.deepEqual(tasks.archiveNotNeeded(db, { id: done, actor: 'keshav', reason: 'nope' }), { archived: false, recorded: false, reason: 'already_done' });
  assert.deepEqual(tasks.archiveNotNeeded(db, { id: failed, actor: 'keshav', reason: 'nope' }), { archived: false, recorded: false, reason: 'already_failed' });
  assert.equal(tasks.getTask(db, done).status, 'done');
  assert.equal(tasks.getTask(db, failed).status, 'failed');
  assert.deepEqual(eventsOf(db, done, 'not_needed'), []);
  assert.deepEqual(eventsOf(db, failed, 'not_needed'), []);
});

// ---------------------------------------------------------------------------
// The command line.

function cliWorkspace(t) {
  // The CLI records the real path of its folder, which is not the /var alias macOS gives mkdtemp.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'not-needed-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'));
  const dbPath = path.join(dir, 'tasks.db');
  const attempt = (args) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...scrubAgentEnv(), ATRIS_TASKS_DB: dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  const run = (args) => {
    const result = attempt(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    return result;
  };
  const create = (title, tag = 'code') => JSON.parse(run(['task', 'new', title, '--tag', tag, '--json']).stdout).task.display_id;
  const status = (id) => JSON.parse(run(['task', 'show', id, '--json']).stdout).status;
  const countEvents = (type) => {
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try { return reader.prepare('SELECT count(*) AS n FROM task_events WHERE event_type = ?').get(type).n; } finally { reader.close(); }
  };
  return { dir, dbPath, attempt, run, create, status, countEvents };
}

test('atris task archive --not-needed wants a reason, says who confirmed, and is calm when run twice', (t) => {
  const { attempt, run, create, status, countEvents } = cliWorkspace(t);
  const id = create('Fix the form so people stop retyping');

  const bare = attempt(['task', 'archive', id, '--not-needed']);
  assert.notEqual(bare.status, 0);
  assert.match(`${bare.stderr}${bare.stdout}`, /--not-needed requires --reason/);
  assert.equal(status(id), 'open', 'a refused call changes nothing');
  assert.equal(countEvents('not_needed'), 0);

  const first = JSON.parse(run(['task', 'archive', id, '--not-needed', '--reason', 'already fixed in 3.74.20', '--as', 'keshav', '--json']).stdout);
  assert.equal(first.ok, true);
  assert.equal(first.not_needed, true);
  assert.equal(first.not_needed_by, 'keshav');
  assert.equal(first.already_archived, false);
  assert.equal(first.reason, 'already fixed in 3.74.20');
  assert.equal(status(id), 'archived');

  const again = run(['task', 'archive', id, '--not-needed', '--reason', 'confirmed again', '--as', 'keshav']);
  assert.match(again.stdout, /was already archived; recorded as not needed by keshav: confirmed again/);
  const againJson = JSON.parse(run(['task', 'archive', id, '--not-needed', '--reason', 'and once more', '--as', 'keshav', '--json']).stdout);
  assert.equal(againJson.already_archived, true);
  assert.equal(status(id), 'archived');
  assert.equal(countEvents('archived'), 1);
  assert.equal(countEvents('not_needed'), 3);

  // Without the flag, archiving an archived job still fails exactly as before.
  const plain = attempt(['task', 'archive', id, '--reason', 'again']);
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /already_archived/);
  assert.equal(countEvents('not_needed'), 3);

  const text = run(['task', 'archive', create('A second job'), '--not-needed', '--reason', 'wrong ask']).stdout;
  assert.match(text, /archived .* as not needed: wrong ask/);
  assert.match(run(['task', 'archive', '--help']).stdout, /--not-needed/);
});

function ratingOf(cli, member) {
  return JSON.parse(cli.run(['rating', member, '--json']).stdout).member;
}

test('end to end: a worker\'s "already fixed" drop stops counting once another person confirms it', (t) => {
  const cli = cliWorkspace(t);
  const dropped = (title, as) => {
    const id = cli.create(title, 'feedback');
    cli.run(['task', 'claim', id, '--as', 'fleet-codex']);
    cli.run(['task', 'release', id, '--as', 'fleet-codex', '--reason', 'engine produced no work']);
    return id;
  };
  const confirmed = dropped('Form keeps what was typed');
  const selfCalled = dropped('Search box clears on submit');

  const before = ratingOf(cli, 'fleet-codex');
  assert.equal(before.finished, 2);
  assert.deepEqual(before.miss_reasons, [{ reason: 'engine produced no work', count: 2 }]);
  assert.equal(before.not_needed, undefined);

  // The worker cannot wave off its own drop...
  cli.run(['task', 'archive', selfCalled, '--not-needed', '--reason', 'I think this is done', '--as', 'fleet-codex']);
  const own = ratingOf(cli, 'fleet-codex');
  assert.equal(own.finished, 2);
  assert.equal(own.not_needed, undefined);

  // ...but a person can.
  cli.run(['task', 'archive', confirmed, '--not-needed', '--reason', 'already fixed on master', '--as', 'keshav']);
  const after = ratingOf(cli, 'fleet-codex');
  assert.equal(after.finished, 1);
  assert.equal(after.landed, 0);
  assert.equal(after.not_needed, 1);
  assert.deepEqual(after.miss_reasons, [{ reason: 'engine produced no work', count: 1 }]);

  const text = cli.run(['rating', 'fleet-codex']).stdout;
  assert.match(text, /landed 0 of 1 finished jobs/);
  assert.match(text, /not needed: 1 \(confirmed by someone else, so it does not count either way\)/);
});

// ---------------------------------------------------------------------------
// The rating: which drops it voids, and which it does not.

const SCHEMA = `CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,status TEXT,tag TEXT,workspace_root TEXT,claimed_by TEXT,claimed_at INTEGER,created_at INTEGER,updated_at INTEGER,metadata TEXT);
  CREATE TABLE task_events (event_id TEXT PRIMARY KEY,task_id TEXT,version INTEGER,workspace_root TEXT,actor TEXT,event_type TEXT,payload TEXT,created_at INTEGER)`;

// Each job is a list of [event type, actor, payload, at] rows, oldest first.
function seasonFrom(t, jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-needed-season-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'tasks.db');
  const now = Date.now();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);
    const insertTask = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)');
    const insertEvent = db.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let eventId = 0;
    for (const [name, events] of Object.entries(jobs)) {
      insertTask.run(name, name, 'archived', dir, now - 40 * DAY, now, '{}');
      events.forEach(([type, actor, payload, at], i) => insertEvent.run(String(++eventId), name, i + 1, dir, actor, type, JSON.stringify(payload), at));
    }
  } finally {
    db.close();
  }
  const season = loadSeason(dir, { dbPath, now, lastSeen: null });
  assert.equal(season.error, undefined);
  return { dir, season, now, base: now - 20 * DAY };
}

const playsOf = (season, name) => season.outcomes.filter((o) => o.task_id === name && o.kind !== 'took');
const kindsOf = (season, name) => playsOf(season, name).map((o) => o.kind);
const NOTICE = (actor, at, reason = 'already fixed') => ['not_needed', actor, { reason, previous_status: 'open' }, at];

test('a drop that someone else confirmed not needed becomes its own play and leaves the miss count', (t) => {
  const b = Date.now() - 20 * DAY;
  const dropped = (reason) => [['claimed', 'alpha', {}, b], ['claim_released', 'alpha', { reason, previous_claimed_by: 'alpha' }, b + HOUR]];
  const { season } = seasonFrom(t, {
    voided: [...dropped('engine produced no work'), ['archived', 'keshav', { reason: 'obsolete' }, b + 2 * HOUR], NOTICE('keshav', b + 2 * HOUR + 1, 'already fixed in 3.74.20')],
    // The same history, with nobody confirming it: still a drop.
    plain: dropped('engine produced no work'),
    land1: [['claimed', 'alpha', {}, b], ['proof_ready', 'alpha', { landing: { merge_commit: 'abcdef123456' } }, b + HOUR]],
    land2: [['claimed', 'alpha', {}, b], ['proof_ready', 'alpha', { landing: { merge_commit: 'abcdef123457' } }, b + HOUR]],
    land3: [['claimed', 'alpha', {}, b], ['proof_ready', 'alpha', { landing: { merge_commit: 'abcdef123458' } }, b + HOUR]],
  });
  assert.deepEqual(kindsOf(season, 'voided'), ['not_needed']);
  const [play] = playsOf(season, 'voided');
  assert.equal(play.member, 'alpha');
  assert.equal(play.reason, 'already fixed in 3.74.20', 'the person\'s reason replaces the worker\'s');
  assert.equal(play.confirmed_by, 'keshav');
  assert.deepEqual(kindsOf(season, 'plain'), ['dropped']);

  const row = rosterRows({ outcomes: season.outcomes, limit: 99 }).find((r) => r.name === 'alpha');
  // 3 landed + the confirmed one + the plain drop: only the plain drop counts against alpha.
  assert.equal(row.landed, 3);
  assert.equal(row.dropped, 1);
  assert.equal(row.finished, 4);
  assert.equal(row.not_needed, 1);
  assert.equal(row.took, 5);
  assert.equal(row.form.includes('d'), true);
});

test('with the confirmation, the member is rated as if the job was never taken', (t) => {
  const b = Date.now() - 20 * DAY;
  const lands = (n) => Object.fromEntries([1, 2, 3].map((i) => [`land${n}-${i}`, [['claimed', n, {}, b], ['proof_ready', n, { landing: { merge_commit: `abcdef12${i}${n.length}` } }, b + HOUR]]]));
  const drop = (n, ...notice) => ({ [`drop-${n}`]: [['claimed', n, {}, b], ['claim_released', n, { reason: 'engine produced no work' }, b + HOUR], ...notice] });
  const { season } = seasonFrom(t, {
    ...lands('alpha'), ...lands('beta'),
    ...drop('alpha', NOTICE('keshav', b + 2 * HOUR)),
    ...drop('beta'),
  });
  const rows = Object.fromEntries(rosterRows({ outcomes: season.outcomes, limit: 99 }).map((r) => [r.name, r]));
  assert.equal(rows.alpha.finished, 3);
  assert.equal(rows.beta.finished, 4);
  assert.ok(rows.alpha.ovr > rows.beta.ovr, `${rows.alpha.ovr} should beat ${rows.beta.ovr}`);
});

test('only another actor, only within seven days, and only after the miss can clear it', (t) => {
  const b = Date.now() - 20 * DAY;
  const miss = (...rest) => [['claimed', 'alpha', {}, b], ['claim_released', 'alpha', { reason: 'engine produced no work' }, b + HOUR], ...rest];
  const missAt = b + HOUR;
  const { season } = seasonFrom(t, {
    'by-the-holder': miss(NOTICE('alpha', missAt + 1)),
    'by-the-holder-spelled-differently': miss(NOTICE(' ALPHA ', missAt + 1)),
    'on-the-seventh-day': miss(NOTICE('keshav', missAt + 7 * DAY)),
    'a-moment-too-late': miss(NOTICE('keshav', missAt + 7 * DAY + 1)),
    'before-the-miss': [['claimed', 'alpha', {}, b], NOTICE('keshav', b + 1), ['claim_released', 'alpha', { reason: 'engine produced no work' }, missAt]],
    'someone-elses-job': miss(),
    'no-actor': miss(['not_needed', null, { reason: 'unsigned' }, missAt + 1]),
  });
  assert.deepEqual(kindsOf(season, 'by-the-holder'), ['dropped'], 'a member cannot void its own drop');
  assert.deepEqual(kindsOf(season, 'by-the-holder-spelled-differently'), ['dropped']);
  assert.deepEqual(kindsOf(season, 'on-the-seventh-day'), ['not_needed']);
  assert.deepEqual(kindsOf(season, 'a-moment-too-late'), ['dropped']);
  assert.deepEqual(kindsOf(season, 'before-the-miss'), ['dropped']);
  assert.deepEqual(kindsOf(season, 'someone-elses-job'), ['dropped']);
  assert.deepEqual(kindsOf(season, 'no-actor'), ['dropped'], 'an unsigned note cannot clear anything');
});

test('a notice on one job never clears another job, and never touches landed or sent-back work', (t) => {
  const b = Date.now() - 20 * DAY;
  const { season } = seasonFrom(t, {
    other: [['claimed', 'alpha', {}, b], ['claim_released', 'alpha', { reason: 'slow' }, b + HOUR]],
    named: [['claimed', 'beta', {}, b], ['claim_released', 'beta', { reason: 'slow' }, b + HOUR], NOTICE('keshav', b + 2 * HOUR)],
    landed: [['claimed', 'alpha', {}, b], ['proof_ready', 'alpha', { landing: { merge_commit: 'abcdef123456' } }, b + HOUR], NOTICE('keshav', b + 2 * HOUR)],
    sent: [['claimed', 'alpha', {}, b], ['revision_requested', 'reviewer', { reason: 'redo' }, b + HOUR], NOTICE('keshav', b + 2 * HOUR)],
  });
  assert.deepEqual(kindsOf(season, 'other'), ['dropped']);
  assert.deepEqual(kindsOf(season, 'named'), ['not_needed']);
  assert.deepEqual(kindsOf(season, 'landed'), ['landed']);
  assert.deepEqual(kindsOf(season, 'sent'), ['sent_back']);
});

test('an expired claim and a job archived while claimed are voided the same way', (t) => {
  const b = Date.now() - 20 * DAY;
  const { season } = seasonFrom(t, {
    expired: [['claimed', 'alpha', {}, b], ['claim_expired', 'auto', { claimed_by: 'alpha', lease_until: b + HOUR, reason: 'worker stopped' }, b + HOUR + 5], NOTICE('keshav', b + 2 * HOUR)],
    'expired-control': [['claimed', 'alpha', {}, b], ['claim_expired', 'auto', { claimed_by: 'alpha', lease_until: b + HOUR, reason: 'worker stopped' }, b + HOUR + 5]],
    abandoned: [['claimed', 'alpha', {}, b], ['archived', 'keshav', { reason: 'obsolete' }, b + HOUR], NOTICE('keshav', b + HOUR + 1)],
    'abandoned-control': [['claimed', 'alpha', {}, b], ['archived', 'keshav', { reason: 'obsolete' }, b + HOUR]],
  });
  assert.deepEqual(kindsOf(season, 'expired'), ['not_needed']);
  assert.deepEqual(kindsOf(season, 'expired-control'), ['dropped']);
  assert.deepEqual(kindsOf(season, 'abandoned'), ['not_needed']);
  assert.deepEqual(kindsOf(season, 'abandoned-control'), ['abandoned']);
});

test('atris rating shows the not-needed count on its own line, and not as a miss reason', (t) => {
  const b = Date.now() - 20 * DAY;
  const { dir, season } = seasonFrom(t, {
    voided: [['claimed', 'alpha', {}, b], ['claim_released', 'alpha', { reason: 'engine produced no work' }, b + HOUR], NOTICE('keshav', b + 2 * HOUR, 'already fixed')],
    plain: [['claimed', 'alpha', {}, b], ['claim_released', 'alpha', { reason: 'paused at verify: 1 failing test' }, b + HOUR]],
    only: [['claimed', 'gamma', {}, b], ['claim_released', 'gamma', { reason: 'engine produced no work' }, b + HOUR], NOTICE('keshav', b + 2 * HOUR)],
  });
  const ask = (...args) => {
    let out = '';
    assert.equal(ratingCommand(args, { root: dir, season, lineup: null, write: (s) => { out += s; } }), 0);
    return out;
  };
  const text = ask('alpha');
  assert.match(text, /landed 0 of 1 finished jobs/);
  assert.match(text, /not needed: 1 \(confirmed by someone else, so it does not count either way\)/);
  assert.match(text, /1: paused at verify: 1 failing test/);
  assert.doesNotMatch(text, /engine produced no work/);

  const member = JSON.parse(ask('alpha', '--json')).member;
  assert.equal(member.not_needed, 1);
  assert.deepEqual(member.miss_reasons, [{ reason: 'paused at verify: 1 failing test', count: 1 }]);

  // A member whose only miss was confirmed not needed still has somewhere to see it.
  const gamma = ask('gamma');
  assert.match(gamma, /landed 0 of 0 finished jobs/);
  assert.match(gamma, /not needed: 1 \(confirmed by someone else, so it does not count either way\)/);
  assert.doesNotMatch(gamma, /top miss reasons/);
  assert.equal(JSON.parse(ask('gamma', '--json')).member.finished, 0);
});

test('without any notice nothing changes: the member has no not-needed count at all', (t) => {
  const b = Date.now() - 20 * DAY;
  const { dir, season } = seasonFrom(t, {
    plain: [['claimed', 'alpha', {}, b], ['claim_released', 'alpha', { reason: 'slow' }, b + HOUR]],
  });
  let out = '';
  ratingCommand(['alpha', '--json'], { root: dir, season, lineup: null, write: (s) => { out += s; } });
  const member = JSON.parse(out).member;
  assert.equal(member.not_needed, undefined);
  assert.equal(member.finished, 1);
  assert.equal(rosterRows({ outcomes: season.outcomes, limit: 9 })[0].not_needed, 0);
});
