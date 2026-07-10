'use strict';

const fs = require('fs');
const path = require('path');

const HUMAN_BLOCKING_REASONS = new Set(['auth-required', 'model-unavailable', 'rate-limit-exceeded-wall']);
const OPEN_TASK_STATUSES = new Set(['open', 'claimed', 'review']);

function reasonClass(value) {
  const reason = String(value || 'blocked').trim().toLowerCase();
  return reason.replace(/\s+/g, '-').slice(0, 120) || 'blocked';
}

function taskRef(task) {
  return task?.display_id || task?.legacy_ref || task?.id || null;
}

function defaultDependencies() {
  const taskDb = require('./task-db');
  return {
    taskDb,
    resolveEngineForRole: require('./engine-registry').resolveEngineForRole,
    dispatchToEngine: require('./fleet').dispatchToEngine,
    createAgentWorktree: require('../commands/worktree').createAgentWorktree,
  };
}

function projectTasks(taskDb, db, workspaceRoot) {
  if (typeof taskDb.taskProjection !== 'function') return;
  const file = path.join(workspaceRoot, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(taskDb.taskProjection(db, { workspaceRoot, limit: 500 }), null, 2)}\n`);
}

function handleMissionBlocker({ mission, stopReason, workspaceRoot, appendEvent }, injected = {}) {
  if (!mission || !mission.id) return { taskId: null, dispatched: false, engine: null, reason: 'missing mission' };
  const blockerClass = reasonClass(stopReason || mission.stop_reason || mission.last_tick_reason);
  if (HUMAN_BLOCKING_REASONS.has(blockerClass) || (Array.isArray(mission.human_asks) && mission.human_asks.length)) {
    return { taskId: null, dispatched: false, engine: null, reason: 'human-blocking' };
  }
  if (['ready', 'complete'].includes(String(mission.status || '').toLowerCase())) {
    return { taskId: null, dispatched: false, engine: null, reason: 'stop condition met' };
  }

  const deps = { ...defaultDependencies(), ...injected };
  const root = path.resolve(workspaceRoot || process.cwd());
  const db = deps.taskDb.open();
  const scopedRoot = deps.taskDb.workspaceRoot ? deps.taskDb.workspaceRoot(root) : root;
  const rows = deps.taskDb.withTaskDisplayRefs(deps.taskDb.listTasks(db, { workspaceRoot: scopedRoot }));
  const matching = rows.filter((row) => row.metadata?.mission_id === mission.id
    && row.metadata?.mission_blocker_class === blockerClass);
  const existing = matching.find((row) => OPEN_TASK_STATUSES.has(row.status));
  let task = existing;

  if (task) {
    return { taskId: taskRef(task), dispatched: false, engine: null, reason: 'existing blocker task' };
  }

  if (!task) {
    const evidence = String(mission.receipt_path || mission.last_tick_reason || stopReason || blockerClass).trim();
    const title = `Unblock mission "${String(mission.objective || mission.id).trim()}": ${String(stopReason || blockerClass).trim()}. Evidence: ${evidence}.`;
    const created = deps.taskDb.addTask(db, {
      title,
      tag: 'mission-blocker',
      workspaceRoot: scopedRoot,
      sourceKey: `mission-blocker:${mission.id}:${blockerClass}:${matching.length}`,
      metadata: {
        mission_id: mission.id,
        mission_objective: mission.objective || null,
        mission_blocker_class: blockerClass,
        stop_reason: String(stopReason || blockerClass),
        evidence,
      },
    });
    const refreshed = deps.taskDb.withTaskDisplayRefs(deps.taskDb.listTasks(db, { workspaceRoot: scopedRoot }));
    task = refreshed.find((row) => row.id === created.id) || deps.taskDb.getTask(db, created.id);
    projectTasks(deps.taskDb, db, scopedRoot);
    if (created.inserted === false) {
      return { taskId: taskRef(task), dispatched: false, engine: null, reason: 'existing blocker task' };
    }
    if (created.inserted !== false) {
      appendEvent?.('mission_blocker_task_filed', {
        task_id: taskRef(task),
        stop_reason: String(stopReason || blockerClass),
        blocker_class: blockerClass,
      });
    }
  }

  const ref = taskRef(task);
  const engine = deps.resolveEngineForRole('executor', scopedRoot);
  if (!engine) return { taskId: ref, dispatched: false, engine: null, reason: 'no ready executor engine' };

  try {
    if (task.status === 'open' && typeof deps.taskDb.claimTask === 'function') {
      const claim = deps.taskDb.claimTask(db, { id: task.id, claimedBy: `fleet-${engine.id}` });
      if (!claim.claimed) return { taskId: ref, dispatched: false, engine: null, reason: 'existing blocker task' };
      task = { ...task, ...claim.row };
    }
    const worktree = deps.createAgentWorktree({
      root: scopedRoot,
      agent: engine.id,
      task: `mission-blocker-${String(ref).toLowerCase()}`,
    });
    deps.dispatchToEngine({ task, engine: engine.id, worktreePath: worktree.path, root: scopedRoot });
    projectTasks(deps.taskDb, db, scopedRoot);
    appendEvent?.('mission_blocker_dispatched', {
      task_id: ref,
      engine: engine.id,
      blocker_class: blockerClass,
      worktree_path: worktree.path,
    });
    return { taskId: ref, dispatched: true, engine: engine.id, reason: 'dispatched' };
  } catch (error) {
    return { taskId: ref, dispatched: false, engine: engine.id, reason: error.message || String(error) };
  }
}

module.exports = { handleMissionBlocker };
