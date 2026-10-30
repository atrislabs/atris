'use strict';

// The orb's team page, the board's roster, and the standup are one table.
// Each one loads the season its own way, then reads the same ratings
// (gm-season memberRatings, a Map) and the same role, ovr, and engine
// cells, so one member never shows two ratings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gmBet = require('../lib/gm-bet');
const trace = require('../scripts/gm-phone-trace');
const taskDb = require('../lib/task-db');
const { boardCells, loadSeasonBoard, renderBoardLines } = require('../commands/gm');
const { memberStandupLines, standupTableData } = require('../commands/member');

const CHROME = trace.findChrome();
const HOUR = 60 * 60 * 1000;
const SCRIBE_ROLE = 'Ships & <b>bold</b> "fast" work';
// the role cell keeps every character: only the first word is lowercased
const SCRIBE_CELL = 'ships & <b>bold</b> "fast" work';
const ROSTER = '# roster\n\n## search\n- claude code, model: haiku 5.5\n\n## build\n- claude code, model: opus 5.5\n\n## review\n- codex, model: gpt-6.1-sol\n\n## team\n- launcher: codex, model: gpt-6.1-sol\n';

function card(root, name, head) {
  fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\n${head}\n---\n\n# ${name}\n`);
}

// A team, a roster, a registry where claude and codex are ready, and a
// task list with real claim and landing events.
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-tables-'));
  card(dir, 'builder', 'role: Builder\ndescription: Writes and tests the code');
  card(dir, 'validator', 'role: Reviewer');
  card(dir, 'launcher', 'role: Launcher\ndescription: Writes posts, pages, and launch copy');
  card(dir, 'researcher', 'role: Deep Researcher');
  card(dir, 'designer', 'type: human\nrole: Designer\ndescription: Draws the screens by hand');
  // a role with markup characters: plain words everywhere, never markup
  card(dir, 'scribe', `role: ${SCRIBE_ROLE}`);
  fs.writeFileSync(path.join(dir, 'atris', 'ROSTER.md'), ROSTER);
  const ids = Object.keys(require('../lib/runner-command').RUNNER_PROFILE_DEFS);
  const checked = new Date().toISOString();
  const engines = ids.map(id => (['claude', 'codex'].includes(id) ? { id, health: { status: 'ready' } } : { id, installed: false, health: { status: 'not_installed', checked_at: checked } }));
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'engines.json'), `${JSON.stringify({ engines })}\n`);

  const ws = taskDb.workspaceRoot(dir);
  const dbPath = path.join(dir, 'tasks.db');
  const { DatabaseSync } = require('node:sqlite');
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
  const addEvent = db.prepare('INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  // one job: claimed, then how it ended (or still open)
  const job = (member, end) => {
    n += 1;
    const id = `T${n}`;
    const at = now - (40 - n) * HOUR;
    addTask.run(id, `job ${n}`, end ? 'done' : 'claimed', ws, member, at, at, at, '{}');
    addEvent.run(`${id}-c`, id, 1, ws, member, 'claimed', '{}', at);
    if (end === 'landed') addEvent.run(`${id}-e`, id, 2, ws, 'reviewer', 'completed', JSON.stringify({ action: 'accepted' }), at + HOUR);
    if (end === 'dropped') addEvent.run(`${id}-e`, id, 2, ws, member, 'claim_released', JSON.stringify({ previous_claimed_by: member }), at + HOUR);
    if (end === 'sent_back') addEvent.run(`${id}-e`, id, 2, ws, 'reviewer', 'revision_requested', '{}', at + HOUR);
  };
  // builder: 4 landed, 1 dropped rates 69 on the Atris Rating. validator:
  // 3 landed, 1 sent back rates 67. launcher has 2 finished, so it is new.
  // researcher only claimed a job, and designer has no plays at all.
  for (const end of ['landed', 'landed', 'landed', 'landed', 'dropped']) job('builder', end);
  for (const end of ['landed', 'landed', 'landed', 'sent_back']) job('validator', end);
  for (const end of ['landed', 'landed']) job('launcher', end);
  job('researcher', null);
  job('scribe', 'landed');
  db.close();
  return { dir, ws, dbPath };
}

// The member and its role, ovr, and engine from every row of a divided box.
function boxCells(lines) {
  const out = {};
  for (const line of lines) {
    const parts = line.split('│').map(part => part.trim());
    if (parts.length < 7 || !parts[1] || parts[1] === 'member') continue;
    out[parts[1]] = [parts[2], parts[3], parts[4]];
  }
  return out;
}

test('the orb team table, the board roster, and the standup read the same ratings for the same members', () => {
  const { dir, ws, dbPath } = workspace();
  const saved = { db: process.env.ATRIS_TASKS_DB, tty: process.stdout.isTTY };
  process.env.ATRIS_TASKS_DB = dbPath;
  process.stdout.isTTY = true;
  try {
    // the orb: the desk's own season loader and team table
    const desk = gmBet.createBetDesk({
      workspaceRoot: ws,
      ledgerFile: path.join(dir, 'gm-bets.jsonl'),
      now: () => Date.now(),
      generate: () => new Promise(() => {}),
      readMissions: () => new Map(),
      readHandoffs: () => [],
      driverAlive: () => false,
      warmOnCreate: false,
    });
    const orb = Object.fromEntries(desk.teamTable().rows.map(r => [r.member, [r.role, r.ovr, r.engine]]));
    assert.deepEqual(Object.fromEntries(Object.entries(orb).map(([name, cells]) => [name, cells[1]])), {
      builder: '69', designer: '··', launcher: 'new', researcher: '··', scribe: 'new', validator: '67',
    });
    assert.equal(orb.scribe[0], SCRIBE_CELL);

    // the board: the CLI's loader gives the one memberRatings Map
    const { board, ratings } = loadSeasonBoard(ws);
    assert.ok(ratings instanceof Map, 'the board reads the same Map the orb reads');
    assert.deepEqual(ratings.get('builder'), { ovr: 69, finished: 5 });
    const boardLines = renderBoardLines(board, { bordered: true, width: 160, cells: boardCells(board, ws, ratings) });
    const onBoard = boxCells(boardLines);
    assert.deepEqual(Object.keys(onBoard).sort(), ['builder', 'launcher', 'researcher', 'scribe', 'validator']);
    for (const [name, cells] of Object.entries(onBoard)) assert.deepEqual(cells, orb[name], `${name} on the board`);

    // the standup: the same cells for every member it lists
    const standup = ['builder', 'designer', 'launcher', 'researcher', 'scribe', 'validator'].map(member => ({
      member, role: 'Team Member', status: 'idle', engine: 'auto', latest_update: 'x', next_push: 'y',
    }));
    const standupLines = memberStandupLines(standup, { ...standupTableData(standup, ws), width: 160 });
    const onStandup = boxCells(standupLines);
    assert.deepEqual(Object.keys(onStandup).sort(), Object.keys(orb).sort());
    for (const [name, cells] of Object.entries(onStandup)) assert.deepEqual(cells, orb[name], `${name} on the standup`);

    // a terminal prints the role as plain words: no entity ever reaches it
    for (const [where, lines] of [['board', boardLines], ['standup', standupLines]]) {
      assert.ok(lines.some(line => line.includes(`│ ${SCRIBE_CELL} `)), `${where} prints the role plainly`);
      assert.ok(lines.every(line => !/&(?:amp|lt|gt|quot|#\d+);/.test(line)), `${where} has no html entity`);
    }
  } finally {
    if (saved.db === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = saved.db;
    process.stdout.isTTY = saved.tty;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser: the orb team page shows a role with markup characters as words, never as markup', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const { dir, ws } = workspace();
  try {
    const desk = gmBet.createBetDesk({
      workspaceRoot: ws,
      ledgerFile: path.join(dir, 'gm-bets.jsonl'),
      now: () => Date.now(),
      generate: () => new Promise(() => {}),
      readMissions: () => new Map(),
      readHandoffs: () => [],
      loadSeason: () => ({ outcomes: [], error: null }),
      driverAlive: () => false,
      warmOnCreate: false,
    });
    const rows = desk.teamTable().rows;
    const scribe = rows.find(r => r.member === 'scribe');
    assert.equal(scribe.role, SCRIBE_CELL, 'the desk hands the page plain words');
    // the trace taps the second row and waits for builder's talk card
    const ordered = [scribe, rows.find(r => r.member === 'builder'), ...rows.filter(r => r.member !== 'scribe' && r.member !== 'builder')];
    const out = await trace.teamTableTrace({ chromePath: CHROME, viewport: trace.LAPTOP, rows: ordered });
    const role = out.cells[0][1];
    // the page shows exactly the words, and its markup holds them escaped
    assert.equal(role.text, SCRIBE_CELL);
    assert.equal(role.html, 'ships &amp; &lt;b&gt;bold&lt;/b&gt; "fast" work');
    for (const row of out.cells) for (const cell of row) assert.equal(cell.elements, 0, `no markup inside a cell: ${cell.html}`);
    assert.equal(out.talk.title, 'builder', 'the table still works after it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
