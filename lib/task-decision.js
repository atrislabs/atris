'use strict';

// Decision rows are human judgment calls, not agent work. Detect them from
// tags already in the data (primary tag, tags[], metadata.tags). The live
// marker is needs-human (CLI-879); decision is the same hold under a clearer
// name. Autonomous pickers must refuse these; list renderers must show them.

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
  const fromTitle = (String(task.title || '').match(/#([a-z0-9-]+)/gi) || []).map((t) => t.slice(1));
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

module.exports = {
  DECISION_REFUSE_REASON,
  taskTagTokens,
  isDecisionHoldTag,
  isDecisionTask,
  decisionMarkerFor,
};
