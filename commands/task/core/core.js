'use strict';

// commands/task/core/core.js: Small helpers that several task features use: finding a task by its
// id, quoting, plain public words.
// Owner: shared, see README.md. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js;
// read README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let reviewIntegrity, scopedWorkspaceRoot, failTask, readProjectionFile;
function bindMain(deps) {
  ({
    reviewIntegrity, scopedWorkspaceRoot, failTask, readProjectionFile,
  } = deps);
}

function resolveTaskRef(taskDb, db, ref) {
  const token = String(ref || '').trim();
  if (!token) return { ok: false, reason: 'missing' };
  const exact = db ? taskDb.getTask(db, token) : null;
  if (exact) return { ok: true, id: exact.id, row: exact };
  const normalized = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(token) : token.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const wsRoot = taskDb.workspaceRoot ? taskDb.workspaceRoot() : process.cwd();

  const proj = readProjectionFile(wsRoot);
  if (proj && Array.isArray(proj.tasks)) {
    const seen = new Set();
    const matches = proj.tasks.filter(r => {
      const id = String(r.id || '').toUpperCase();
      const display = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.display_id) : String(r.display_id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const legacy = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.legacy_ref) : String(r.legacy_ref || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const matched = id.startsWith(normalized) || (display && display === normalized) || (legacy && legacy === normalized);
      if (!matched || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    if (matches.length === 1) {
      const match = matches[0];
      const row = db ? (taskDb.getTask(db, match.id) || match) : match;
      return { ok: true, id: match.id, row };
    }
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  }

  if (db) {
    const rows = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot: wsRoot }));
    const seen = new Set();
    const matches = rows.filter(r => {
      const id = String(r.id || '').toUpperCase();
      const display = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.display_id) : String(r.display_id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const legacy = taskDb.normalizeTaskRef ? taskDb.normalizeTaskRef(r.legacy_ref) : String(r.legacy_ref || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const matched = id.startsWith(normalized) || (display && display === normalized) || (legacy && legacy === normalized);
      if (!matched || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    if (matches.length === 1) return { ok: true, id: matches[0].id, row: matches[0] };
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  }
  return { ok: false, reason: 'not_found' };
}

function requireTaskId(taskDb, db, ref, label) {
  const resolved = resolveTaskRef(taskDb, db, ref);
  if (resolved.ok) return resolved.id;
  if (resolved.reason === 'ambiguous') {
    failTask(label, 'ambiguous', `ambiguous task id prefix "${ref}"`);
  } else if (resolved.reason === 'missing') {
    failTask(label, 'missing_id', 'task id required');
  } else {
    failTask(label, 'not_found', `task not found: ${ref}`);
  }
}

function workspaceRefRows(taskDb, db, options = {}) {
  return taskDb.listTasks(db, { workspaceRoot: scopedWorkspaceRoot(taskDb, [], options) });
}

// Local calendar day; toISOString is UTC and calls the evening tomorrow
// anywhere west of Greenwich.
function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// judge != worker support: reserved system names (autoland-verifier and co)
// can never be assumed via --as, and unknown names warn by default or fail
// under ATRIS_ACTOR_VALIDATION=enforce. Only explicit --as values are
// checked; the DEFAULT_OWNER fallback stays silent.
function guardExplicitActor(command, value) {
  if (typeof value !== 'string' || !value.trim()) return;
  const check = reviewIntegrity.validateActor(value, { root: process.cwd() });
  if (!check.ok) {
    if (check.reason === 'reserved_actor') {
      console.error(`${command}: reserved_actor: '${value}' is a system actor and cannot be used with --as`);
    } else {
      console.error(`${command}: actor_not_on_roster: '${value}' is not a workspace member or engine (actor validation is enforced)`);
    }
    process.exit(1);
  }
  if (check.reason === 'actor_not_on_roster' && check.mode === 'warn') {
    console.error(`Warning: '${value}' is not a workspace member or engine; reviews under unknown names weaken the audit trail.`);
  }
}

// Collect EVERY value for a repeatable flag (flag() only returns the first),
// so `--add a --add b` and `--add a,b` both work.
function collectFlagValues(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length && !String(args[i + 1]).startsWith('--')) {
      values.push(args[i + 1]);
    }
  }
  return values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

// Printed lines get pasted into a shell. Plain words keep readable double
// quotes; text a shell would act on ($, backticks, \, !) is single-quoted so
// pasting it runs no command and keeps the words as written.
function taskCommandQuote(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim() || '...';
  if (/[$`\\!]/.test(text)) return `'${text.replace(/'/g, `'\\''`)}'`;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function cleanPublicText(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function publicWords(value) {
  return (String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .map(word => word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word)
    .filter(word => !new Set([
      'and',
      'for',
      'from',
      'into',
      'the',
      'this',
      'that',
      'task',
      'work',
      'with',
    ]).has(word));
}

module.exports = {
  bindMain, resolveTaskRef, requireTaskId, workspaceRefRows, localDay, guardExplicitActor,
  collectFlagValues, taskCommandQuote, cleanPublicText, publicWords,
};
