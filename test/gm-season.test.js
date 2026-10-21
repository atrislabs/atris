'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const season = require('../lib/gm-season');
const { renderBoardLines, playAction, displayCommand } = require('../commands/gm');
const { hasNodeSqlite } = require('./helpers/node-sqlite');

const HOUR = 60 * 60 * 1000;
// Wednesday 2026-10-21 12:00 local time. Monday of that week is 2026-10-19.
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
const MONDAY = new Date(2026, 9, 19, 0, 0, 0).getTime();

function result(member, verdict, at, claimedAt = null, title = `job at ${at}`) {
  return { task_id: `t-${member}-${at}`, member, title, verdict, at, claimed_at: claimedAt };
}

test('ovr is rookie under three graded results', () => {
  assert.equal(season.ovr([]), null);
  assert.equal(season.ovr([result('a', 'kept', 1), result('a', 'kept', 2)]), null);
  assert.equal(season.ovr([result('a', 'kept', 1), result('a', 'kept', 2), result('a', 'sent_back', 3)]), 86);
});

test('ovr follows round(60 + 39 * kept / graded)', () => {
  const allKept = [1, 2, 3].map(at => result('a', 'kept', at));
  assert.equal(season.ovr(allKept), 99);
  const allBack = [1, 2, 3].map(at => result('a', 'sent_back', at));
  assert.equal(season.ovr(allBack), 60);
  const mixed = [
    ...Array.from({ length: 15 }, (_, i) => result('a', 'kept', i)),
    result('a', 'sent_back', 99),
  ];
  assert.equal(season.ovr(mixed), Math.round(60 + 39 * 15 / 16));
  assert.equal(season.ovr(mixed), 97);
});

test('form shows the last five oldest to newest, whatever the input order', () => {
  const rows = [
    result('a', 'kept', 70),
    result('a', 'sent_back', 10),
    result('a', 'kept', 20),
    result('a', 'sent_back', 60),
    result('a', 'kept', 30),
    result('a', 'kept', 40),
  ];
  assert.equal(season.form(rows), 'kkkxk');
  assert.equal(season.form(rows.slice(0, 2)), 'xk');
  assert.equal(season.form([]), '');
});

test('box scores are the last five, newest first, with hours from claim to result', () => {
  const rows = [
    result('a', 'kept', NOW - 10 * HOUR, NOW - 12.5 * HOUR, 'oldest'),
    result('b', 'sent_back', NOW - 5 * HOUR, NOW - 6 * HOUR, 'a title that is long enough to need clipping on the board'),
    result('c', 'kept', NOW - 4 * HOUR, null, 'no claim time'),
    result('d', 'kept', NOW - 3 * HOUR, NOW - 2 * HOUR, 'claim after result'),
    result('e', 'kept', NOW - 2 * HOUR, NOW - 2.25 * HOUR, 'quick'),
    result('f', 'kept', NOW - HOUR, NOW - 30 * HOUR, 'newest'),
  ];
  const box = season.boxScores(rows);
  assert.equal(box.length, 5);
  assert.deepEqual(box.map(b => b.member), ['f', 'e', 'd', 'c', 'b']);
  assert.equal(box[0].hours, 29);
  assert.equal(box[1].hours, 0.3);
  assert.equal(box[2].hours, null);
  assert.equal(box[3].hours, null);
  assert.equal(box[4].hours, 1);
  assert.equal(box[4].outcome, 'sent back');
  assert.equal(box[0].outcome, 'kept');
  assert.ok(box[4].title.length <= 42);
  assert.ok(box[4].title.endsWith('...'));
});

test('owner mood counts only this week, starting monday 00:00 local', () => {
  assert.equal(season.weekStart(NOW), MONDAY);
  const rows = [
    result('a', 'kept', MONDAY - 1),
    result('a', 'sent_back', MONDAY - HOUR),
    result('a', 'kept', MONDAY),
    result('b', 'kept', MONDAY + HOUR),
    result('b', 'sent_back', NOW - HOUR),
  ];
  const mood = season.ownerMood(rows, NOW);
  assert.equal(mood.kept, 2);
  assert.equal(mood.sent_back, 1);
  assert.equal(mood.line, 'this week: 2 kept, 1 sent back');
  // A sunday night still belongs to the week that started the monday before.
  const sunday = new Date(2026, 9, 25, 23, 59).getTime();
  assert.equal(season.weekStart(sunday), MONDAY);
});

test('roster ranks by graded results, marks asleep and on a job, and caps at the limit', () => {
  const rows = [
    result('busy', 'kept', 1), result('busy', 'kept', 2), result('busy', 'kept', 3),
    result('sleepy', 'kept', 4), result('sleepy', 'sent_back', 5),
    result('quiet', 'kept', 6),
  ];
  const roster = season.rosterRows({ results: rows, busy: ['busy', 'newcomer'], asleep: ['sleepy'] });
  assert.deepEqual(roster.map(r => r.name), ['busy', 'sleepy', 'quiet', 'newcomer']);
  assert.equal(roster[0].status, 'on a job');
  assert.equal(roster[0].ovr, 99);
  assert.equal(roster[1].status, 'asleep');
  assert.equal(roster[1].ovr, null);
  assert.equal(roster[1].form, 'kx');
  assert.equal(roster[2].status, 'idle');
  assert.equal(roster[3].form, '');
  assert.equal(season.rosterRows({ results: rows, busy: ['newcomer'], limit: 2 }).length, 2);
});

test('results come from completed accepted or merged and from revision requests', () => {
  const rows = [
    { task_id: 'a', event_type: 'completed', payload: '{"action":"merged"}', created_at: 10, claimed_by: 'builder', title: 'one', claim_event_at: 4 },
    { task_id: 'b', event_type: 'completed', payload: '{"action":"accepted"}', created_at: 20, claimed_by: 'builder', title: 'two', claimed_at: 5 },
    { task_id: 'c', event_type: 'completed', payload: '{"action":"archived"}', created_at: 30, claimed_by: 'builder', title: 'three' },
    { task_id: 'd', event_type: 'revision_requested', payload: '{"note":"redo"}', created_at: 40, claimed_by: 'builder', title: 'four' },
    { task_id: 'e', event_type: 'completed', payload: 'not json', created_at: 50, claimed_by: 'builder', title: 'five' },
    { task_id: 'f', event_type: 'revision_requested', payload: null, created_at: 60, claimed_by: null, claim_actor: 'scout', title: 'six' },
  ];
  const out = season.resultsFromEvents(rows);
  assert.deepEqual(out.map(r => [r.task_id, r.verdict, r.member]), [
    ['a', 'kept', 'builder'],
    ['b', 'kept', 'builder'],
    ['d', 'sent_back', 'builder'],
    ['f', 'sent_back', 'scout'],
  ]);
  assert.equal(out[0].claimed_at, 4);
  assert.equal(out[1].claimed_at, 5);
});

test('up next lists open tasks first, then running or ready missions, three at most', () => {
  const items = season.upNext({
    openTasks: [
      { ref: 'CLI-2', title: 'second', created_at: 2 },
      { ref: 'CLI-1', title: 'first', created_at: 1 },
    ],
    missions: [
      { id: 'm1', objective: 'done already', status: 'complete' },
      { id: 'm2', objective: 'keep going', status: 'running', owner: 'architect' },
      { id: 'm3', objective: 'extra', status: 'ready' },
    ],
  });
  assert.deepEqual(items.map(i => i.ref || i.title), ['CLI-1', 'CLI-2', 'keep going']);
  assert.equal(items[2].owner, 'architect');
});

function fixtureBoard() {
  const rows = [
    result('builder', 'kept', NOW - 3 * HOUR, NOW - 5 * HOUR, 'ship the board'),
    result('builder', 'kept', NOW - 2 * HOUR, NOW - 3 * HOUR, 'fix the loader'),
    result('builder', 'sent_back', NOW - HOUR, NOW - 2 * HOUR, 'tidy the help'),
    result('scout', 'kept', NOW - 30 * HOUR, null, 'look around'),
  ];
  return season.seasonBoard({
    workspace_name: 'demo',
    now: NOW,
    results: rows,
    busy: ['builder'],
    asleep: ['scout'],
    open_tasks: [{ ref: 'CLI-7', title: 'write the docs', created_at: 1 }],
    missions: [],
  });
}

test('board renders one lowercase screen with roster, box scores, up next, and key', () => {
  const lines = renderBoardLines(fixtureBoard());
  const text = lines.join('\n');
  assert.ok(lines.length <= 40, `board is ${lines.length} rows`);
  assert.equal(lines[0], 'front office | demo | week of oct 19');
  assert.equal(lines[1], 'this week: 3 kept, 1 sent back');
  assert.match(text, /^ {2}builder +86 +kkx +on a job$/m);
  assert.match(text, /^ {2}scout +rookie +k +asleep$/m);
  assert.match(text, /^ {2}builder +sent back +1h +tidy the help$/m);
  assert.match(text, /^ {2}scout +kept +- +look around$/m);
  assert.match(text, /^ {2}CLI-7 +write the docs$/m);
  assert.match(text, /run atris gm in a terminal to play/);
  assert.doesNotMatch(text, /—/);
  assert.doesNotMatch(text, /\b[A-Z]{3,}\b(?<!CLI)/);
  const interactive = renderBoardLines(fixtureBoard(), { interactive: true }).join('\n');
  assert.match(interactive, /r run {2}w wake {2}s sleep {2}l landing check {2}enter refresh {2}q quit/);
});

test('play keys map to exact commands and only r and w ask for y', () => {
  assert.deepEqual(playAction('r', { name: 'builder', job: 'fix the help' }), { args: ['member', 'run', 'builder', 'fix the help'], confirm: true });
  assert.deepEqual(playAction('r', { name: 'builder' }), { args: ['member', 'run', 'builder'], confirm: true });
  assert.deepEqual(playAction('w', { name: 'builder' }), { args: ['member', 'wake', 'builder'], confirm: true });
  assert.deepEqual(playAction('s', { name: 'builder' }), { args: ['member', 'sleep', 'builder'], confirm: false });
  assert.deepEqual(playAction('l'), { args: ['land', '--dry-run'], confirm: false });
  assert.equal(playAction('r', { name: 'bad name; rm -rf' }), null);
  assert.equal(displayCommand(['member', 'run', 'builder', 'fix the help']), 'atris member run builder "fix the help"');
  assert.equal(displayCommand(['land', '--dry-run']), 'atris land --dry-run');
});

test('gm --board reads a real task db and prints the board once', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gm-season-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'member-switches.json'), JSON.stringify({ members: { scout: { awake: false } } }));
    const dbPath = path.join(dir, 'tasks.db');
    const { DatabaseSync } = require('node:sqlite');
    const taskDb = require('../lib/task-db');
    const ws = taskDb.workspaceRoot(dir);
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', tag TEXT,
        workspace_root TEXT NOT NULL, source_key TEXT, claimed_by TEXT, claimed_at INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, done_at INTEGER, metadata TEXT);
      CREATE TABLE task_events (event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
        workspace_root TEXT NOT NULL, actor TEXT, event_type TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
    `);
    const now = Date.now();
    const addTask = db.prepare('INSERT INTO tasks (id, title, status, workspace_root, claimed_by, claimed_at, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const addEvent = db.prepare('INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)');
    addTask.run('T1', 'ship the board', 'archived', ws, 'builder', now - 3 * HOUR, now - 4 * HOUR, now, '{}');
    addTask.run('T2', 'write the docs', 'open', ws, null, null, now - HOUR, now, '{}');
    addTask.run('T3', 'other workspace job', 'archived', '/elsewhere', 'builder', now - 3 * HOUR, now - 4 * HOUR, now, '{}');
    addEvent.run('E1', 'T1', ws, 'builder', 'claimed', '{}', now - 3 * HOUR);
    addEvent.run('E2', 'T1', ws, 'autoland', 'completed', '{"action":"merged"}', now - HOUR);
    addEvent.run('E3', 'T3', '/elsewhere', 'autoland', 'completed', '{"action":"merged"}', now - HOUR);
    db.close();

    const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'gm', '--board', '--workspace', dir], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^front office \| /m);
    assert.match(res.stdout, /^ {2}builder +rookie +k +idle$/m);
    assert.match(res.stdout, /^ {2}builder +kept +2h +ship the board$/m);
    assert.match(res.stdout, /write the docs/);
    assert.doesNotMatch(res.stdout, /other workspace job/);
    assert.doesNotMatch(res.stdout, /AgentXP General Manager/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
