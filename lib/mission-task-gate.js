'use strict';

// Done means an accepted task plus a receipt. A mission that is linked to
// task(s) may not complete just because its verifier passed: every linked task
// must be done + approval_status accepted, with proof on file. Missions with no
// linked task are not touched by this gate.
//
// Archived tasks: archiving a task wipes its approval (approval_status becomes
// 'archived'), so an archived task is never counted as accepted. The narrowest
// safe rule: an archived task does not block, so an abandoned side task cannot
// jam a mission whose real work was accepted, but a mission whose linked tasks
// are ALL archived has nothing accepted and is refused. Accepting at least one
// live linked task (or --force) is what lets it complete. One exception: a
// task that was done and accepted before the clear-done sweep archived it
// (archived_from 'done' plus an accepting review event) still counts as accepted.

function linkedTaskRefs(mission) {
  const refs = [
    ...(Array.isArray(mission?.task_ids) ? mission.task_ids : []),
    mission?.xp_task?.task_id,
    mission?.current_task_id,
    mission?.task_id,
  ];
  return Array.from(new Set(refs.map((ref) => String(ref || '').trim()).filter(Boolean)));
}

function normalizeRef(taskDb, value) {
  return taskDb.normalizeTaskRef
    ? taskDb.normalizeTaskRef(value)
    : String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function resolveLinkedTask(taskDb, db, ref, root, cache) {
  const exact = taskDb.getTask(db, ref);
  if (exact) return exact;
  if (!cache.rows) {
    const workspaceRoot = taskDb.workspaceRoot(root);
    cache.rows = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot }));
  }
  const wanted = normalizeRef(taskDb, ref);
  if (!wanted) return null;
  const hit = cache.rows.find((row) => (
    normalizeRef(taskDb, row.display_id) === wanted
    || normalizeRef(taskDb, row.legacy_ref) === wanted
  ));
  return hit ? taskDb.getTask(db, hit.id) : null;
}

function taskReceipt(taskDb, db, task) {
  const meta = task.metadata || {};
  const stored = String(meta.latest_agent_proof || '').trim();
  if (stored) return stored;
  const events = taskDb.listTaskEvents(db, { taskId: task.id, order: 'desc', limit: 50 });
  for (const event of events) {
    const proof = String(event?.payload?.proof || '').trim();
    if (proof) return proof;
  }
  return '';
}

// The short id the user types and `atris task` prints (T6V-2), not the long
// internal id. Falls back to the long id if the board cannot be read.
function shortTaskRef(taskDb, db, task, root) {
  try {
    // `atris task accept` looks a short id up in the current workspace, so a
    // task that lives in another project keeps its full id, which works anywhere.
    if (task.workspace_root && taskDb.workspaceRoot(root) !== task.workspace_root) return task.id;
    const rows = taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot: task.workspace_root || taskDb.workspaceRoot(root) }));
    const hit = rows.find((row) => row.id === task.id);
    if (hit && hit.display_id) return hit.display_id;
  } catch {
    // fall through to the long id
  }
  return task.display_id || task.id;
}

// The clear-done sweep archives finished tasks, accepted ones included, and
// archiving overwrites the approval. A task that was done when archived and
// has an accepting review on record (reward above zero) still counts as
// accepted; anything else archived does not.
function wasAcceptedBeforeArchive(taskDb, db, task) {
  const meta = task.metadata || {};
  if (meta.archived_from !== 'done') return false;
  try {
    return taskDb.listTaskEvents(db, { taskId: task.id, order: 'desc', limit: 200 })
      .some((event) => (event.event_type === 'reviewed' || event.eventType === 'reviewed') && Number(event?.payload?.reward) > 0);
  } catch {
    return false;
  }
}

function acceptCommand(ref, hasStoredProof) {
  return hasStoredProof
    ? `atris task accept ${ref}`
    : `atris task accept ${ref} --proof "<receipt: what was checked>"`;
}

// Returns { ok: true, source, tasks } or { ok: false, source, task_id, reason,
// accept_command, tasks }. Infrastructure trouble (no task db) and linked ids
// that no longer resolve are skipped, never blocking: the gate only refuses on
// a task it can actually see.
function missionLinkedTaskGate(mission, root = process.cwd(), deps = {}) {
  const refs = linkedTaskRefs(mission);
  if (!refs.length) return { ok: true, source: 'no_linked_task', tasks: [] };
  let taskDb;
  let db;
  try {
    taskDb = deps.taskDb || require('./task-db');
    db = taskDb.open();
  } catch {
    return { ok: true, source: 'task_db_unavailable', tasks: [] };
  }
  const cache = {};
  const checked = [];
  for (const ref of refs) {
    let task = null;
    try {
      task = resolveLinkedTask(taskDb, db, ref, root, cache);
    } catch {
      task = null;
    }
    if (!task) continue;
    const meta = task.metadata || {};
    const archived = task.status === 'archived' || meta.approval_status === 'archived';
    const acceptedBeforeArchive = archived && wasAcceptedBeforeArchive(taskDb, db, task);
    if (archived && !acceptedBeforeArchive) {
      checked.push({ task_id: task.id, task_ref: shortTaskRef(taskDb, db, task, root), state: 'archived', skipped: true });
      continue;
    }
    const shortRef = shortTaskRef(taskDb, db, task, root);
    const approval = meta.approval_status || 'none';
    const receipt = taskReceipt(taskDb, db, task);
    const hasStoredProof = Boolean(String(meta.latest_agent_proof || '').trim());
    const accepted = acceptedBeforeArchive || (task.status === 'done' && approval === 'accepted');
    checked.push({ task_id: task.id, task_ref: shortRef, state: accepted ? 'accepted' : task.status, approval_status: approval, has_receipt: Boolean(receipt) });
    if (accepted && receipt) continue;
    const reason = accepted
      ? `linked task ${shortRef} is accepted but has no receipt on file`
      : `linked task ${shortRef} is ${task.status} (approval: ${approval}), not accepted`;
    return {
      ok: false,
      source: 'linked_task',
      task_id: task.id,
      task_ref: shortRef,
      reason,
      // An accepted task cannot be accepted again; only the operator override
      // (--force) can wave through one that carries no receipt at all.
      accept_command: accepted ? null : acceptCommand(shortRef, hasStoredProof),
      tasks: checked,
    };
  }
  // Every linked task we could see was archived: none was ever accepted.
  if (checked.length && checked.every((entry) => entry.state === 'archived')) {
    const names = checked.map((entry) => entry.task_ref).join(', ');
    return {
      ok: false,
      source: 'linked_task',
      task_id: checked[0].task_id,
      task_ref: checked[0].task_ref,
      reason: `every linked task (${names}) was archived and none was accepted`,
      // An archived task cannot be accepted; link a live task and accept it.
      accept_command: null,
      archived_only: true,
      tasks: checked,
    };
  }
  return { ok: true, source: 'linked_tasks_accepted', tasks: checked };
}

module.exports = { missionLinkedTaskGate, linkedTaskRefs };
