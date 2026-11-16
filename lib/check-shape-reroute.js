'use strict';

// A second check that cannot run because the job recorded a check command
// this machine may not run on its own never sits still for more than one
// pass.
//
// The review list said "used a check command the system does not allow;
// rerun with an approved check", and nothing reran it: the job waited for a
// person to notice. In atrisos-web the usual cause is `npx vitest run
// <paths>`, which the hourly pass refuses, while the same tests run through
// the allowed `node scripts/verify-vitest.mjs <paths>`.
//
// Each pass, for every review job in that state:
//
// One. When the recorded check has a known allowed shape in this project,
// the job's check is rewritten to it (the old one is kept on the row), so
// the second check runs it in this same pass.
//
// Two. Otherwise the job goes back to its builder with a note naming the
// check and the allowed shapes. A job held for a person is only reported.

const fs = require('fs');
const path = require('path');

const SAFE_PATH = /^(?![/-])(?!.*\.\.)[\w.@+/-]+$/;
// Vitest options that take the next word as their value.
const VALUE_FLAGS = new Set(['-t', '--testNamePattern', '--reporter', '--config', '-c', '--project', '--dir', '--root', '-r',
  '--environment', '--pool', '--maxWorkers', '--minWorkers', '--shard', '--outputFile', '--mode', '--testTimeout']);

// The paths a vitest command runs, or null when it is not a plain vitest run.
function vitestPaths(command) {
  const cmd = String(command || '').trim();
  if (!cmd || /[;&|`$<>\\'"\n]/.test(cmd)) return null;
  const tokens = cmd.split(/\s+/);
  let i = 0;
  if (tokens[0] === 'npx') i = 1;
  else if (tokens[0] === 'pnpm' && tokens[1] === 'exec') i = 2;
  if (tokens[i] === 'vitest') {
    i += 1;
    if (tokens[i] === 'run') i += 1;
  } else if (tokens[0] === 'npm' && (tokens[1] === 'test' || (tokens[1] === 'run' && tokens[2] === 'test'))) {
    i = tokens[1] === 'test' ? 2 : 3;
    if (tokens[i] !== '--') return null;
    i += 1;
  } else {
    return null;
  }
  const paths = [];
  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('-')) {
      if (!token.includes('=') && VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    if (token === 'run') continue;
    if (!SAFE_PATH.test(token)) return null;
    paths.push(token);
  }
  return paths.length ? paths : null;
}

// A command copied out of a proof often carries its result after it
// ("node scripts/verify-vitest.mjs app/x, exit 0, 298 focused tests"). The
// command alone is the part before the first comma, " (" or sentence end.
function commandAlone(command) {
  const cmd = String(command || '').trim();
  const cut = cmd.search(/,\s|\s\(|\.\s|\.$/);
  return cut > 0 ? cmd.slice(0, cut).trim() : cmd;
}

// The allowed command the same check becomes in this project, or null.
function allowedShapeFor(command, root, { allowed } = {}) {
  const isAllowed = allowed || require('./auto-accept-certified').isAutoCertifyVerifyCommandAllowed;
  const hasVitestRunner = fs.existsSync(path.join(root, 'scripts', 'verify-vitest.mjs'));
  for (const candidate of [...new Set([String(command || '').trim(), commandAlone(command)])]) {
    if (!candidate) continue;
    if (candidate !== String(command || '').trim() && isAllowed(candidate)) return candidate;
    const paths = vitestPaths(candidate);
    if (paths && hasVitestRunner) {
      const rewritten = `node scripts/verify-vitest.mjs ${paths.join(' ')}`;
      if (isAllowed(rewritten)) return rewritten;
    }
  }
  return null;
}

function sendBackNote(command) {
  return `The second check could not run: \`${command}\` is not a check this machine may run on its own. `
    + 'Record an allowed one (for example `node scripts/verify-vitest.mjs <paths>`, `npm test`, `npm run <script>` or `node --test <file>`) '
    + 'and mark the job ready again; it is checked on the next pass.';
}

function defaultBlocker(task) {
  return require('../commands/task').reviewBlockerForTask(task);
}

function defaultRewrite(task, { verify, from }) {
  const taskDb = require('./task-db');
  const db = taskDb.open();
  const row = taskDb.getTask(db, task.id);
  if (!row || row.status !== 'review') return { updated: false };
  if (task.updated_at != null && Number(row.updated_at) !== Number(task.updated_at)) return { updated: false };
  taskDb.updateTaskMetadata(db, task.id, (m) => {
    m.verify = verify;
    m.verify_rerouted_from = from;
    m.verify_rerouted_at = new Date().toISOString();
    m.verify_rerouted_by = 'autoland';
  });
  return { updated: true };
}

function defaultSendBack(task, { note }) {
  const taskDb = require('./task-db');
  const db = taskDb.open();
  const row = taskDb.getTask(db, task.id);
  if (!row || row.status !== 'review') return { revised: false };
  if (task.updated_at != null && Number(row.updated_at) !== Number(task.updated_at)) return { revised: false };
  return taskDb.reviseTask(db, { id: task.id, actor: 'autoland', note });
}

function rerouteDisallowedChecks({
  root, tasks = [], dryRun = false, blocker = defaultBlocker, rewrite = defaultRewrite, sendBack = defaultSendBack, allowed,
} = {}) {
  const out = { rerouted: [], sent_back: [], held: [] };
  const { isAgentCertified } = require('./auto-accept-certified');
  for (const task of tasks) {
    if (!task || task.status !== 'review') continue;
    const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
    const approval = String((task.review && task.review.approval_status) || metadata.approval_status || 'pending');
    if (approval !== 'pending' || isAgentCertified(task)) continue;
    let found;
    try {
      found = blocker(task);
    } catch {
      continue;
    }
    if (!found || found.reason !== 'verify_command_not_allowed' || !found.verify_command) continue;
    const ref = task.display_id || task.legacy_ref || task.id;
    const command = String(found.verify_command);
    // Rewritten once already and still refused: the builder takes it.
    const shape = metadata.verify_rerouted_from ? null : allowedShapeFor(command, root, { allowed });
    if (shape) {
      const row = { id: task.id, ref, from: command, to: shape };
      if (dryRun) { out.rerouted.push(row); continue; }
      let done = null;
      try { done = rewrite(task, { verify: shape, from: command }); } catch { done = null; }
      if (done && done.updated) out.rerouted.push(row);
      continue;
    }
    let held = '';
    try { held = require('./member-task-pick').heldForPerson(task); } catch { held = 'unreadable'; }
    if (held) { out.held.push({ id: task.id, ref, command, reason: held }); continue; }
    const note = sendBackNote(command);
    const row = { id: task.id, ref, command, builder: task.claimed_by || null, note };
    if (dryRun) { out.sent_back.push(row); continue; }
    let sent = null;
    try { sent = sendBack(task, { note }); } catch { sent = null; }
    if (sent && sent.revised) out.sent_back.push(row);
  }
  return out;
}

module.exports = {
  allowedShapeFor,
  rerouteDisallowedChecks,
  sendBackNote,
  vitestPaths,
};
