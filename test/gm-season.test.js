'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const season = require('../lib/gm-season');
const { renderBoardLines, renderLeagueLines, pickClub, playAction, displayCommand } = require('../commands/gm');
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

test('abandoned jobs count against ovr and in jobs; took does not', () => {
  const rows = [
    ...Array.from({ length: 44 }, (_, i) => play('integrator', 'landed', i)),
    ...Array.from({ length: 31 }, (_, i) => play('integrator', 'abandoned', 100 + i)),
    ...Array.from({ length: 10 }, (_, i) => play('integrator', 'took', 200 + i)),
  ];
  assert.equal(season.ovr(rows), Math.round(60 + 39 * 44 / 75));
  assert.equal(season.ovr(rows), 83);
  const [row] = season.rosterRows({ outcomes: rows });
  assert.deepEqual([row.landed, row.abandoned, row.jobs, row.took], [44, 31, 75, 10]);
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
  assert.equal(season.form([...rows, play('a', 'abandoned', 80)]), 'kkdka');
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
    { event_id: '11', task_id: 'j', event_type: 'archived', actor: 'keshavrao', payload: '{}', created_at: 96, claimed_by: null, claim_actor: 'scout', claim_event_id: 'c11', abandons: 1, title: 'ten' },
    { event_id: '12', task_id: 'k', event_type: 'archived', actor: 'keshavrao', payload: '{}', created_at: 97, claim_actor: 'scout', claim_event_id: 'c12', abandons: 0, title: 'landed first' },
    { event_id: '13', task_id: 'l', event_type: 'archived', actor: 'keshavrao', payload: '{}', created_at: 98, claimed_by: 'scout', abandons: 1, title: 'never claimed' },
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
    ['11', 'abandoned', 'scout', null],
  ]);
  assert.equal(out[0].claimed_at, null);
  assert.equal(out[1].claimed_at, 10);
  assert.equal(out[3].claimed_at, 45);
});

test('owner line splits landed by autoland and by you, this week only, and counts stuck', () => {
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
    play('b', 'abandoned', NOW - 5 * HOUR),
    play('b', 'abandoned', MONDAY - 5 * HOUR),
  ];
  const mood = season.ownerMood(rows, NOW, 3);
  assert.equal(mood.line, 'this week: 2 landed by autoland, 1 by you, 1 sent back, 2 dropped, 1 abandoned, 3 stuck');
  const sunday = new Date(2026, 9, 25, 23, 59).getTime();
  assert.equal(season.weekStart(sunday), MONDAY);
});

function claim(member, ageMs, ref = `CLI-${member.length}`, title = `${member} job`) {
  return { task_id: `id-${member}-${ageMs}`, ref, title, member, last_event_at: NOW - ageMs };
}

test('age labels round to minutes, hours, then days', () => {
  assert.equal(season.ageLabel(20 * 60 * 1000), '20m');
  assert.equal(season.ageLabel(7.2 * HOUR), '7h');
  assert.equal(season.ageLabel(23.4 * HOUR), '23h');
  assert.equal(season.ageLabel(36 * HOUR), '2d');
  assert.equal(season.ageLabel(4 * 24 * HOUR), '4d');
});

test('a claim is on a job under 6h without a move, stuck at 6h and after', () => {
  const roster = season.rosterRows({
    claims: [
      claim('fresh', 6 * HOUR - 60 * 1000),
      claim('edge', 6 * HOUR),
      claim('old', 4 * 24 * HOUR),
      claim('sleepy', 10 * HOUR),
    ],
    missions: [
      { owner: 'pilot', status: 'running', last_at: NOW - HOUR },
      { owner: 'ghost', status: 'running', last_at: NOW - 2 * 24 * HOUR },
    ],
    asleep: ['sleepy'],
    now: NOW,
    limit: 10,
  });
  const status = Object.fromEntries(roster.map(r => [r.name, r.status]));
  assert.deepEqual(status, { edge: 'stuck 6h', fresh: 'on a job', old: 'stuck 4d', pilot: 'on a job', sleepy: 'asleep' });
});

test('a member with a live claim and a stuck one is on a job; stuck shows the freshest stale age', () => {
  const both = season.rosterRows({ claims: [claim('a', HOUR), claim('a', 3 * 24 * HOUR)], now: NOW });
  assert.equal(both[0].status, 'on a job');
  const twoStale = season.rosterRows({ claims: [claim('a', 9 * HOUR), claim('a', 3 * 24 * HOUR)], now: NOW });
  assert.equal(twoStale[0].status, 'stuck 9h');
});

test('stuck rows list stale claims oldest first, five at most, with the task id', () => {
  const claims = [
    claim('a', HOUR, 'CLI-1'),
    claim('b', 7 * HOUR, 'CLI-2'),
    claim('c', 5 * 24 * HOUR, 'CLI-3'),
    claim('d', 2 * 24 * HOUR, 'CLI-4'),
    claim('e', 3 * 24 * HOUR, 'CLI-5'),
    claim('f', 4 * 24 * HOUR, 'CLI-6'),
    claim('g', 9 * HOUR, 'CLI-7'),
  ];
  const rows = season.stuckRows(claims, NOW);
  assert.deepEqual(rows.map(r => [r.ref, r.member, r.age]), [
    ['CLI-3', 'c', '5d'],
    ['CLI-6', 'f', '4d'],
    ['CLI-5', 'e', '3d'],
    ['CLI-4', 'd', '2d'],
    ['CLI-7', 'g', '9h'],
  ]);
  assert.deepEqual(season.stuckRows([claim('a', HOUR)], NOW), []);
});

test('since you looked counts finished plays after the last look', () => {
  const rows = [
    play('a', 'landed', NOW - 3 * 24 * HOUR),
    play('a', 'took', NOW - 20 * HOUR),
    play('a', 'landed', NOW - 10 * HOUR),
    play('b', 'landed', NOW - 9 * HOUR),
    play('b', 'dropped', NOW - 8 * HOUR),
    play('b', 'abandoned', NOW - 7 * HOUR),
  ];
  assert.equal(season.sinceLastLook(rows, null, NOW), null);
  assert.equal(season.sinceLastLook(rows, NOW - 2 * 24 * HOUR, NOW).line, 'since you looked (2d ago): 2 landed, 1 dropped, 0 sent back, 1 abandoned');
  assert.equal(season.sinceLastLook(rows, NOW - 4 * HOUR, NOW).line, 'nothing happened since you looked 4h ago');
});

test('last seen lives in one home file keyed by workspace, never in the workspace', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gm-seen-'));
  const file = path.join(home, '.atris', 'state', 'gm-last-seen.json');
  try {
    const wsA = path.join(home, 'club-a');
    const wsB = path.join(home, 'club-b');
    assert.equal(season.readLastSeen(wsA, { file }), null);
    assert.equal(season.writeLastSeen(wsA, NOW, { file }), true);
    assert.equal(season.writeLastSeen(wsB, NOW - HOUR, { file }), true);
    assert.equal(season.readLastSeen(wsA, { file }), NOW);
    assert.equal(season.readLastSeen(wsB, { file }), NOW - HOUR);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.workspaces[path.resolve(wsA)].last_seen_at, NOW);
    assert.equal(fs.existsSync(path.join(wsA, '.atris')), false);
    fs.writeFileSync(file, 'not json');
    assert.equal(season.readLastSeen(wsA, { file }), null);
    // An unwritable home means no recap next time, never a crash.
    const blocked = path.join(home, 'a-file');
    fs.writeFileSync(blocked, 'x');
    assert.equal(season.writeLastSeen(wsA, NOW, { file: path.join(blocked, 'state', 'gm-last-seen.json') }), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('roster sorts by ovr with rookies last and shows landed of took', () => {
  const rows = [
    ...[1, 2, 3, 4].map(at => play('sloppy', 'took', at)),
    play('sloppy', 'landed', 5), play('sloppy', 'dropped', 6), play('sloppy', 'dropped', 7),
    ...[1, 2, 3].map(at => play('clean', 'took', at)),
    play('clean', 'landed', 8), play('clean', 'landed', 9), play('clean', 'landed', 10),
    play('new', 'took', 11), play('new', 'landed', 12),
  ];
  const roster = season.rosterRows({
    outcomes: rows,
    claims: [claim('clean', HOUR), claim('waiting', 2 * HOUR)],
    asleep: ['sloppy'],
    now: NOW,
  });
  assert.deepEqual(roster.map(r => r.name), ['clean', 'sloppy', 'new', 'waiting']);
  assert.deepEqual([roster[0].ovr, roster[0].landed, roster[0].took, roster[0].status], [99, 3, 3, 'on a job']);
  assert.deepEqual([roster[1].ovr, roster[1].landed, roster[1].took, roster[1].form, roster[1].status], [73, 1, 4, 'kdd', 'asleep']);
  assert.equal(roster[2].ovr, null);
  assert.equal(roster[2].status, 'idle');
  assert.equal(roster[3].took, 0);
  assert.equal(season.rosterRows({ outcomes: rows, limit: 2 }).length, 2);
});

test('last plays are the newest five of any kind, carry hours when finished, and tag new ones', () => {
  const rows = [1, 2, 3, 4, 5, 6].map(i => play('a', i % 2 ? 'took' : 'landed', NOW - i * HOUR, { claimed_at: NOW - (i + 2) * HOUR }));
  const first = season.lastPlays(rows);
  assert.equal(first.length, 5);
  assert.equal(first[0].at, NOW - HOUR);
  assert.equal(first[0].play, 'took');
  assert.equal(first[0].hours, null);
  assert.equal(first[1].hours, 2);
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

function fixtureBoard({ seen = null, lastSeen = NOW - 2 * 24 * HOUR, claims } = {}) {
  const rows = [
    play('builder', 'took', NOW - 6 * HOUR, { title: 'ship the board', claim_id: 'c1' }),
    play('builder', 'landed', NOW - 3 * HOUR, { claimed_at: NOW - 5 * HOUR, title: 'ship the board', claim_id: 'c1' }),
    play('builder', 'landed', NOW - 2 * HOUR, { claimed_at: NOW - 3 * HOUR, title: 'fix the loader', landed_by: 'you' }),
    play('builder', 'dropped', NOW - HOUR, { claimed_at: NOW - 2 * HOUR, title: 'tidy the help' }),
    play('builder', 'abandoned', NOW - 4 * HOUR, { claimed_at: NOW - 9 * HOUR, title: 'old idea' }),
    play('scout', 'sent_back', NOW - 30 * HOUR, { title: 'look around' }),
  ];
  return season.seasonBoard({
    workspace_name: 'demo',
    now: NOW,
    outcomes: rows,
    claims: claims || [
      { task_id: 'T9', ref: 'CLI-9', title: 'write the release note', member: 'builder', last_event_at: NOW - HOUR },
      { task_id: 'T8', ref: 'CLI-8', title: 'map the old flags', member: 'mapper', last_event_at: NOW - 4 * 24 * HOUR },
    ],
    asleep: ['scout'],
    open_tasks: [{ ref: 'CLI-7', title: 'write the docs', created_at: 1 }],
    missions: [],
    last_seen_at: lastSeen,
  }, { seen });
}

test('board renders one lowercase screen with recap, stuck, last plays, and key', () => {
  const lines = renderBoardLines(fixtureBoard());
  const text = lines.join('\n');
  assert.ok(lines.length <= 40, `board is ${lines.length} rows`);
  assert.equal(lines[0], 'front office | demo | week of oct 19');
  assert.equal(lines[1], 'this week: 1 landed by autoland, 1 by you, 1 sent back, 1 dropped, 1 abandoned, 1 stuck');
  assert.equal(lines[2], 'since you looked (2d ago): 2 landed, 1 dropped, 1 sent back, 1 abandoned');
  assert.match(text, /^ {2}builder +80 +akkd +landed 2 of 4 +on a job$/m);
  assert.match(text, /^ {2}scout +rookie +x +landed 0 of 1 +asleep$/m);
  assert.match(text, /^ {2}mapper +rookie +- +landed 0 of 0 +stuck 4d$/m);
  assert.match(text, /^stuck, claimed with no move for 6h or more$/m);
  assert.match(text, /^ {2}mapper +4d +CLI-8 +map the old flags$/m);
  assert.doesNotMatch(text, /CLI-9 +write the release note/);
  assert.match(text, /^ {2}11:00 am +builder dropped +1h +tidy the help$/m);
  assert.match(text, /^ {2}8:00 am +builder abandoned +5h +old idea$/m);
  assert.doesNotMatch(text, /box scores/);
  assert.match(text, /^ {2}CLI-7 +write the docs$/m);
  assert.match(text, /stricter than the website rating on purpose \(drops and abandons count\)/);
  assert.match(text, /k landed, d dropped, x sent back, a abandoned/);
  assert.match(text, /run atris gm in a terminal to play/);
  assert.doesNotMatch(text, /\bnew$/m);
  assert.doesNotMatch(text, /—/);
  assert.doesNotMatch(text, /\b[A-Z]{3,}\b(?<!CLI)/);

  const interactive = renderBoardLines(fixtureBoard({ seen: new Set() }), { interactive: true });
  assert.ok(interactive.length <= 40, `interactive board is ${interactive.length} rows`);
  const itext = interactive.join('\n');
  assert.match(itext, /refreshes every 10s/);
  assert.match(itext, /\(u to unstick\)/);
  assert.match(itext, /p play {2}r run {2}w wake {2}s sleep {2}u unstick/);
  assert.match(itext, /u unstick {2}l landing check/);
  assert.match(itext, /g league {2}c switch club {2}enter refresh {2}q quit/);
  assert.match(itext, /tidy the help {2}new$/m);
});

test('board drops the stuck block and the recap when there is nothing to show', () => {
  const text = renderBoardLines(fixtureBoard({ lastSeen: null, claims: [] })).join('\n');
  assert.doesNotMatch(text, /^stuck/m);
  assert.doesNotMatch(text, /since you looked/);
  assert.match(text, /0 stuck$/m);
  const quiet = renderBoardLines(fixtureBoard({ lastSeen: NOW - 30 * 60 * 1000, claims: [] })).join('\n');
  assert.match(quiet, /^nothing happened since you looked 30m ago$/m);
});

test('a full stuck block still fits in about 40 rows', () => {
  const claims = Array.from({ length: 8 }, (_, i) => ({ task_id: `T${i}`, ref: `CLI-${i}`, title: `job ${i}`, member: `m${i}`, last_event_at: NOW - (i + 1) * 24 * HOUR }));
  const lines = renderBoardLines(fixtureBoard({ claims, seen: new Set() }), { interactive: true });
  assert.ok(lines.length <= 41, `board is ${lines.length} rows`);
  assert.equal(lines.filter(l => /^ {2}m\d +\d+d +CLI-\d/.test(l)).length, 5);
});

test('play keys map to exact commands and every agent start asks for y', () => {
  assert.deepEqual(playAction('r', { name: 'builder', job: 'fix the help' }), { args: ['member', 'run', 'builder', 'fix the help'], confirm: true });
  assert.deepEqual(playAction('w', { name: 'builder' }), { args: ['member', 'wake', 'builder'], confirm: true });
  assert.deepEqual(playAction('s', { name: 'builder' }), { args: ['member', 'sleep', 'builder'], confirm: false });
  assert.deepEqual(playAction('l'), { args: ['land', '--dry-run'], confirm: false });
  assert.equal(playAction('r', { name: 'bad name; rm -rf' }), null);
  assert.equal(displayCommand(['member', 'run', 'builder', 'fix the help']), 'atris member run builder "fix the help"');
});

test('u releases only a task from the stuck list, as the member holding it, after y', () => {
  const stuck = fixtureBoard().stuck;
  const action = playAction('u', { name: 'cli-8', stuck });
  assert.deepEqual(action.args, ['task', 'release', 'CLI-8', '--as', 'mapper']);
  assert.equal(action.confirm, true);
  assert.match(action.confirmText, /releases the claim/);
  assert.equal(displayCommand(action.args), 'atris task release CLI-8 --as mapper');
  assert.deepEqual(playAction('u', { name: 'T8', stuck }).args, ['task', 'release', 'CLI-8', '--as', 'mapper']);
  assert.equal(playAction('u', { name: 'CLI-9', stuck }), null);
  assert.equal(playAction('u', { name: '', stuck }), null);
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

// A throwaway task db with the real schema columns gm reads.
function makeTaskDb(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const taskDb = require('../lib/task-db');
  const ws = taskDb.workspaceRoot(dir);
  const dbPath = path.join(dir, 'tasks.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', tag TEXT,
      workspace_root TEXT NOT NULL, source_key TEXT, claimed_by TEXT, claimed_at INTEGER, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, done_at INTEGER, metadata TEXT);
    CREATE TABLE task_events (event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
      workspace_root TEXT NOT NULL, actor TEXT, event_type TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
  `);
  const insertTask = db.prepare('INSERT INTO tasks (id, title, status, workspace_root, claimed_by, claimed_at, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertEvent = db.prepare('INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const versions = new Map();
  return {
    ws,
    dbPath,
    task: (id, title, status, claimedBy, claimedAt, createdAt, root = ws) => insertTask.run(id, title, status, root, claimedBy, claimedAt, createdAt, Date.now(), '{}'),
    // versions count up per task, like appendTaskEvent
    event: (id, taskId, actor, type, payload, at, root = ws) => {
      const version = (versions.get(taskId) || 0) + 1;
      versions.set(taskId, version);
      insertEvent.run(id, taskId, version, root, actor, type, JSON.stringify(payload), at);
    },
    close: () => db.close(),
  };
}

// Runs the CLI with its own HOME so ~/.atris/state stays inside the test.
function runCli(dir, dbPath, args, home = path.join(dir, 'home')) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: home, ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

function runBoard(dir, dbPath) {
  return runCli(dir, dbPath, ['gm', '--board', '--workspace', dir]);
}

function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gm-season-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function homeSeenFile(dir) {
  return path.join(dir, 'home', '.atris', 'state', 'gm-last-seen.json');
}

test('gm --board reads a real task db and prints honest records', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  withTempWorkspace((dir) => {
    const t = makeTaskDb(dir);
    const now = Date.now();
    t.task('T1', 'ship the board', 'archived', 'builder', now - 3 * HOUR, now - 4 * HOUR);
    t.task('T2', 'write the docs', 'open', null, null, now - HOUR);
    t.task('T3', 'other workspace job', 'archived', 'builder', now - 3 * HOUR, now - 4 * HOUR, '/elsewhere');
    t.task('T4', 'abandoned job', 'open', null, null, now - 5 * HOUR);
    t.task('T5', 'a claim nobody touched', 'claimed', 'scout', now - 3 * 24 * HOUR, now - 4 * 24 * HOUR);
    t.task('T6', 'archived before landing', 'archived', 'builder', now - 9 * HOUR, now - 10 * HOUR);
    t.task('T7', 'archived after landing', 'archived', 'builder', now - 9 * HOUR, now - 10 * HOUR);
    t.task('T8', 'still in review', 'review', 'builder', now - 2 * HOUR, now - 3 * HOUR);
    t.event('E1', 'T1', 'builder', 'claimed', { claimed_by: 'builder' }, now - 3 * HOUR);
    t.event('E2', 'T1', 'autoland', 'completed', { action: 'merged', auto_accepted: true }, now - HOUR);
    t.event('E3', 'T3', 'autoland', 'completed', { action: 'merged' }, now - HOUR, '/elsewhere');
    t.event('E4', 'T4', 'builder', 'claimed', { claimed_by: 'builder' }, now - 5 * HOUR);
    t.event('E5', 'T4', 'builder', 'claim_released', { released_by: 'builder', previous_claimed_by: 'builder' }, now - 4 * HOUR);
    t.event('E6', 'T5', 'scout', 'claimed', { claimed_by: 'scout' }, now - 3 * 24 * HOUR);
    t.event('E7', 'T6', 'builder', 'claimed', { claimed_by: 'builder' }, now - 9 * HOUR);
    t.event('E8', 'T6', 'builder', 'proof_ready', {}, now - 8 * HOUR);
    t.event('E9', 'T6', 'keshavrao', 'archived', { reason: 'sat untouched' }, now - 6 * HOUR);
    t.event('E10', 'T7', 'builder', 'claimed', { claimed_by: 'builder' }, now - 9 * HOUR);
    t.event('E11', 'T7', 'autoland', 'completed', { action: 'merged' }, now - 8 * HOUR);
    t.event('E12', 'T7', 'keshavrao', 'archived', {}, now - 7 * HOUR);
    t.event('E13', 'T8', 'builder', 'claimed', { claimed_by: 'builder' }, now - 2 * HOUR);
    t.event('E14', 'T8', 'builder', 'proof_ready', {}, now - 90 * 60 * 1000);
    // done with no accept, then tidied away: neither landed nor abandoned
    t.task('T9', 'done without an accept', 'archived', 'builder', now - 9 * HOUR, now - 10 * HOUR);
    t.event('E15', 'T9', 'builder', 'claimed', { claimed_by: 'builder' }, now - 9 * HOUR);
    t.event('E16', 'T9', 'builder', 'completed', { status: 'done' }, now - 8 * HOUR);
    t.event('E17', 'T9', 'keshavrao', 'archived', { reason: 'finished work left the list' }, now - 7 * HOUR);
    t.close();
    const seenAt = now - 2 * 24 * HOUR;
    const seenFile = homeSeenFile(dir);
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify({ workspaces: { [t.ws]: { last_seen_at: seenAt } } }));

    const res = runBoard(dir, t.dbPath);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^front office \| /m);
    assert.match(res.stdout, /, 1 abandoned, 1 stuck$/m);
    assert.match(res.stdout, /^since you looked \(2d ago\): 2 landed, 1 dropped, 0 sent back, 1 abandoned$/m);
    // T1 and T7 landed, T4 dropped, T6 abandoned, T8 is in review and pending
    assert.match(res.stdout, /^ {2}builder +80 +kadk +landed 2 of 4 +idle$/m);
    assert.match(res.stdout, /^ {2}scout +rookie +- +landed 0 of 0 +stuck 3d$/m);
    assert.match(res.stdout, /^ {2}scout +3d +[A-Z0-9]+-\d+ +a claim nobody touched$/m);
    assert.match(res.stdout, /builder landed +2h +ship the board$/m);
    assert.match(res.stdout, /builder dropped +1h +abandoned job$/m);
    assert.doesNotMatch(res.stdout, /other workspace job/);
    assert.doesNotMatch(res.stdout, /AgentXP General Manager/);
    // --board reads the last look but never moves it, and never writes into the workspace.
    assert.equal(JSON.parse(fs.readFileSync(seenFile, 'utf8')).workspaces[t.ws].last_seen_at, seenAt);
    assert.equal(fs.existsSync(path.join(t.ws, '.atris', 'state', 'gm-last-seen.json')), false);
  });
});

test('the recap reaches back past the 30 day window to the last look', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  withTempWorkspace((dir) => {
    const t = makeTaskDb(dir);
    const now = Date.now();
    t.task('OLD', 'landed 35 days ago', 'archived', 'builder', now - 36 * 24 * HOUR, now - 37 * 24 * HOUR);
    t.task('NEW', 'landed today', 'archived', 'builder', now - 3 * HOUR, now - 4 * HOUR);
    t.event('E1', 'OLD', 'builder', 'claimed', { claimed_by: 'builder' }, now - 36 * 24 * HOUR);
    t.event('E2', 'OLD', 'autoland', 'completed', { action: 'merged' }, now - 35 * 24 * HOUR);
    t.event('E3', 'NEW', 'builder', 'claimed', { claimed_by: 'builder' }, now - 3 * HOUR);
    t.event('E4', 'NEW', 'autoland', 'completed', { action: 'merged' }, now - HOUR);
    t.close();
    const board = season.seasonBoard(season.loadSeason(t.ws, { dbPath: t.dbPath, lastSeen: now - 40 * 24 * HOUR, now }));
    assert.equal(board.since_last_look.line, 'since you looked (40d ago): 2 landed, 0 dropped, 0 sent back, 0 abandoned');
    // the roster still rates only the 30 day window
    assert.equal(board.roster[0].landed, 1);
  });
});

test('gm --board --json is read only: no starter task, no db writes', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  withTempWorkspace((dir) => {
    // one team member and no tasks is exactly what makes plain gm seed a task
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'justin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'START_HERE.md'), '# Justin\n');
    const t = makeTaskDb(dir);
    t.close();
    const before = fs.statSync(t.dbPath).mtimeMs;
    for (const args of [['gm', '--board', '--json'], ['gm', '--board', '--json', '--league']]) {
      const res = runCli(dir, t.dbPath, args);
      assert.equal(res.status, 0, res.stderr);
      const body = JSON.parse(res.stdout);
      assert.equal(body.schema, 'atris.gm_board.v1');
      assert.ok(body.season && Array.isArray(body.season.roster));
      assert.equal('league' in body, args.includes('--league'));
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(t.dbPath, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
    db.close();
    assert.equal(fs.statSync(t.dbPath).mtimeMs, before);
  });
});

test('u only releases when the claim is still stuck at the moment of release', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  withTempWorkspace((dir) => {
    const t = makeTaskDb(dir);
    const now = Date.now();
    t.task('STALE', 'sat for days', 'claimed', 'scout', now - 3 * 24 * HOUR, now - 4 * 24 * HOUR);
    t.event('E1', 'STALE', 'scout', 'claimed', { claimed_by: 'scout' }, now - 3 * 24 * HOUR);
    t.task('RESUMED', 'holder came back', 'claimed', 'scout', now - 3 * 24 * HOUR, now - 4 * 24 * HOUR);
    t.event('E2', 'RESUMED', 'scout', 'claimed', { claimed_by: 'scout' }, now - 3 * 24 * HOUR);
    t.event('E3', 'RESUMED', 'scout', 'message', { note: 'back on it' }, now - 60 * 1000);
    t.task('HANDED', 'someone else took it', 'claimed', 'builder', now - 3 * 24 * HOUR, now - 4 * 24 * HOUR);
    t.event('E4', 'HANDED', 'builder', 'claimed', { claimed_by: 'builder' }, now - 3 * 24 * HOUR);
    t.task('LET-GO', 'already released', 'open', null, null, now - 4 * 24 * HOUR);
    t.event('E5', 'LET-GO', 'scout', 'claimed', { claimed_by: 'scout' }, now - 3 * 24 * HOUR);
    t.close();
    const opts = { dbPath: t.dbPath, now };
    assert.equal(season.stillStuck('STALE', 'scout', opts), true);
    assert.equal(season.stillStuck('RESUMED', 'scout', opts), false);
    assert.equal(season.stillStuck('HANDED', 'scout', opts), false);
    assert.equal(season.stillStuck('LET-GO', 'scout', opts), false);
    assert.equal(season.stillStuck('MISSING', 'scout', opts), false);
    // the action u builds carries what to recheck
    const action = playAction('u', { name: 'CLI-1', stuck: [{ task_id: 'STALE', ref: 'CLI-1', member: 'scout' }] });
    assert.deepEqual(action.recheck, { task_id: 'STALE', member: 'scout' });
  });
});

test('two claims in the same millisecond credit the later claim by version', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  withTempWorkspace((dir) => {
    const t = makeTaskDb(dir);
    const at = Date.now() - 5 * HOUR;
    t.task('T1', 'same moment job', 'archived', 'beta', at, at - HOUR);
    // alpha claims and lets go, beta claims, all in one millisecond; ids sort
    // so a timestamp-only lookup would pick alpha.
    t.event('Z-alpha-claim', 'T1', 'alpha', 'claimed', { claimed_by: 'alpha' }, at);
    t.event('Z-alpha-release', 'T1', 'alpha', 'claim_released', { released_by: 'alpha', previous_claimed_by: 'alpha' }, at);
    t.event('A-beta-claim', 'T1', 'beta', 'claimed', { claimed_by: 'beta' }, at);
    t.event('E-land', 'T1', 'autoland', 'completed', { action: 'merged', auto_accepted: true }, at + 2 * HOUR);
    t.close();
    const loaded = season.loadSeason(t.ws, { dbPath: t.dbPath });
    const landed = loaded.outcomes.find(o => o.kind === 'landed');
    assert.equal(landed.member, 'beta');
    assert.equal(landed.claim_id, 'A-beta-claim');
    assert.equal(landed.claimed_at, at);
    const dropped = loaded.outcomes.find(o => o.kind === 'dropped');
    assert.equal(dropped.claim_id, 'Z-alpha-claim');
  });
});

// ---- league ---------------------------------------------------------------

test('club roots leave out temp scratch runs and agent worktrees', () => {
  assert.equal(season.isClubRoot('/Users/k/arena/project-obelisk'), true);
  assert.equal(season.isClubRoot('/Users/k/arena/math-lab/families/007-records'), true);
  assert.equal(season.isClubRoot('/private/tmp/pr-runs/r1'), false);
  assert.equal(season.isClubRoot('/private/tmp/push-race/fleet'), false);
  assert.equal(season.isClubRoot('/private/tmp/atris-approve-MMPK'), false);
  assert.equal(season.isClubRoot('/tmp'), false);
  assert.equal(season.isClubRoot(path.join(os.tmpdir(), 'atris-review-lane-test-abc')), false);
  assert.equal(season.isClubRoot('/Users/k/arena/.agent-worktrees/atris-cli/architect-job-20261014'), false);
  assert.equal(season.isClubRoot('/Users/k/arena/atrisos-backend/.agent-worktrees/prod-ready'), false);
  assert.equal(season.isClubRoot('/Users/k/arena/atris-cli/.claude/worktrees/agent-a1'), false);
  assert.equal(season.isClubRoot(''), false);
  assert.equal(season.isClubRoot('relative/path'), false);
});

function club(root, outcomes = [], { claims = [], lastEventAt = 0 } = {}) {
  return { root, outcomes, claims, last_event_at: lastEventAt };
}

test('league rows rate each club over all its jobs and name the best non-rookie', () => {
  const outcomes = [
    play('ace', 'landed', NOW - 3 * HOUR), play('ace', 'landed', NOW - 4 * HOUR), play('ace', 'landed', NOW - 5 * HOUR),
    play('mid', 'landed', NOW - 40 * HOUR), play('mid', 'dropped', NOW - 41 * HOUR), play('mid', 'dropped', NOW - 6 * 24 * HOUR),
    play('kid', 'landed', NOW - 2 * HOUR),
  ];
  const [row] = season.leagueRows([club('/w/alpha', outcomes, {
    claims: [claim('mid', 2 * 24 * HOUR), claim('ace', HOUR)],
    lastEventAt: NOW - 20 * 60 * 1000,
  })], NOW);
  assert.equal(row.club, 'alpha');
  assert.equal(row.ovr, Math.round(60 + 39 * 5 / 7));
  assert.equal(row.landed_week, 5);
  assert.equal(row.landed_30d, 5);
  assert.equal(row.dropped_30d, 2);
  assert.equal(row.stuck, 1);
  assert.equal(row.last_play, '20m');
  assert.deepEqual(row.best_player, { name: 'ace', ovr: 99 });
});

test('league sorts by landed this week, then ovr with rookies last, then recent activity', () => {
  const landedNow = n => Array.from({ length: n }, (_, i) => play(`m${i}`, 'landed', NOW - (i + 1) * HOUR));
  const strong = [...[1, 2, 3].map(i => play('a', 'landed', MONDAY - i * 24 * HOUR))];
  const weak = [play('b', 'landed', MONDAY - 2 * HOUR), play('b', 'dropped', MONDAY - 3 * HOUR), play('b', 'dropped', MONDAY - 4 * HOUR)];
  const rows = season.leagueRows([
    club('/w/rookie-old', [], { lastEventAt: NOW - 9 * 24 * HOUR }),
    club('/w/weak', weak),
    club('/w/busy', landedNow(2)),
    club('/w/strong', strong),
    club('/w/rookie-new', [], { lastEventAt: NOW - HOUR }),
  ], NOW);
  assert.deepEqual(rows.map(r => r.club), ['busy', 'strong', 'weak', 'rookie-new', 'rookie-old']);
  assert.equal(rows[0].landed_week, 2);
  assert.equal(rows[3].ovr, null);
  assert.equal(rows[3].best_player, null);
});

test('league last play shows the newest task event in minutes, hours, or days', () => {
  const rows = season.leagueRows([
    club('/w/a', [play('x', 'took', NOW - 3 * 24 * HOUR)], { lastEventAt: NOW - 4 * 60 * 1000 }),
    club('/w/b', [play('x', 'took', NOW - 7 * HOUR)], { lastEventAt: NOW - 4 * 24 * HOUR }),
    club('/w/c', [], { lastEventAt: NOW - 4 * 24 * HOUR }),
    club('/w/d', [], {}),
  ], NOW);
  const byClub = Object.fromEntries(rows.map(r => [r.club, r.last_play]));
  assert.deepEqual(byClub, { a: '4m', b: '7h', c: '4d', d: '-' });
});

test('clubs with the same folder name get their parent folder in front', () => {
  const rows = season.leagueRows([club('/w/one/referee'), club('/w/two/referee'), club('/w/solo')], NOW);
  assert.deepEqual(rows.map(r => r.club).sort(), ['one/referee', 'solo', 'two/referee']);
});

test('league renders a header, one row per club, a cap, and the key', () => {
  const rows = season.leagueRows([
    club('/w/project-obelisk', [play('integrator', 'landed', NOW - HOUR), play('integrator', 'landed', NOW - 2 * HOUR), play('integrator', 'landed', NOW - 3 * HOUR)], { lastEventAt: NOW - 4 * 60 * 1000 }),
    ...Array.from({ length: 24 }, (_, i) => club(`/w/quiet-${i}`, [], { lastEventAt: NOW - (i + 1) * 24 * HOUR })),
  ], NOW);
  const lines = renderLeagueLines({ now: NOW, days: 30, rows, error: null });
  const text = lines.join('\n');
  assert.equal(lines[0], 'league | 30 days | 25 clubs');
  assert.match(text, /^ {2}club +ovr +week +30d +drop +aband +stuck +last +best player$/m);
  assert.match(text, /^ {2}project-obelisk +99 +3 +3 +0 +0 +0 +4m +integrator 99$/m);
  assert.match(text, /^ {2}quiet-0 +rookie +0 +0 +0 +0 +0 +1d +-$/m);
  assert.match(text, /and 5 more clubs/);
  assert.ok(lines.length <= 40, `league is ${lines.length} rows`);
  assert.doesNotMatch(text, /—/);
  assert.match(renderLeagueLines({ now: NOW, days: 30, rows, error: null }, { interactive: true }).join('\n'), /g back to the club {2}c switch club/);
});

test('c picks a club by league name or folder name', () => {
  const rows = [{ club: 'one/referee', root: '/w/one/referee' }, { club: 'atris-cli', root: '/w/atris-cli' }];
  assert.equal(pickClub('Atris-CLI', rows), '/w/atris-cli');
  assert.equal(pickClub('one/referee', rows), '/w/one/referee');
  assert.equal(pickClub('referee', rows), '/w/one/referee');
  assert.equal(pickClub('nope', rows), null);
  assert.equal(pickClub('', rows), null);
});

test('league loader groups plays by workspace and skips folders that are not clubs', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  withTempWorkspace((dir) => {
    const t = makeTaskDb(dir);
    const alpha = path.join(dir, 'alpha');
    const beta = path.join(dir, 'beta');
    const scratch = path.join(dir, 'scratch');
    for (const folder of [alpha, beta, scratch]) fs.mkdirSync(folder, { recursive: true });
    const now = Date.now();
    t.task('A1', 'alpha job', 'archived', 'ace', now - 3 * HOUR, now - 4 * HOUR, alpha);
    t.task('B1', 'beta job', 'claimed', 'bee', now - 3 * 24 * HOUR, now - 4 * 24 * HOUR, beta);
    t.task('S1', 'scratch job', 'archived', 'ace', now - 3 * HOUR, now - 4 * HOUR, scratch);
    t.event('E1', 'A1', 'ace', 'claimed', { claimed_by: 'ace' }, now - 3 * HOUR, alpha);
    t.event('E2', 'A1', 'autoland', 'completed', { action: 'merged', auto_accepted: true }, now - HOUR, alpha);
    t.event('E3', 'B1', 'bee', 'claimed', { claimed_by: 'bee' }, now - 3 * 24 * HOUR, beta);
    t.event('E4', 'S1', 'autoland', 'completed', { action: 'merged' }, now - HOUR, scratch);
    t.event('E5', 'A1', 'ace', 'gone', {}, now - 40 * 24 * HOUR, path.join(dir, 'old'));
    t.close();
    const league = season.loadLeague({ dbPath: t.dbPath, now, isClub: root => root !== scratch });
    const all = season.leagueRows(league.clubs, now);
    assert.deepEqual(all.map(r => r.club), ['alpha', 'beta']);
    assert.equal(all[0].landed_30d, 1);
    assert.equal(all[0].last_play, '1h');
    assert.equal(all[1].stuck, 1);
    assert.equal(all[1].last_play, '3d');
    // both clubs finished fewer than 3 jobs, so the table hides them
    const board = season.leagueBoard(league);
    assert.deepEqual(board.rows, []);
    assert.equal(board.hidden, 2);
    assert.deepEqual(board.hidden_clubs.map(c => c.club), ['alpha', 'beta']);
  });
});

test('league hides clubs under 3 finished jobs and says how many', () => {
  const busy = [
    play('a', 'landed', NOW - HOUR), play('a', 'abandoned', NOW - 2 * HOUR), play('a', 'dropped', NOW - 3 * HOUR),
  ];
  const board = season.leagueBoard({
    now: NOW,
    clubs: [club('/w/busy', busy), club('/w/two', busy.slice(0, 2)), club('/w/none', [], { lastEventAt: NOW - HOUR })],
  });
  assert.deepEqual(board.rows.map(r => r.club), ['busy']);
  assert.equal(board.rows[0].abandoned_30d, 1);
  assert.equal(board.hidden, 2);
  const text = renderLeagueLines(board).join('\n');
  assert.match(text, /^league \| 30 days \| 1 clubs$/m);
  assert.match(text, /^ {2}2 quiet clubs hidden \(under 3 finished jobs in 30 days\)$/m);
  assert.match(text, /^ {2}busy +73 +1 +1 +1 +1 +0 /m);
});

test('gm --league --board prints the league once and exits 0', () => {
  if (!hasNodeSqlite({ NODE_NO_WARNINGS: '1' })) return;
  withTempWorkspace((dir) => {
    const t = makeTaskDb(dir);
    t.close();
    const res = runCli(dir, t.dbPath, ['gm', '--league', '--board']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^league \| 30 days \| 0 clubs$/m);
    assert.match(res.stdout, /no club finished 3 or more jobs/);
  });
});
