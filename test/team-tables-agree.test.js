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
const taskDb = require('../lib/task-db');
const { boardCells, loadSeasonBoard, renderBoardLines } = require('../commands/gm');
const { memberStandupLines, standupTableData } = require('../commands/member');

const HOUR = 60 * 60 * 1000;
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
  // builder: 4 landed, 1 dropped is round(60 + 39 * 4 / 5) = 91. validator:
  // 3 landed, 1 sent back is 89. launcher has 2 finished, so it is new.
  // researcher only claimed a job, and designer has no plays at all.
  for (const end of ['landed', 'landed', 'landed', 'landed', 'dropped']) job('builder', end);
  for (const end of ['landed', 'landed', 'landed', 'sent_back']) job('validator', end);
  for (const end of ['landed', 'landed']) job('launcher', end);
  job('researcher', null);
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
      builder: '91', designer: '··', launcher: 'new', researcher: '··', validator: '89',
    });

    // the board: the CLI's loader gives the one memberRatings Map
    const { board, ratings } = loadSeasonBoard(ws);
    assert.ok(ratings instanceof Map, 'the board reads the same Map the orb reads');
    assert.deepEqual(ratings.get('builder'), { ovr: 91, finished: 5 });
    const boardLines = renderBoardLines(board, { bordered: true, width: 160, cells: boardCells(board, ws, ratings) });
    const onBoard = boxCells(boardLines);
    assert.deepEqual(Object.keys(onBoard).sort(), ['builder', 'launcher', 'researcher', 'validator']);
    for (const [name, cells] of Object.entries(onBoard)) assert.deepEqual(cells, orb[name], `${name} on the board`);

    // the standup: the same cells for every member it lists
    const standup = ['builder', 'designer', 'launcher', 'researcher', 'validator'].map(member => ({
      member, role: 'Team Member', status: 'idle', engine: 'auto', latest_update: 'x', next_push: 'y',
    }));
    const standupLines = memberStandupLines(standup, { ...standupTableData(standup, ws), width: 160 });
    const onStandup = boxCells(standupLines);
    assert.deepEqual(Object.keys(onStandup).sort(), Object.keys(orb).sort());
    for (const [name, cells] of Object.entries(onStandup)) assert.deepEqual(cells, orb[name], `${name} on the standup`);
  } finally {
    if (saved.db === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = saved.db;
    process.stdout.isTTY = saved.tty;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
