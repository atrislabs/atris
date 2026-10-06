'use strict';

// Finished work that can never land on its own should not wait forever.
// Every hourly autoland tick: a review row idle past the grace period whose
// check this machine cannot rerun from main is closed with a plain reason.
// Landable rows are left for the landing pass, protected lanes (money,
// deploys, security, customer, outward) are left for the human, and anything
// still moving (touched inside the grace period) is left alone.

const taskDb = require('./task-db');
const { evaluateAutoAccept, protectedLaneOf, verifyRunnability } = require('./auto-accept-certified');
const { plainLandingReason } = require('./voice-gate');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_CLOSE_DAYS = 7;

// Reasons that mean "no machine can ever check this from main as it stands".
// A human or the builder can still reopen it with a check that runs.
const UNVERIFIABLE_REASONS = new Set([
  'verify_command_not_allowed',
  'verify_only_on_agent_branch',
  'verify_failed_on_main',
  'verify_workdir_missing',
  'verify_worktree_missing',
  'strict_verify_missing',
  'no_verify_command',
]);

function idleCloseMs(policy = {}) {
  const days = Number(policy && policy.idle_close_days);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_IDLE_CLOSE_DAYS) * DAY_MS;
}

const CLOSE_WHY = {
  verify_command_not_allowed: 'its check is a kind this machine may not run on its own',
  verify_only_on_agent_branch: "its check runs a file that only exists on the agent's branch, never on main",
  verify_failed_on_main: 'its check fails when rerun from the main project, so the work never reached main',
  verify_workdir_missing: 'the folder its check ran in is gone',
  verify_worktree_missing: 'the agent copy its check ran in is gone',
  strict_verify_missing: 'it has no check to rerun',
  no_verify_command: 'it has no check to rerun',
};

function closeReason(reason, days) {
  const why = CLOSE_WHY[reason] || plainLandingReason(reason) || reason;
  return `Closed after ${days} days waiting, because ${why}, so it could never land on its own. Reopen it with a check that runs from the main project if the work still matters.`;
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Idle means nobody worked on it, not that no machine touched it: the hourly
// re-check stamps updated_at on every row whose check runs, which would keep
// a never-landable row "fresh" forever. Count only people and builders.
function lastActivityAt(task, now = Date.now()) {
  const metadata = task.metadata || {};
  const at = Math.max(
    toMs(task.created_at),
    toMs(task.claimed_at),
    toMs(metadata.agent_reviewed_at),
    toMs(metadata.stage_updated_at),
    toMs(metadata.planned_at),
    toMs(metadata.human_revision_at),
    toMs(metadata.backlogged_at),
  );
  return at > 0 ? at : now;
}

// Pure decision for one projection row. `liveReasons` carries the landing
// pass's executed verdicts from this tick (verify_failed_on_main can only be
// known by running the check), keyed by ref.
function idleDecision(task, { root, policy = {}, now = Date.now(), liveReasons = new Map() } = {}) {
  if (!task || task.status !== 'review') return { action: 'skip', why: 'not_review' };
  const approval = String(task.review?.approval_status || task.metadata?.approval_status || 'pending');
  if (approval !== 'pending' && approval !== 'agent_certified') return { action: 'skip', why: 'decided' };
  const lane = protectedLaneOf(task);
  if (lane) return { action: 'human', lane };
  const idleMs = now - lastActivityAt(task, now);
  if (!(idleMs > idleCloseMs(policy))) return { action: 'wait', why: 'still_in_grace' };
  const ref = task.display_id || task.legacy_ref || task.id;
  let reason = liveReasons.get(ref) || null;
  if (!reason) {
    const evaluation = evaluateAutoAccept(
      { ...task, workspace_root: root },
      { strictVerify: policy.strict_verify !== false, acceptAll: Boolean(policy.accept_all), executeVerify: false },
    );
    if (evaluation.eligible) return { action: 'land', why: 'landing_pass_takes_it' };
    reason = verifyRunnability({ ...task, workspace_root: root }) || evaluation.reason;
  }
  if (!UNVERIFIABLE_REASONS.has(reason)) return { action: 'wait', why: reason };
  return { action: 'close', reason, days: Math.floor(idleMs / DAY_MS) };
}

function sweepIdleReviews(root, { tasks, policy = {}, now = Date.now(), liveReasons = new Map(), dryRun = false, actor = 'autoland' } = {}) {
  const closed = [];
  const humanWaiting = [];
  const due = [];
  for (const task of tasks || []) {
    const decision = idleDecision(task, { root, policy, now, liveReasons });
    const ref = task.display_id || task.legacy_ref || task.id;
    if (decision.action === 'human') humanWaiting.push({ ref, lane: decision.lane });
    if (decision.action === 'close') due.push({ id: task.id, ref, title: task.title || '', reason: decision.reason, text: closeReason(decision.reason, decision.days) });
  }
  if (dryRun || !due.length) return { closed: dryRun ? due : closed, due: due.length, human_waiting: humanWaiting, dry_run: dryRun };

  const db = taskDb.open();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of due) {
      const result = taskDb.archiveTask(db, { id: item.id, actor, reason: item.text, skipLogs: true });
      if (result.archived) closed.push(item);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* surface the original error */ }
    throw error;
  }
  return { closed, due: due.length, human_waiting: humanWaiting, dry_run: false };
}

module.exports = {
  idleDecision,
  lastActivityAt,
  sweepIdleReviews,
};
