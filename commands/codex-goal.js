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
  return path.resolve(expandHome(readFlag(args, '--state', process.env.CODEX_STATE_DB || path.join(os.homedir(), '.codex', 'state_5.sqlite'))));
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

function runSqliteJson(dbPath, sql, { readonly = true } = {}) {
  const sqliteArgs = [];
  if (readonly) sqliteArgs.push('-readonly');
  sqliteArgs.push('-json', dbPath, sql);
  const result = spawnSync('sqlite3', sqliteArgs, { encoding: 'utf8' });
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

function selectGoalSql(whereClause, limit = 10) {
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
  t.cwd AS thread_cwd,
  t.title AS thread_title,
  t.updated_at_ms AS thread_updated_at_ms
FROM thread_goals tg
LEFT JOIN threads t ON t.id = tg.thread_id
${whereClause}
ORDER BY COALESCE(t.updated_at_ms, tg.updated_at_ms) DESC
LIMIT ${Number(limit) || 10}
`;
}

function readGoalByThread(dbPath, threadId) {
  const rows = runSqliteJson(dbPath, selectGoalSql(`WHERE tg.thread_id = ${sqlString(threadId)}`, 1));
  return rows[0] || null;
}

function readLatestGoalForCwd(dbPath, cwd) {
  const realCwd = fs.realpathSync.native ? fs.realpathSync.native(cwd) : fs.realpathSync(cwd);
  const pwd = process.env.PWD || '';
  const pwdReal = pwd && fs.existsSync(pwd) ? (fs.realpathSync.native ? fs.realpathSync.native(pwd) : fs.realpathSync(pwd)) : '';
  const candidates = [...new Set([cwd, realCwd, pwdReal === realCwd ? pwd : ''].filter(Boolean))];
  const rows = runSqliteJson(dbPath, selectGoalSql(`WHERE t.cwd IN (${candidates.map(sqlString).join(', ')})`, 1));
  return rows[0] || null;
}

function readRecentGoals(dbPath, limit = 10) {
  return runSqliteJson(dbPath, selectGoalSql('', limit));
}

function resolveThreadGoal(dbPath, args) {
  const explicitThread = readFlag(args, '--thread', '');
  if (explicitThread) return readGoalByThread(dbPath, explicitThread);
  if (hasFlag(args, '--latest')) return readLatestGoalForCwd(dbPath, process.cwd());
  const envThread = process.env.CODEX_THREAD_ID || '';
  if (envThread) return readGoalByThread(dbPath, envThread);
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

  const goal = resolveThreadGoal(dbPath, args);
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
  const goals = readRecentGoals(dbPath, limit);
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
  const goal = resolveThreadGoal(dbPath, args);
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
  const remaining = readGoalByThread(dbPath, goal.thread_id);
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
    '  --state <path>      Codex state DB (default ~/.codex/state_5.sqlite)',
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
