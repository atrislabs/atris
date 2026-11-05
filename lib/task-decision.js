'use strict';

// Decision rows are human judgment calls, not agent work. Detect them from
// tags already in the data (primary tag, tags[], metadata.tags). The live
// marker is needs-human (CLI-879); decision is the same hold under a clearer
// name. Autonomous pickers must refuse these; list renderers must show them.

const { decisionChoiceText } = require('./task-explanation');

const DECISION_HOLD_TAGS = new Set([
  'needs-human',
  'needshuman',
  'decision',
]);

const DECISION_MARKER = '[decision]';
const DECISION_REFUSE_REASON = 'decision row: human judgment required';

function normalizeDecisionTag(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/_/g, '-');
}

function taskTagTokens(task) {
  if (!task || typeof task !== 'object') return [];
  const fromTags = Array.isArray(task.tags) ? task.tags : [];
  const fromTag = task.tag ? [task.tag] : [];
  const fromMeta = task.metadata && Array.isArray(task.metadata.tags) ? task.metadata.tags : [];
  const fromTitle = (String(task.title || '').match(/#([a-z0-9_-]+)/gi) || []).map((t) => t.slice(1));
  return [...fromTag, ...fromTags, ...fromMeta, ...fromTitle]
    .map(normalizeDecisionTag)
    .filter(Boolean);
}

function isDecisionHoldTag(tag) {
  return DECISION_HOLD_TAGS.has(normalizeDecisionTag(tag));
}

function isDecisionTask(task) {
  return taskTagTokens(task).some(isDecisionHoldTag);
}

function decisionMarkerFor(task) {
  return isDecisionTask(task) ? DECISION_MARKER : '';
}

function decisionRefFor(task) {
  if (!task || typeof task !== 'object') return 'TASK';
  const ref = task.display_id || task.legacy_ref || task.id || '';
  const text = String(ref || '').trim();
  if (!text) return 'TASK';
  if (task.display_id || task.legacy_ref) return text;
  return text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8) || 'TASK';
}

function decisionShowCommand(task) {
  return `atris task show ${decisionRefFor(task)}`;
}

function summarizeDecisionTask(task) {
  const ref = decisionRefFor(task);
  const title = String((task && task.title) || '').replace(/\s+/g, ' ').trim();
  const choice = decisionChoiceText(task);
  const command = `atris task show ${ref}`;
  return {
    id: (task && task.id) || null,
    task_id: (task && task.id) || null,
    ref,
    display_id: (task && task.display_id) || ref,
    title,
    choice,
    command,
    show_command: command,
  };
}

function summarizeSkippedDecisions(tasks = []) {
  const list = (Array.isArray(tasks) ? tasks : [])
    .filter(Boolean)
    .map(summarizeDecisionTask);
  const first = list[0] || null;
  return {
    reason: DECISION_REFUSE_REASON,
    skipped_decision_count: list.length,
    skipped_decision_refs: list.map((item) => item.ref),
    skipped_decisions: list,
    decisions: list,
    choice: first ? first.choice : null,
    command: first ? first.command : null,
    show_command: first ? first.command : null,
    next_command: first ? first.command : null,
  };
}

function formatDecisionRefusalLines(tasks = []) {
  const summary = summarizeSkippedDecisions(tasks);
  const lines = [DECISION_REFUSE_REASON];
  for (const item of summary.skipped_decisions) {
    lines.push(`  ${item.ref}: ${item.title}`);
    lines.push(`  choice: ${item.choice}`);
    lines.push(`  show: ${item.command}`);
  }
  if (summary.command) {
    lines.push(`next: ${summary.command}`);
  }
  return lines;
}

module.exports = {
  DECISION_REFUSE_REASON,
  taskTagTokens,
  isDecisionHoldTag,
  isDecisionTask,
  decisionMarkerFor,
  summarizeSkippedDecisions,
  formatDecisionRefusalLines,
};
