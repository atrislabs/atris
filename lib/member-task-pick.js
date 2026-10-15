'use strict';

// The next real job for a member with no idea given: the oldest open,
// unclaimed task assigned to them, then an unassigned task whose job (build,
// review, search) matches theirs, held neither for a human nor in a protected lane. Callers
// fall back to the member's own goal when this returns null, unless they
// ask for requireCheck: then only tasks with a runnable check count, and
// nothing found means the member stays idle.

const { autoJobForMember } = require('./member-engine');
const { deniedTagOf, declaredProtectedLane, sniffedProtectedLane, isAutoCertifyVerifyCommandAllowed } = require('./auto-accept-certified');
const { isDecisionHoldTag, isDecisionTask, taskTagTokens } = require('./task-decision');

// A task's job uses the member rule with its tags in the name slot and its
// title in the role slot: tags decide first, then the title, else build.
function jobForTask(task) {
  return autoJobForMember(taskTagTokens(task).join(' '), task && task.title);
}

function taskBody(task) {
  const meta = (task && task.metadata) || {};
  return ['objective', 'body', 'description', 'details']
    .map((key) => (typeof meta[key] === 'string' ? meta[key].trim() : ''))
    .find(Boolean) || '';
}

// The objective a member run gets: the title, then the body when there is one,
// on one line. Mission start refuses objectives with line breaks.
function taskObjective(task) {
  const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const title = oneLine(task && task.title);
  const body = oneLine(taskBody(task));
  if (!body) return title;
  return /[.!?]$/.test(title) ? `${title} ${body}` : `${title}. ${body}`;
}

// Held for a person: a denied tag on the row or in its metadata, a protected
// lane declared anywhere in its text, or lane terms in its title or body.
// Tags written in metadata, which the shared tag parser does not read.
function metadataTags(task) {
  const meta = (task && task.metadata) || {};
  return [meta.tag, ...(Array.isArray(meta.tags) ? meta.tags : [])]
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim().toLowerCase().replace(/^#/, ''));
}

function protectedTask(task) {
  const meta = (task && task.metadata) || {};
  const tags = [...metadataTags(task), ...taskTagTokens(task)];
  if (deniedTagOf(task) || tags.some((tag) => deniedTagOf({ tag }))) return true;
  // Every text field, not just the one the objective uses.
  const allText = ['objective', 'body', 'description', 'details']
    .map((key) => (typeof meta[key] === 'string' ? meta[key] : ''))
    .filter(Boolean)
    .join('\n');
  const probe = { title: task.title, objective: allText, metadata: meta };
  return Boolean(declaredProtectedLane(probe) || sniffedProtectedLane(probe));
}

// The check a task requires, when it names one. A check written as prose
// that cannot be run means the task cannot be proven here.
function taskCheck(task) {
  const verify = task && task.metadata && typeof task.metadata.verify === 'string'
    ? task.metadata.verify.trim() : '';
  if (!verify) return { command: '', runnable: true };
  return { command: verify, runnable: isAutoCertifyVerifyCommandAllowed(verify) };
}

function assigneeOf(task) {
  const assigned = task?.metadata?.assigned_to;
  return typeof assigned === 'string' ? assigned.trim() : '';
}

// Held for a person, the one test both the picker and the merge-line close
// use, so a merge never closes a job the picker would leave alone.
function heldForPerson(task) {
  if (isDecisionTask(task) || metadataTags(task).some(isDecisionHoldTag)) return 'needs_human';
  if (protectedTask(task)) return 'protected_lane';
  return '';
}

function skipReason(task, job, { requireCheck = false, member, recoverClaimed = false } = {}) {
  const ownClaim = recoverClaimed && member && task?.status === 'claimed' && task.claimed_by === member;
  if (!task || (task.status !== 'open' && !ownClaim)) return 'not_open';
  if (task.claimed_by && !ownClaim) return 'claimed';
  const assignee = assigneeOf(task);
  if (assignee && assignee !== member) return 'other_member';
  const held = heldForPerson(task);
  if (held) return held;
  const check = taskCheck(task);
  if (!check.runnable) return 'check_not_runnable';
  if (requireCheck && !check.command) return 'no_check';
  // A named assignment is more specific than the inferred job type.
  if (!assignee && jobForTask(task) !== job) return 'other_job';
  return '';
}

function fittingTasks(taskDb, db, { workspaceRoot, job, requireCheck = false, member, recoverClaimed = false }) {
  const tasks = taskDb.listTasks(db, { workspaceRoot, status: 'open' });
  // Only a caller that checked the member has no live run may recover its
  // own claim. Keep the same human, lane, job, and check gates.
  if (recoverClaimed && member) tasks.push(...taskDb.listTasks(db, { workspaceRoot, status: 'claimed' }));
  return tasks
    .filter((task) => !skipReason(task, job, { requireCheck, member, recoverClaimed }))
    .sort((a, b) => Number(Boolean(assigneeOf(b))) - Number(Boolean(assigneeOf(a)))
      || (a.created_at - b.created_at) || String(a.id).localeCompare(String(b.id)));
}

function pickTaskForMember(taskDb, db, options) {
  return fittingTasks(taskDb, db, options)[0] || null;
}

// Claim the oldest fitting task for the member. A lost race moves on to the
// next candidate; null when nothing fits or every claim lost.
function claimTaskForMember(taskDb, db, { workspaceRoot, member, job, requireCheck = false, recoverClaimed = false }) {
  for (const task of fittingTasks(taskDb, db, { workspaceRoot, member, job, requireCheck, recoverClaimed })) {
    if (task.status === 'claimed') {
      const released = taskDb.releaseTask(db, { id: task.id, actor: member, expectedUpdatedAt: task.updated_at });
      if (!released.released) continue;
    }
    let result;
    try {
      result = taskDb.claimTask(db, { id: task.id, claimedBy: member });
    } catch (error) {
      // A claim that half-wrote must not strand the task.
      try { taskDb.releaseTask(db, { id: task.id, actor: member }); } catch {}
      throw error;
    }
    if (result.claimed) return { task: result.row, objective: taskObjective(result.row) };
  }
  return null;
}

module.exports = {
  taskCheck,
  claimTaskForMember,
  fittingTasks,
  heldForPerson,
  jobForTask,
  pickTaskForMember,
  skipReason,
  taskObjective,
};
