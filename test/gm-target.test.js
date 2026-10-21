'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const target = require('../lib/gm-target');
const { targetFromInput } = require('../commands/gm');
const { hasNodeSqlite } = require('./helpers/node-sqlite');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Wednesday 2026-10-21 12:00 local. Mondays: sep 21, sep 28, oct 5, oct 12, oct 19.
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
const OCT19 = new Date(2026, 9, 19).getTime();
const OCT12 = new Date(2026, 9, 12).getTime();
const OCT5 = new Date(2026, 9, 5).getTime();
const SEP28 = new Date(2026, 8, 28).getTime();

let seq = 0;
function play(kind, at, member = 'builder') {
  seq += 1;
  return { event_id: `e${seq}`, task_id: `t${seq}`, member, title: `job ${seq}`, kind, at, claimed_at: null };
}

function tempDir(prefix = 'atris-gm-target-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const T = (landed, maxAbandoned = 2, maxStuck = 0) => ({ landed, max_abandoned: maxAbandoned, max_stuck: maxStuck });

test('a target is saved against its week and carries forward until changed or cleared', () => {
  const dir = tempDir();
  try {
    const ws = path.join(dir, 'club');
    assert.deepEqual(target.readTargets(ws, { dir }), { weeks: {} });
    assert.equal(target.writeTarget(ws, T(8), { dir, now: OCT5 + 2 * DAY }), true);
    let store = target.readTargets(ws, { dir });
    assert.deepEqual(Object.keys(store.weeks), [String(OCT5)]);
    assert.equal(target.targetForWeek(store, SEP28), null);
    assert.deepEqual(target.targetForWeek(store, OCT5), T(8));
    assert.deepEqual(target.targetForWeek(store, OCT19), T(8), 'carries forward');
    target.writeTarget(ws, T(12, 1, 1), { dir, now: OCT12 + DAY });
    store = target.readTargets(ws, { dir });
    assert.deepEqual(target.targetForWeek(store, OCT5), T(8), 'the old week keeps its own target');
    assert.deepEqual(target.targetForWeek(store, OCT19), T(12, 1, 1));
    target.writeTarget(ws, { cleared: true }, { dir, now: OCT19 + HOUR });
    store = target.readTargets(ws, { dir });
    assert.equal(target.targetForWeek(store, OCT19), null);
    assert.deepEqual(target.targetForWeek(store, OCT12), T(12, 1, 1));
    // one small file per workspace, never inside the workspace
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.equal(fs.existsSync(path.join(ws, '.atris')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing, corrupt, or nonsense target file reads as no target and never throws', () => {
  const dir = tempDir();
  try {
    const ws = path.join(dir, 'club');
    target.writeTarget(ws, T(3), { dir, now: NOW });
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    fs.writeFileSync(file, 'not json');
    assert.deepEqual(target.readTargets(ws, { dir }), { weeks: {} });
    fs.writeFileSync(file, JSON.stringify({ weeks: { [OCT19]: { landed: 0, max_abandoned: 1, max_stuck: 0 }, junk: T(4) } }));
    assert.deepEqual(target.readTargets(ws, { dir }), { weeks: {} });
    assert.equal(target.writeTarget(ws, { landed: -1, max_abandoned: 0, max_stuck: 0 }, { dir, now: NOW }), false);
    const blocked = path.join(dir, 'a-file');
    fs.writeFileSync(blocked, 'x');
    assert.equal(target.writeTarget(ws, T(3), { dir: path.join(blocked, 'gm-targets'), now: NOW }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verdicts: behind and on track during the week, missed when a limit breaks, won only at the end', () => {
  const t = T(10, 2, 0);
  assert.equal(target.weekVerdict({ target: t, landed: 4, abandoned: 0, stuck: 0, over: false }), 'behind');
  assert.equal(target.weekVerdict({ target: t, landed: 10, abandoned: 2, stuck: 0, over: false }), 'on track');
  assert.equal(target.weekVerdict({ target: t, landed: 12, abandoned: 3, stuck: 0, over: false }), 'missed');
  assert.equal(target.weekVerdict({ target: t, landed: 12, abandoned: 0, stuck: 1, over: false }), 'missed');
  assert.equal(target.weekVerdict({ target: t, landed: 10, abandoned: 2, stuck: 0, over: true }), 'won');
  assert.equal(target.weekVerdict({ target: t, landed: 9, abandoned: 0, stuck: 0, over: true }), 'missed');
  assert.equal(target.weekVerdict({ target: t, landed: 20, abandoned: 3, stuck: 0, over: true }), 'missed');
});

test('the default target is the last 4 full weeks average landed, rounded up, at least 1', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => play('landed', SEP28 - 6 * DAY + i * DAY)),
    play('landed', OCT19 + HOUR),
    play('landed', SEP28 - 14 * DAY),
    play('dropped', OCT12 + DAY),
  ];
  assert.deepEqual(target.defaultTarget(rows, NOW), { landed: 3, max_abandoned: 2, max_stuck: 0 });
  assert.deepEqual(target.defaultTarget([], NOW), { landed: 1, max_abandoned: 2, max_stuck: 0 });
});

test('this week rolls over at monday 00:00 local', () => {
  const store = { weeks: { [String(OCT12)]: T(2, 0, 0) } };
  const rows = [
    play('landed', new Date(2026, 9, 18, 23, 59).getTime()),
    play('landed', OCT19),
    play('abandoned', OCT19 + HOUR),
  ];
  const status = target.currentStatus({ store, outcomes: rows, claims: [], now: NOW });
  assert.equal(status.week_of, OCT19);
  assert.equal(status.landed, 1);
  assert.equal(status.abandoned, 1);
  assert.equal(status.verdict, 'missed');
  assert.equal(target.targetLine(status), 'target: 1 of 2 landed | abandoned 1 of max 0 | stuck over a day 0, max 0 (missed)');
  const stuck = target.currentStatus({ store: { weeks: { [String(OCT19)]: T(5, 2, 0) } }, outcomes: [], claims: [{ member: 'a', last_event_at: NOW - 30 * HOUR }, { member: 'b', last_event_at: NOW - 2 * HOUR }], now: NOW });
  assert.equal(stuck.stuck, 1);
  assert.equal(target.currentStatus({ store: { weeks: {} }, outcomes: rows, claims: [], now: NOW }), null);
});

test('claims stuck over a day are counted at the moment a week ends', () => {
  const end = OCT19;
  const byTask = new Map([
    ['stale', [{ event_type: 'claimed', actor: 'a', created_at: end - 3 * DAY }]],
    ['fresh', [{ event_type: 'claimed', actor: 'b', created_at: end - 3 * DAY }, { event_type: 'message', actor: 'b', created_at: end - 2 * HOUR }]],
    ['released', [{ event_type: 'claimed', actor: 'c', created_at: end - 3 * DAY }, { event_type: 'claim_released', actor: 'c', created_at: end - 2 * DAY }]],
    ['later', [{ event_type: 'claimed', actor: 'd', created_at: end - 3 * DAY }, { event_type: 'completed', actor: 'x', created_at: end + HOUR }]],
  ]);
  assert.equal(target.stuckOverDayAt(byTask, end), 2);
});

test('the season record scores completed target weeks with the target in force then', () => {
  const store = { weeks: { [String(SEP28)]: T(2, 1, 0), [String(OCT12)]: T(3, 1, 0) } };
  const rows = [
    play('landed', SEP28 + DAY), play('landed', SEP28 + 2 * DAY),
    play('landed', OCT5 + DAY), play('abandoned', OCT5 + 2 * DAY), play('abandoned', OCT5 + 3 * DAY),
    play('landed', OCT12 + DAY), play('landed', OCT12 + 2 * DAY),
    play('landed', OCT19 + HOUR), play('landed', OCT19 + 2 * HOUR), play('landed', OCT19 + 3 * HOUR),
  ];
  const byTask = new Map([['jam', [{ event_type: 'claimed', actor: 'a', created_at: OCT12 - 3 * DAY }, { event_type: 'claim_released', actor: 'a', created_at: OCT12 + DAY }]]]);
  const record = target.seasonRecord({ store, outcomes: rows, eventsByTask: byTask, now: NOW });
  assert.deepEqual(record.weeks.map(w => [w.week_of, w.landed, w.abandoned, w.stuck, w.verdict]), [
    [SEP28, 2, 0, 0, 'won'],
    [OCT5, 1, 2, 1, 'missed'],
    [OCT12, 2, 0, 0, 'missed'],
  ]);
  assert.equal(record.won, 1);
  assert.equal(record.lost, 2);
  assert.equal(target.recordLine(record), 'season: 1 won, 2 lost');
  assert.deepEqual(target.seasonRecord({ store: { weeks: {} }, outcomes: rows, now: NOW }), { won: 0, lost: 0, weeks: [] });
});

test('typed target input keeps defaults on enter and refuses bad numbers', () => {
  const base = T(5, 2, 0);
  assert.deepEqual(targetFromInput(base, { landed: '', maxAbandoned: '', maxStuck: '' }), { target: T(5, 2, 0) });
  assert.deepEqual(targetFromInput(base, { landed: '8', maxAbandoned: '1' }), { target: T(8, 1, 0) });
  assert.match(targetFromInput(base, { landed: '0' }).error, /landed/);
  assert.match(targetFromInput(base, { maxAbandoned: 'two' }).error, /abandoned/);
  assert.match(targetFromInput(base, { maxStuck: '-1' }).error, /stuck/);
});

// ---- real CLI runs, with HOME inside the test --------------------------------

function makeDb(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const ws = require('../lib/task-db').workspaceRoot(dir);
  const dbPath = path.join(dir, 'tasks.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', tag TEXT,
      workspace_root TEXT NOT NULL, source_key TEXT, claimed_by TEXT, claimed_at INTEGER, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, done_at INTEGER, metadata TEXT);
    CREATE TABLE task_events (event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
      workspace_root TEXT NOT NULL, actor TEXT, event_type TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
  `);
  const now = Date.now();
  const add = db.prepare('INSERT INTO tasks (id, title, status, workspace_root, claimed_by, claimed_at, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const ev = db.prepare('INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('T1', 'ship the board', 'archived', ws, 'builder', now - 3 * HOUR, now - 4 * HOUR, now, '{}');
  ev.run('E1', 'T1', 1, ws, 'builder', 'claimed', '{}', now - 3 * HOUR);
  ev.run('E2', 'T1', 2, ws, 'autoland', 'completed', '{"action":"merged"}', now - 2 * HOUR);
  db.close();
  return { ws, dbPath };
}

function cli(dir, dbPath, args) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: path.join(dir, 'home'), ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

test('gm target sets, shows, and clears the target; the board and json carry it', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const { ws, dbPath } = makeDb(dir);
    const targetsDir = path.join(dir, 'home', '.atris', 'state', 'gm-targets');

    const none = cli(dir, dbPath, ['gm', 'target', '--workspace', dir]);
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /^no target for the week of .+\. suggested: 1 landed, at most 2 abandoned, at most 0 stuck over a day$/m);

    const set = cli(dir, dbPath, ['gm', 'target', '--landed', '3', '--max-abandoned', '1', '--workspace', dir]);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /target: 1 of 3 landed \| abandoned 0 of max 1 \| stuck over a day 0, max 0 \((behind|missed)\)/);
    assert.equal(fs.readdirSync(targetsDir).length, 1);
    assert.equal(fs.existsSync(path.join(ws, '.atris', 'state', 'gm-targets')), false);

    // a target from three weeks ago scores the completed weeks since
    target.writeTarget(ws, T(1, 2, 0), { dir: targetsDir, now: Date.now() - 21 * DAY });
    const board = cli(dir, dbPath, ['gm', '--board', '--workspace', dir]);
    assert.equal(board.status, 0, board.stderr);
    assert.match(board.stdout, /^front office \| .+ \| season: \d+ won, \d+ lost$/m);
    assert.match(board.stdout, /^target: 1 of 3 landed \| abandoned 0 of max 1 \| stuck over a day 0, max 0 \(/m);

    const json = cli(dir, dbPath, ['gm', '--board', '--json', '--workspace', dir]);
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.deepEqual(body.season.target.target, T(3, 1, 0));
    assert.equal(body.season.target.landed, 1);
    assert.ok(['behind', 'on track', 'missed'].includes(body.season.target.verdict));
    assert.equal(typeof body.season.record.won, 'number');
    assert.equal(body.season.record.won + body.season.record.lost, body.season.record.weeks.length);
    assert.ok(body.season.record.weeks.length >= 2);

    const bad = cli(dir, dbPath, ['gm', 'target', '--landed', 'lots', '--workspace', dir]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /landed takes a whole number/);

    const cleared = cli(dir, dbPath, ['gm', 'target', '--clear', '--workspace', dir]);
    assert.equal(cleared.status, 0, cleared.stderr);
    const after = cli(dir, dbPath, ['gm', '--board', '--workspace', dir]);
    assert.doesNotMatch(after.stdout, /^target:/m);

    // a corrupt target file never breaks the board
    fs.writeFileSync(path.join(targetsDir, fs.readdirSync(targetsDir)[0]), '{oops');
    const corrupt = cli(dir, dbPath, ['gm', '--board', '--workspace', dir]);
    assert.equal(corrupt.status, 0, corrupt.stderr);
    assert.doesNotMatch(corrupt.stdout, /^target:|season:/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the league shows a target column only when some club has a target', () => {
  const { renderLeagueLines } = require('../commands/gm');
  const season = require('../lib/gm-season');
  const outcomes = [play('landed', NOW - HOUR), play('landed', NOW - 2 * HOUR), play('dropped', NOW - 3 * HOUR)];
  const status = target.currentStatus({ store: { weeks: { [String(OCT19)]: T(5) } }, outcomes, claims: [], now: NOW });
  const rows = season.leagueRows([
    { root: '/w/alpha', outcomes, claims: [], target: status },
    { root: '/w/beta', outcomes, claims: [] },
  ], NOW);
  const text = renderLeagueLines({ now: NOW, days: 30, rows, hidden: 0 }).join('\n');
  assert.match(text, /^ {2}club +ovr +week +30d +drop +aband +stuck +last +target +best player$/m);
  assert.match(text, /^ {2}alpha +\d+ .* behind +builder/m);
  assert.match(text, /^ {2}beta +\d+ .* - +builder/m);
  const plain = renderLeagueLines({ now: NOW, days: 30, rows: rows.map(r => ({ ...r, target: null })), hidden: 0 }).join('\n');
  assert.doesNotMatch(plain, /target/);
});
