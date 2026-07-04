const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA = 'atris.codex_goal.v1';
const CONFIRM_RESET_FLAG = '--confirm-complete-goal-reset';

function hasFlag(args, name) {
  return args.includes(name);
}

function readFlag(args, name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

function expandHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function safeStamp(value = new Date().toISOString()) {
  return value.replace(/[:.]/g, '-');
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveStatePath(args = []) {
  const explicit = readFlag(args, '--state', process.env.CODEX_STATE_DB || '');
  if (explicit) return path.resolve(expandHome(explicit));
  // Codex moved native goals into ~/.codex/goals_1.sqlite; older builds kept them in state_5.sqlite.
  // Prefer the live goals DB so the bridge sees real goal activity, fall back to the legacy state DB.
  const goalsDb = path.join(os.homedir(), '.codex', 'goals_1.sqlite');
  const legacyDb = path.join(os.homedir(), '.codex', 'state_5.sqlite');
  return path.resolve(fs.existsSync(goalsDb) ? goalsDb : legacyDb);
}

// Thread metadata (cwd/title) stayed in state_5.sqlite even after goals moved to goals_1.sqlite.
function resolveThreadsPath(args = []) {
  const explicit = readFlag(args, '--threads-db', process.env.CODEX_THREADS_DB || '');
  if (explicit) return path.resolve(expandHome(explicit));
  const legacyDb = path.join(os.homedir(), '.codex', 'state_5.sqlite');
  return fs.existsSync(legacyDb) ? path.resolve(legacyDb) : '';
}

function tableExists(dbPath, table) {
  if (!dbPath || !fs.existsSync(dbPath)) return false;
  try {
    const rows = runSqliteJson(dbPath, `SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlString(table)} LIMIT 1;`);
    return rows.length > 0;
  } catch {
    return false;
  }
}

// Goals live in goals_1.sqlite (no `threads` table); thread metadata lives in state_5.sqlite.
// Legacy single-file layouts (and test fixtures) keep both in one DB. Resolve which join to use.
function goalQueryContext(args = []) {
  const goalsDb = resolveStatePath(args);
  if (tableExists(goalsDb, 'threads')) {
    return { goalsDb, threadsTable: 'threads', prefix: '' };
  }
  const threadsDb = resolveThreadsPath(args);
  if (threadsDb && threadsDb !== goalsDb && tableExists(threadsDb, 'threads')) {
    return { goalsDb, threadsTable: 'tdb.threads', prefix: `ATTACH ${sqlString(threadsDb)} AS tdb;\n` };
  }
  return { goalsDb, threadsTable: null, prefix: '' };
}

function runGoalQuery(args, buildSql) {
  const ctx = goalQueryContext(args);
  return runSqliteJson(ctx.goalsDb, ctx.prefix + buildSql(ctx.threadsTable));
}

function defaultRunsDir(args = []) {
  return path.resolve(readFlag(args, '--out-dir', path.join(process.cwd(), '.atris', 'runs')));
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: some filesystems do not support POSIX permissions.
  }
}

function chmodPrivate(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort: some filesystems do not support POSIX permissions.
  }
}

function runSqliteOnce(dbPath, sql, readonly) {
  const sqliteArgs = [];
  if (readonly) sqliteArgs.push('-readonly');
  sqliteArgs.push('-json', dbPath, sql);
  return spawnSync('sqlite3', sqliteArgs, { encoding: 'utf8' });
}

function runSqliteJson(dbPath, sql, { readonly = true } = {}) {
  let result = runSqliteOnce(dbPath, sql, readonly);
  // Codex DBs are WAL-mode. `sqlite3 -readonly` cannot open a WAL db unless a
  // writer already holds the -shm/-wal sidecars open (error 14 with no Codex
  // running). Fall back to reading a private snapshot copy of db+wal.
  const walLocked =
    readonly &&
    result.status !== 0 &&
    /unable to open database file/i.test(String(result.stderr || result.stdout || ''));
  if (walLocked) {
    const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-goal-'));
    const snapDb = path.join(snapDir, path.basename(dbPath));
    try {
      fs.copyFileSync(dbPath, snapDb);
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, snapDb + ext);
      }
      result = runSqliteOnce(snapDb, sql, false);
    } finally {
      fs.rmSync(snapDir, { recursive: true, force: true });
    }
  }
  if (result.error) throw new Error(`sqlite3 failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `sqlite3 exited with status ${result.status}`);
  }
  const out = String(result.stdout || '').trim();
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch (error) {
    throw new Error(`sqlite3 returned invalid JSON: ${error.message}`);
  }
}

function ensureStateDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Codex state database not found: ${dbPath}`);
  }
}

function selectGoalSql(whereClause, limit = 10, threadsTable = 'threads') {
  const join = threadsTable ? `LEFT JOIN ${threadsTable} t ON t.id = tg.thread_id` : '';
  const cwd = threadsTable ? 't.cwd' : 'NULL';
  const title = threadsTable ? 't.title' : 'NULL';
  const threadUpdated = threadsTable ? 't.updated_at_ms' : 'NULL';
  return `
SELECT
  tg.thread_id,
  tg.goal_id,
  tg.objective,
  tg.status,
  tg.token_budget,
  tg.tokens_used,
  tg.time_used_seconds,
  tg.created_at_ms,
  tg.updated_at_ms,
  ${cwd} AS thread_cwd,
  ${title} AS thread_title,
  ${threadUpdated} AS thread_updated_at_ms
FROM thread_goals tg
${join}
${whereClause}
ORDER BY COALESCE(${threadUpdated}, tg.updated_at_ms) DESC
LIMIT ${Number(limit) || 10}
`;
}

function readGoalByThread(args, threadId) {
  const rows = runGoalQuery(args, (tt) => selectGoalSql(`WHERE tg.thread_id = ${sqlString(threadId)}`, 1, tt));
  return rows[0] || null;
}

function readLatestGoalForCwd(args, cwd) {
  const ctx = goalQueryContext(args);
  if (!ctx.threadsTable) return null; // cannot cwd-match without thread metadata
  const realCwd = fs.realpathSync.native ? fs.realpathSync.native(cwd) : fs.realpathSync(cwd);
  const pwd = process.env.PWD || '';
  const pwdReal = pwd && fs.existsSync(pwd) ? (fs.realpathSync.native ? fs.realpathSync.native(pwd) : fs.realpathSync(pwd)) : '';
  const candidates = [...new Set([cwd, realCwd, pwdReal === realCwd ? pwd : ''].filter(Boolean))];
  const rows = runSqliteJson(ctx.goalsDb, ctx.prefix + selectGoalSql(`WHERE t.cwd IN (${candidates.map(sqlString).join(', ')})`, 1, ctx.threadsTable));
  return rows[0] || null;
}

function readRecentGoals(args, limit = 10) {
  return runGoalQuery(args, (tt) => selectGoalSql('', limit, tt));
}

function resolveThreadGoal(args) {
  const explicitThread = readFlag(args, '--thread', '');
  if (explicitThread) return readGoalByThread(args, explicitThread);
  if (hasFlag(args, '--latest')) return readLatestGoalForCwd(args, process.cwd());
  const envThread = process.env.CODEX_THREAD_ID || '';
  if (envThread) return readGoalByThread(args, envThread);
  return null;
}

function writeReceipt(outDir, payload) {
  ensurePrivateDir(outDir);
  const receiptPath = path.join(outDir, `codex-goal-${payload.action}-${safeStamp(payload.finished_at || payload.started_at)}.json`);
  const withPath = { ...payload, receipt_path: receiptPath };
  fs.writeFileSync(receiptPath, `${JSON.stringify(withPath, null, 2)}\n`, 'utf8');
  chmodPrivate(receiptPath);
  return withPath;
}

function backupSqliteDb(dbPath, backupPath) {
  const result = spawnSync('sqlite3', [dbPath, `VACUUM INTO ${sqlString(backupPath)};`], { encoding: 'utf8' });
  if (result.error) throw new Error(`sqlite3 backup failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `sqlite3 backup exited with status ${result.status}`);
  }
  chmodPrivate(backupPath);
}

function printJsonOrText(payload, lines, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(lines.join('\n'));
}

function statusCommand(args) {
  const asJson = hasFlag(args, '--json');
  const dbPath = resolveStatePath(args);
  ensureStateDb(dbPath);

  const goal = resolveThreadGoal(args);
  if (goal) {
    const payload = { ok: true, schema: SCHEMA, action: 'status', state_path: dbPath, goal };
    printJsonOrText(payload, [
      `Codex goal: ${goal.status}`,
      `Thread: ${goal.thread_id}`,
      `Objective: ${goal.objective}`,
      `Tokens/time: ${goal.tokens_used || 0} tokens, ${goal.time_used_seconds || 0}s`,
    ], asJson);
    return;
  }

  const limit = Math.max(1, Math.min(50, Number(readFlag(args, '--limit', '10')) || 10));
  const goals = readRecentGoals(args, limit);
  const payload = { ok: true, schema: SCHEMA, action: 'status', state_path: dbPath, goals };
  printJsonOrText(payload, [
    `Codex goals: ${goals.length} recent`,
    ...goals.map((row) => `- ${row.status} ${row.thread_id}: ${row.objective}`),
    'Reset requires --thread <id> or --latest.',
  ], asJson);
}

function resetCommand(args) {
  const asJson = hasFlag(args, '--json');
  const dbPath = resolveStatePath(args);
  const outDir = defaultRunsDir(args);
  ensureStateDb(dbPath);

  const startedAt = new Date().toISOString();
  const goal = resolveThreadGoal(args);
  if (!goal) {
    throw new Error('No Codex goal found. Pass --thread <thread-id> or --latest.');
  }
  if (goal.status !== 'complete') {
    throw new Error(`Refusing to reset ${goal.status} goal. Complete the native Codex goal first.`);
  }
  if (!hasFlag(args, CONFIRM_RESET_FLAG)) {
    const payload = {
      ok: false,
      schema: SCHEMA,
      action: 'reset',
      status: 'needs_confirmation',
      state_path: dbPath,
      goal,
      required_flag: CONFIRM_RESET_FLAG,
      finished_at: new Date().toISOString(),
    };
    printJsonOrText(payload, [
      'Codex goal reset blocked: confirmation required.',
      `Thread: ${goal.thread_id}`,
      `Objective: ${goal.objective}`,
      `Run again with ${CONFIRM_RESET_FLAG} to back up state and clear this completed goal slot.`,
    ], asJson);
    process.exitCode = 1;
    return;
  }

  ensurePrivateDir(outDir);
  const stamp = safeStamp(startedAt);
  const backupPath = path.join(outDir, `codex-state-before-goal-reset-${goal.thread_id}-${stamp}.sqlite`);
  const dumpPath = path.join(outDir, `codex-goal-row-before-reset-${goal.thread_id}-${stamp}.json`);
  backupSqliteDb(dbPath, backupPath);
  fs.writeFileSync(dumpPath, `${JSON.stringify(goal, null, 2)}\n`, 'utf8');
  chmodPrivate(dumpPath);

  const rows = runSqliteJson(dbPath, `
BEGIN IMMEDIATE;
DELETE FROM thread_goals
WHERE thread_id = ${sqlString(goal.thread_id)}
  AND goal_id = ${sqlString(goal.goal_id)}
  AND status = 'complete';
SELECT changes() AS deleted;
COMMIT;
`, { readonly: false });
  const deleted = Number(rows[0]?.deleted || 0);
  const remaining = readGoalByThread(args, goal.thread_id);
  const ok = deleted === 1 && !remaining;
  const payload = writeReceipt(outDir, {
    ok,
    schema: SCHEMA,
    action: 'reset',
    status: ok ? 'reset' : 'failed',
    thread_id: goal.thread_id,
    goal_id: goal.goal_id,
    objective: goal.objective,
    previous_status: goal.status,
    deleted,
    state_path: dbPath,
    backup_path: backupPath,
    dump_path: dumpPath,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    next_action: ok ? 'Call the native Codex create_goal tool in this same thread, then keep Atris Mission/member state as the durable loop.' : 'Inspect backup/dump before retrying.',
  });

  printJsonOrText(payload, [
    ok ? 'Codex goal slot reset.' : 'Codex goal reset failed.',
    `Thread: ${goal.thread_id}`,
    `Backup: ${path.relative(process.cwd(), backupPath)}`,
    `Dump: ${path.relative(process.cwd(), dumpPath)}`,
    `Receipt: ${path.relative(process.cwd(), payload.receipt_path)}`,
    `Next: ${payload.next_action}`,
  ], asJson);
  if (!ok) process.exitCode = 1;
}

function usage() {
  return [
    'atris codex-goal - guarded bridge for native Codex thread goals',
    '',
    '  atris codex-goal status [--thread <id>|--latest] [--json]',
    `  atris codex-goal reset --thread <id> ${CONFIRM_RESET_FLAG}`,
    '',
    'Flags:',
    '  --state <path>      Codex goals DB (default ~/.codex/goals_1.sqlite, falls back to state_5.sqlite)',
    '  --threads-db <path> Codex thread metadata DB for cwd/title (default ~/.codex/state_5.sqlite)',
    '  --latest           Use the latest Codex goal whose thread cwd matches the current directory',
    '  --out-dir <path>   Receipt/backup directory (default .atris/runs)',
    '',
    'Reset guardrails:',
    '- only completed native Codex goals can be reset',
    '- reset backs up the SQLite DB before mutation',
    '- reset dumps the exact deleted row and writes a receipt',
    '- the next native goal must still be created by the active Codex thread',
  ].join('\n');
}

function codexGoalCommand(args = []) {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
    console.log(usage());
    return;
  }
  if (subcommand === 'status') return statusCommand(rest);
  if (subcommand === 'reset') return resetCommand(rest);
  console.error(`Unknown codex-goal subcommand: ${subcommand}`);
  console.error(usage());
  process.exitCode = 1;
}

module.exports = {
  codexGoalCommand,
  CONFIRM_RESET_FLAG,
  resolveStatePath,
  sqlString,
};
