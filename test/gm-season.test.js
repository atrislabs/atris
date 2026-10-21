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

let seq = 0;
function play(member, kind, at, extra = {}) {
  seq += 1;
  return {
    event_id: `e${seq}`,
    task_id: `t-${member}-${at}`,
    member,
    title: `job at ${at}`,
    kind,
    at,
    claimed_at: null,
    landed_by: kind === 'landed' ? 'autoland' : null,
    ...extra,
  };
}

test('ovr is rookie under three finished jobs; took does not count', () => {
  assert.equal(season.ovr([]), null);
  const two = [play('a', 'took', 1), play('a', 'took', 2), play('a', 'took', 3), play('a', 'landed', 4), play('a', 'dropped', 5)];
  assert.equal(season.ovr(two), null);
  assert.equal(season.ovr([...two, play('a', 'sent_back', 6)]), Math.round(60 + 39 / 3));
});

test('ovr counts drops and send backs against landed', () => {
  const landed = Array.from({ length: 8 }, (_, i) => play('a', 'landed', i));
  const dropped = Array.from({ length: 15 }, (_, i) => play('a', 'dropped', 100 + i));
  const back = [play('a', 'sent_back', 200)];
  assert.equal(season.ovr([...landed, ...dropped, ...back]), Math.round(60 + 39 * 8 / 24));
  assert.equal(season.ovr([...landed, ...dropped, ...back]), 73);
  assert.equal(season.ovr(landed), 99);
  assert.equal(season.ovr(dropped), 60);
});

test('form shows the last five finished jobs with drops, oldest to newest', () => {
  const rows = [
    play('a', 'landed', 70),
    play('a', 'sent_back', 10),
    play('a', 'took', 75),
    play('a', 'dropped', 20),
    play('a', 'dropped', 60),
    play('a', 'landed', 30),
    play('a', 'landed', 40),
  ];
  assert.equal(season.form(rows), 'dkkdk');
  assert.equal(season.form(rows.slice(0, 2)), 'xk');
  assert.equal(season.form([play('a', 'took', 1)]), '');
});

test('plays come from events with the right member for each kind', () => {
  const rows = [
    { event_id: '1', task_id: 'a', event_type: 'claimed', actor: 'builder', payload: '{"claimed_by":"builder"}', created_at: 10, claimed_by: 'someone-else', title: 'one' },
    { event_id: '2', task_id: 'a', event_type: 'completed', actor: 'autoland', payload: '{"action":"merged","auto_accepted":true}', created_at: 20, claimed_by: 'someone-else', claim_actor: 'builder', claim_event_at: 10, title: 'one' },
    { event_id: '3', task_id: 'b', event_type: 'completed', actor: 'keshavrao', payload: '{"action":"accepted"}', created_at: 30, claimed_by: 'scout', title: 'two' },
    { event_id: '4', task_id: 'c', event_type: 'completed', actor: 'keshavrao', payload: '{"action":"archived"}', created_at: 40, claimed_by: 'scout', title: 'three' },
    { event_id: '5', task_id: 'd', event_type: 'claim_released', actor: 'keshavrao', payload: '{"released_by":"keshavrao","previous_claimed_by":"architect"}', created_at: 50, title: 'four', claim_event_at: 45 },
    { event_id: '6', task_id: 'e', event_type: 'claim_released', actor: 'executor', payload: '{}', created_at: 60, title: 'five' },
    { event_id: '7', task_id: 'f', event_type: 'revision_requested', actor: 'keshavrao', payload: '{"note":"redo"}', created_at: 70, claimed_by: 'builder', title: 'six' },
    { event_id: '8', task_id: 'g', event_type: 'reopened', actor: 'keshavrao', payload: null, created_at: 80, claimed_by: null, claim_actor: 'generalist', title: 'seven' },
    { event_id: '9', task_id: 'h', event_type: 'completed', actor: 'orb-autoaccept', payload: '{"action":"accepted"}', created_at: 90, claimed_by: 'builder', title: 'eight' },
    { event_id: '10', task_id: 'i', event_type: 'completed', actor: 'x', payload: 'not json', created_at: 95, claimed_by: 'builder', title: 'nine' },
  ];
  const out = season.outcomesFromEvents(rows);
  assert.deepEqual(out.map(o => [o.event_id, o.kind, o.member, o.landed_by]), [
    ['1', 'took', 'builder', null],
    ['2', 'landed', 'builder', 'autoland'],
    ['3', 'landed', 'scout', 'you'],
    ['5', 'dropped', 'architect', null],
    ['6', 'dropped', 'executor', null],
    ['7', 'sent_back', 'builder', null],
    ['8', 'sent_back', 'generalist', null],
    ['9', 'landed', 'builder', 'autoland'],
  ]);
  assert.equal(out[0].claimed_at, null);
  assert.equal(out[1].claimed_at, 10);
  assert.equal(out[3].claimed_at, 45);
});

test('box scores are the last five finished jobs, drops included, with hours from claim', () => {
  const rows = [
    play('a', 'landed', NOW - 10 * HOUR, { claimed_at: NOW - 12.5 * HOUR }),
    play('b', 'sent_back', NOW - 5 * HOUR, { claimed_at: NOW - 6 * HOUR, title: 'a title that is long enough to need clipping on the board' }),
    play('c', 'dropped', NOW - 4 * HOUR, { claimed_at: null }),
    play('z', 'took', NOW - 3.5 * HOUR),
    play('d', 'landed', NOW - 3 * HOUR, { claimed_at: NOW - 2 * HOUR }),
    play('e', 'dropped', NOW - 2 * HOUR, { claimed_at: NOW - 2.25 * HOUR }),
    play('f', 'landed', NOW - HOUR, { claimed_at: NOW - 30 * HOUR }),
  ];
  const box = season.boxScores(rows);
  assert.deepEqual(box.map(b => b.member), ['f', 'e', 'd', 'c', 'b']);
  assert.deepEqual(box.map(b => b.outcome), ['landed', 'dropped', 'landed', 'dropped', 'sent back']);
  assert.deepEqual(box.map(b => b.hours), [29, 0.3, null, null, 1]);
  assert.ok(box[4].title.length <= 42);
  assert.ok(box[4].title.endsWith('...'));
});

test('owner line splits landed by autoland and by you, this week only', () => {
  assert.equal(season.weekStart(NOW), MONDAY);
  const rows = [
    play('a', 'landed', MONDAY - 1),
    play('a', 'dropped', MONDAY - HOUR),
    play('a', 'landed', MONDAY),
    play('a', 'landed', MONDAY + HOUR, { landed_by: 'you' }),
    play('b', 'landed', MONDAY + 2 * HOUR),
    play('b', 'sent_back', NOW - HOUR),
    play('b', 'dropped', NOW - 2 * HOUR),
    play('b', 'dropped', NOW - 3 * HOUR),
    play('b', 'took', NOW - 4 * HOUR),
  ];
  const mood = season.ownerMood(rows, NOW);
  assert.equal(mood.line, 'this week: 2 landed by autoland, 1 by you, 1 sent back, 2 dropped');
  const sunday = new Date(2026, 9, 25, 23, 59).getTime();
  assert.equal(season.weekStart(sunday), MONDAY);
});

test('roster sorts by ovr with rookies last and shows landed of took', () => {
  const rows = [
    ...[1, 2, 3, 4].map(at => play('sloppy', 'took', at)),
    play('sloppy', 'landed', 5), play('sloppy', 'dropped', 6), play('sloppy', 'dropped', 7),
    ...[1, 2, 3].map(at => play('clean', 'took', at)),
    play('clean', 'landed', 8), play('clean', 'landed', 9), play('clean', 'landed', 10),
    play('new', 'took', 11), play('new', 'landed', 12),
  ];
  const roster = season.rosterRows({ outcomes: rows, busy: ['clean', 'waiting'], asleep: ['sloppy'] });
  assert.deepEqual(roster.map(r => r.name), ['clean', 'sloppy', 'new', 'waiting']);
  assert.deepEqual([roster[0].ovr, roster[0].landed, roster[0].took, roster[0].status], [99, 3, 3, 'on a job']);
  assert.deepEqual([roster[1].ovr, roster[1].landed, roster[1].took, roster[1].form, roster[1].status], [73, 1, 4, 'kdd', 'asleep']);
  assert.equal(roster[2].ovr, null);
  assert.equal(roster[3].took, 0);
  assert.equal(season.rosterRows({ outcomes: rows, limit: 2 }).length, 2);
});

test('last plays are the newest five of any kind and tag plays not seen before', () => {
  const rows = [1, 2, 3, 4, 5, 6].map(i => play('a', i % 2 ? 'took' : 'landed', NOW - i * HOUR));
  const first = season.lastPlays(rows);
  assert.equal(first.length, 5);
  assert.equal(first[0].at, NOW - HOUR);
  assert.equal(first[0].play, 'took');
  assert.ok(first.every(p => !p.fresh));
  const seen = new Set(first.map(p => p.id));
  const newer = play('b', 'dropped', NOW);
  const second = season.lastPlays([...rows, newer], 5, seen);
  assert.deepEqual(second.map(p => p.fresh), [true, false, false, false, false]);
  assert.equal(second[0].play, 'dropped');
});

test('clock labels use local time and add the date for other days', () => {
  assert.equal(season.clockLabel(new Date(2026, 9, 21, 20, 4).getTime(), NOW), '8:04 pm');
  assert.equal(season.clockLabel(new Date(2026, 9, 21, 0, 15).getTime(), NOW), '12:15 am');
  assert.equal(season.clockLabel(new Date(2026, 9, 14, 23, 57).getTime(), NOW), 'oct 14 11:57 pm');
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

function fixtureBoard(seen = null) {
  const rows = [
    play('builder', 'took', NOW - 6 * HOUR, { title: 'ship the board' }),
    play('builder', 'landed', NOW - 3 * HOUR, { claimed_at: NOW - 5 * HOUR, title: 'ship the board' }),
    play('builder', 'landed', NOW - 2 * HOUR, { claimed_at: NOW - 3 * HOUR, title: 'fix the loader', landed_by: 'you' }),
    play('builder', 'dropped', NOW - HOUR, { claimed_at: NOW - 2 * HOUR, title: 'tidy the help' }),
    play('scout', 'sent_back', NOW - 30 * HOUR, { title: 'look around' }),
  ];
  return season.seasonBoard({
    workspace_name: 'demo',
    now: NOW,
    outcomes: rows,
    busy: ['builder'],
    asleep: ['scout'],
    open_tasks: [{ ref: 'CLI-7', title: 'write the docs', created_at: 1 }],
    missions: [],
  }, { seen });
}

test('board renders one lowercase screen with record, box scores, last plays, and key', () => {
  const lines = renderBoardLines(fixtureBoard());
  const text = lines.join('\n');
  assert.ok(lines.length <= 40, `board is ${lines.length} rows`);
  assert.equal(lines[0], 'front office | demo | week of oct 19');
  assert.equal(lines[1], 'this week: 1 landed by autoland, 1 by you, 1 sent back, 1 dropped');
  assert.match(text, /^ {2}builder +86 +kkd +landed 2 of 3 +on a job$/m);
  assert.match(text, /^ {2}scout +rookie +x +landed 0 of 1 +asleep$/m);
  assert.match(text, /^ {2}builder +dropped +1h +tidy the help$/m);
  assert.match(text, /^ {2}11:00 am +builder dropped +tidy the help$/m);
  assert.match(text, /^ {2}oct 20 6:00 am +scout sent back +look around$/m);
  assert.match(text, /^ {2}CLI-7 +write the docs$/m);
  assert.match(text, /stricter than the website rating on purpose/);
  assert.match(text, /k landed, d dropped, x sent back/);
  assert.match(text, /run atris gm in a terminal to play/);
  assert.doesNotMatch(text, /\bnew$/m);
  assert.doesNotMatch(text, /—/);
  assert.doesNotMatch(text, /\b[A-Z]{3,}\b(?<!CLI)/);
  const interactive = renderBoardLines(fixtureBoard(new Set()), { interactive: true }).join('\n');
  assert.match(interactive, /p play {2}r run {2}w wake {2}s sleep {2}l landing check {2}enter refresh {2}q quit/);
  assert.match(interactive, /tidy the help {2}new$/m);
});

test('play keys map to exact commands and every agent start asks for y', () => {
  assert.deepEqual(playAction('r', { name: 'builder', job: 'fix the help' }), { args: ['member', 'run', 'builder', 'fix the help'], confirm: true });
  assert.deepEqual(playAction('w', { name: 'builder' }), { args: ['member', 'wake', 'builder'], confirm: true });
  assert.deepEqual(playAction('s', { name: 'builder' }), { args: ['member', 'sleep', 'builder'], confirm: false });
  assert.deepEqual(playAction('l'), { args: ['land', '--dry-run'], confirm: false });
  assert.equal(playAction('r', { name: 'bad name; rm -rf' }), null);
  assert.equal(displayCommand(['member', 'run', 'builder', 'fix the help']), 'atris member run builder "fix the help"');
});

test('p picks one bounded wake for a name and a timed team session for a count', () => {
  assert.deepEqual(playAction('p', { who: 'builder', minutes: '45' }),
    { args: ['member', 'wake', 'builder', '--minutes', '45'], confirm: true, stopAfterMs: null, minutes: 45 });
  assert.deepEqual(playAction('p', { who: '', minutes: '' }),
    { args: ['member', 'wake', '3'], confirm: true, stopAfterMs: 30 * 60 * 1000, minutes: 30 });
  assert.deepEqual(playAction('p', { who: 'builder, scout', minutes: '10' }),
    { args: ['member', 'wake', 'builder', 'scout'], confirm: true, stopAfterMs: 10 * 60 * 1000, minutes: 10 });
  assert.equal(playAction('p', { who: '3', minutes: '0' }), null);
  assert.equal(playAction('p', { who: '3', minutes: 'soon' }), null);
  assert.equal(playAction('p', { who: '50', minutes: '30' }), null);
  assert.equal(playAction('p', { who: 'bad;name', minutes: '30' }), null);
});

test('gm --board reads a real task db and prints honest records', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gm-season-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
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
    addTask.run('T4', 'abandoned job', 'open', ws, null, null, now - 5 * HOUR, now, '{}');
    addEvent.run('E1', 'T1', ws, 'builder', 'claimed', '{"claimed_by":"builder"}', now - 3 * HOUR);
    addEvent.run('E2', 'T1', ws, 'autoland', 'completed', '{"action":"merged","auto_accepted":true}', now - HOUR);
    addEvent.run('E3', 'T3', '/elsewhere', 'autoland', 'completed', '{"action":"merged"}', now - HOUR);
    addEvent.run('E4', 'T4', ws, 'builder', 'claimed', '{"claimed_by":"builder"}', now - 5 * HOUR);
    addEvent.run('E5', 'T4', ws, 'builder', 'claim_released', '{"released_by":"builder","previous_claimed_by":"builder"}', now - 4 * HOUR);
    db.close();

    const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'gm', '--board', '--workspace', dir], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^front office \| /m);
    assert.match(res.stdout, /^ {2}builder +rookie +dk +landed 1 of 2 +idle$/m);
    assert.match(res.stdout, /^ {2}builder +landed +2h +ship the board$/m);
    assert.match(res.stdout, /^ {2}builder +dropped +1h +abandoned job$/m);
    assert.match(res.stdout, /builder took +abandoned job/);
    assert.doesNotMatch(res.stdout, /other workspace job/);
    assert.doesNotMatch(res.stdout, /AgentXP General Manager/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
