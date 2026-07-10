'use strict';

const fs = require('fs');
const path = require('path');

const HUMAN_BLOCKING_REASONS = new Set(['auth-required', 'model-unavailable', 'rate-limit-exceeded-wall']);
const OPEN_TASK_STATUSES = new Set(['open', 'claimed', 'review']);

const SWARLO_HUB = process.env.SWARLO_HUB_URL || process.env.SWARLO_HUB || 'http://localhost:8090';
const SWARLO_HUB_ID = process.env.SWARLO_HUB_ID || 'atris';
const SWARLO_FLEET_TIMEOUT_MS = 3000;
const SWARLO_ESCALATIONS_CHANNEL = 'escalations';

function loadSwarloApiKey() {
  if (process.env.SWARLO_API_KEY) return process.env.SWARLO_API_KEY;
  const keyDir = path.join(require('os').homedir(), '.swarlo');
  let files;
  try {
    // Newest key first: the hub DB rotates and old keys 401, so mtime beats
    // lexicographic order (live repro 2026-07-10: first-sorted key was dead,
    // the most recently minted one was valid).
    files = fs.readdirSync(keyDir)
      .filter((name) => name.endsWith('.key'))
      .map((name) => {
        const full = path.join(keyDir, name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (error) { /* skip */ }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (error) {
    return null;
  }
  if (!files.length) return null;
  const key = fs.readFileSync(files[0].full, 'utf8').trim();
  return key || null;
}

// Default synchronous HTTP transport: shells out to curl so this stays
// callable from handleMissionBlocker without turning it into an async fn
// (existing callers in commands/mission.js read the return value inline).
function curlPost(url, { headers, body, timeoutMs }) {
  const { spawnSync } = require('child_process');
  const args = ['-sS', '-o', '-', '-w', '\n%{http_code}', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-X', 'POST'];
  for (const [key, value] of Object.entries(headers || {})) {
    args.push('-H', `${key}: ${value}`);
  }
  args.push('-d', body, url);
  const result = spawnSync('curl', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return { ok: false, status: 0, body: '' };
  }
  const output = result.stdout || '';
  const lastNewline = output.lastIndexOf('\n');
  const statusCode = Number(output.slice(lastNewline + 1).trim());
  const responseBody = lastNewline >= 0 ? output.slice(0, lastNewline) : '';
  return { ok: statusCode >= 200 && statusCode < 300, status: statusCode, body: responseBody };
}

function postBlockerToFleet({ task, blockerClass, stopReason, mission }, injected = {}) {
  const loadKey = injected.loadSwarloApiKey || loadSwarloApiKey;
  const httpPost = injected.httpPost || curlPost;
  const channel = SWARLO_ESCALATIONS_CHANNEL;
  try {
    const apiKey = loadKey();
    if (!apiKey) return { posted: false, channel };
    const ref = taskRef(task);
    const content = `Mission blocker filed with no local engine ready: ${ref} — ${String(stopReason || blockerClass).trim()}. Mission: ${String(mission?.objective || mission?.id || '').trim()}.`;
    const response = httpPost(`${SWARLO_HUB}/api/${SWARLO_HUB_ID}/channels/${channel}/posts`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ content, kind: 'alert', task_key: ref }),
      timeoutMs: SWARLO_FLEET_TIMEOUT_MS,
    });
    if (!response || !response.ok) return { posted: false, channel };
    return { posted: true, channel };
  } catch (error) {
    return { posted: false, channel };
  }
}

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
  if (!engine) {
    const fleet = postBlockerToFleet({ task, blockerClass, stopReason, mission }, injected);
    if (fleet.posted) {
      appendEvent?.('mission_blocker_fleet_escalated', {
        task_id: ref,
        blocker_class: blockerClass,
        channel: fleet.channel,
      });
      return { taskId: ref, dispatched: false, engine: null, fleet_posted: true, reason: 'no ready executor engine; escalated to fleet' };
    }
    return { taskId: ref, dispatched: false, engine: null, fleet_posted: false, reason: 'no ready executor engine' };
  }

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
