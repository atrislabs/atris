// `atris task` — SQLite-backed task plane. TODO.md stays the human-readable
// board; this gives agents atomic claims and a compact sync row.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_OWNER = process.env.ATRIS_AGENT_ID
  || process.env.USER
  || os.userInfo().username
  || 'unknown';

let taskDbModule = null;

function getTaskDb() {
  if (taskDbModule) return taskDbModule;
  try {
    taskDbModule = require('../lib/task-db');
    return taskDbModule;
  } catch (e) {
    const message = String(e && (e.message || e));
    const missingSqlite = e && (
      e.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
      || /node:sqlite|No such built-in module/i.test(message)
    );
    if (missingSqlite) {
      console.error('atris task requires Node.js 22+ because it uses built-in node:sqlite.');
      console.error('Use the markdown TODO.md flow on older Node versions.');
      process.exit(1);
    }
    throw e;
  }
}

function help() {
  console.log(`
atris task — local agent task plane (SQLite, gitignored)

  atris task add "<title>" [--tag <tag>]   Create a task
  atris task list [--all] [--status <s>]   List tasks (default: this workspace)
  atris task claim <id> [--as <owner>]     Atomic claim
  atris task done <id> [--failed]          Mark complete (or failed)
  atris task import <file>                 One-shot import from TODO.md
  atris task where                          Print db path + workspace scope
  atris task help                           This help

Env:
  ATRIS_TASKS_DB    Override db path (default ~/.atris/tasks.db)
  ATRIS_AGENT_ID    Owner id for claim/done (default: $USER)
`.trim());
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] || true;
}

function hasFlag(args, name) {
  return args.indexOf(name) !== -1;
}

function positional(args) {
  return args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && args[i - 1].startsWith('--')) return false;
    return true;
  });
}

function cmdAdd(args) {
  const pos = positional(args);
  const title = pos.join(' ').trim();
  if (!title) {
    console.error('atris task add: title required');
    process.exit(2);
  }
  const tag = flag(args, '--tag');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  const result = taskDb.addTask(db, {
    title,
    tag: typeof tag === 'string' ? tag : null,
    workspaceRoot: ws,
  });
  console.log(`${result.id}\t${title}`);
}

function cmdList(args) {
  const all = hasFlag(args, '--all');
  const status = flag(args, '--status');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const rows = taskDb.listTasks(db, {
    workspaceRoot: all ? null : taskDb.workspaceRoot(),
    status: typeof status === 'string' ? status : null,
    limit: 200,
  });
  if (rows.length === 0) {
    console.log('(no tasks)');
    return;
  }
  for (const r of rows) {
    const claim = r.claimed_by ? ` [${r.claimed_by}]` : '';
    const tag = r.tag ? ` #${r.tag}` : '';
    console.log(`${r.status.padEnd(8)} ${r.id}${claim}${tag}\t${r.title}`);
  }
}

function cmdClaim(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task claim: id required');
    process.exit(2);
  }
  const owner = flag(args, '--as') || DEFAULT_OWNER;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskDb.claimTask(db, { id, claimedBy: String(owner) });
  if (result.claimed) {
    console.log(`claimed ${id} as ${owner}`);
  } else {
    console.error(`claim failed: ${result.reason}${result.claimed_by ? ` (held by ${result.claimed_by})` : ''}`);
    process.exit(1);
  }
}

function cmdDone(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task done: id required');
    process.exit(2);
  }
  const failed = hasFlag(args, '--failed');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const result = taskDb.doneTask(db, { id, status: failed ? 'failed' : 'done' });
  if (result.updated) {
    console.log(`${failed ? 'failed' : 'done'} ${id}`);
  } else {
    console.error(`done failed: ${id} not in open|claimed`);
    process.exit(1);
  }
}

function cmdImport(args) {
  const pos = positional(args);
  const target = pos[0] || 'atris/TODO.md';
  const filePath = path.resolve(target);
  if (!fs.existsSync(filePath)) {
    console.error(`atris task import: file not found: ${filePath}`);
    process.exit(2);
  }
  const { parseTodoFile } = require('../lib/todo-fallback');
  const parsed = parseTodoFile(filePath);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ws = taskDb.workspaceRoot();
  const all = [
    ...parsed.backlog.map(t => ({ ...t, importStatus: 'open' })),
    ...parsed.inProgress.map(t => ({ ...t, importStatus: 'claimed' })),
  ];
  let inserted = 0;
  let skipped = 0;
  for (const t of all) {
    if (!t.title) continue;
    const sk = taskDb.sourceKey(filePath, t.title);
    const result = taskDb.addTask(db, {
      title: t.title,
      tag: t.tag || null,
      workspaceRoot: ws,
      sourceKey: sk,
      status: t.importStatus,
      claimedBy: t.claimed || null,
      metadata: { todo_id: t.id, claimed: t.claimed, stage: t.stage, verify: t.verify },
    });
    if (result.inserted) inserted++; else skipped++;
  }
  console.log(`imported ${inserted} new, skipped ${skipped} (already imported), source=${filePath}`);
}

function cmdWhere() {
  const taskDb = getTaskDb();
  console.log(`db:        ${taskDb.getDbPath()}`);
  console.log(`workspace: ${taskDb.workspaceRoot()}`);
  console.log(`owner:     ${DEFAULT_OWNER}`);
}

async function run(args) {
  const sub = (args && args[0]) || 'help';
  const rest = (args || []).slice(1);
  switch (sub) {
    case 'add':    return cmdAdd(rest);
    case 'list':   return cmdList(rest);
    case 'ls':     return cmdList(rest);
    case 'claim':  return cmdClaim(rest);
    case 'done':   return cmdDone(rest);
    case 'fail':   return cmdDone([...rest, '--failed']);
    case 'import': return cmdImport(rest);
    case 'where':  return cmdWhere();
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      console.error(`atris task: unknown subcommand "${sub}"`);
      help();
      process.exit(2);
  }
}

module.exports = { run };
