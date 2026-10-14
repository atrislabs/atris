'use strict';

// The next real job for a member with no idea given: the oldest open,
// unclaimed task in this workspace whose job (build, review, search) matches
// the member's, held neither for a human nor in a protected lane. Callers
// fall back to the member's own goal when this returns null.

const { autoJobForMember } = require('./member-engine');
const { deniedTagOf } = require('./auto-accept-certified');
const { isDecisionTask, taskTagTokens } = require('./task-decision');

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

function skipReason(task, job) {
  if (!task || task.status !== 'open') return 'not_open';
  if (task.claimed_by) return 'claimed';
  if (isDecisionTask(task)) return 'needs_human';
  if (deniedTagOf(task)) return 'protected_lane';
  if (jobForTask(task) !== job) return 'other_job';
  return '';
}

function fittingTasks(taskDb, db, { workspaceRoot, job }) {
  return taskDb.listTasks(db, { workspaceRoot, status: 'open' })
    .filter((task) => !skipReason(task, job))
    .sort((a, b) => (a.created_at - b.created_at) || String(a.id).localeCompare(String(b.id)));
}

function pickTaskForMember(taskDb, db, { workspaceRoot, job }) {
  return fittingTasks(taskDb, db, { workspaceRoot, job })[0] || null;
}

// Claim the oldest fitting task for the member. A lost race moves on to the
// next candidate; null when nothing fits or every claim lost.
function claimTaskForMember(taskDb, db, { workspaceRoot, member, job }) {
  for (const task of fittingTasks(taskDb, db, { workspaceRoot, job })) {
    const result = taskDb.claimTask(db, { id: task.id, claimedBy: member });
    if (result.claimed) return { task: result.row, objective: taskObjective(result.row) };
  }
  return null;
}

module.exports = {
  claimTaskForMember,
  jobForTask,
  pickTaskForMember,
  skipReason,
  taskObjective,
};
