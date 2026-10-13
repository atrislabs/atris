'use strict';

// Done means an accepted task plus a receipt. A mission that is linked to
// task(s) may not complete just because its verifier passed: every linked task
// must be done + approval_status accepted, with proof on file. Missions with no
// linked task are not touched by this gate.

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

function acceptCommand(task, hasStoredProof) {
  return hasStoredProof
    ? `atris task accept ${task.id}`
    : `atris task accept ${task.id} --proof "<receipt: what was checked>"`;
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
    if (task.status === 'archived' || meta.approval_status === 'archived') {
      checked.push({ task_id: task.id, state: 'archived', skipped: true });
      continue;
    }
    const approval = meta.approval_status || 'none';
    const receipt = taskReceipt(taskDb, db, task);
    const hasStoredProof = Boolean(String(meta.latest_agent_proof || '').trim());
    const accepted = task.status === 'done' && approval === 'accepted';
    checked.push({ task_id: task.id, state: accepted ? 'accepted' : task.status, approval_status: approval, has_receipt: Boolean(receipt) });
    if (accepted && receipt) continue;
    const reason = accepted
      ? `linked task ${task.id} is accepted but has no receipt on file`
      : `linked task ${task.id} is ${task.status} (approval: ${approval}), not accepted`;
    return {
      ok: false,
      source: 'linked_task',
      task_id: task.id,
      reason,
      // An accepted task cannot be accepted again; only the operator override
      // (--force) can wave through one that carries no receipt at all.
      accept_command: accepted ? null : acceptCommand(task, hasStoredProof),
      tasks: checked,
    };
  }
  return { ok: true, source: 'linked_tasks_accepted', tasks: checked };
}

module.exports = { missionLinkedTaskGate, linkedTaskRefs };
