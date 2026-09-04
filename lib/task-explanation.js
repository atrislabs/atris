'use strict';

// One plain-language explanation for every task, on every surface.
//
// Three questions a person can answer without reading metadata: what changes,
// why it matters, what done looks like. Callers may write these fields
// explicitly; everything else is derived from what the task already carries
// (title, goal, verifier, parent). Nothing here invents a claim: when a task
// never recorded a reason, the surface says so instead of guessing one.
//
// This is the first layer only. Title, metadata, requirements, events, proof,
// verify commands, status, and approval gating are untouched and stay
// inspectable underneath.

const EXPLANATION_FIELDS = ['what_changes', 'why_it_matters', 'done_looks_like'];

const EXPLANATION_LABELS = {
  what_changes: 'What changes',
  why_it_matters: 'Why it matters',
  done_looks_like: 'Done looks like',
};

const NO_REASON_RECORDED = 'No reason recorded yet.';
const NO_TITLE_RECORDED = 'Not written down yet.';

const PLAIN_REPLACEMENTS = [
  [/\bidempotent\b/gi, 'safe to repeat'],
  [/\bdeterministic\b/gi, 'predictable'],
  [/\bsubstrate\b/gi, 'base'],
  [/\borchestration\b/gi, 'coordination'],
  [/\binvariant\b/gi, 'rule'],
  [/\bcanonical\b/gi, 'main'],
  [/\bmateriali[sz]e\b/gi, 'create'],
  [/\bheuristic\b/gi, 'rule of thumb'],
  [/\bprojection\b/gi, 'shared view'],
  [/\bschema\b/gi, 'data format'],
  [/\b(?:CLI|API)\b/g, match => match === 'CLI' ? 'command tool' : 'connection'],
];

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function endSentence(value) {
  const text = cleanText(value);
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// The original value always remains in title/metadata/events. This copy is
// only the simple face, so identifiers and common internal terms are expanded
// here without weakening or rewriting the durable task record.
function plainText(value) {
  let text = cleanText(value)
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/--([a-z][a-z-]*)/g, (_match, flag) => flag.replace(/-/g, ' '))
    .replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi, match => match.replace(/_/g, ' '))
    .replace(/\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g, match => match.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
    .replace(/\b[A-Z]{2,5}-\d+\b/g, '')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{20,}\b/g, '')
    .replace(/(?:^|\s)(?:[\w.-]+\/)+[\w.-]+(?=\s|$|[.,;:!?])/g, ' the named file');
  for (const [pattern, replacement] of PLAIN_REPLACEMENTS) text = text.replace(pattern, replacement);
  return cleanText(text).replace(/\s+([,.;:!?])/g, '$1');
}

// Explicit fields arrive either nested (metadata.explanation, written at
// creation) or flat (metadata.what_changes, written by a caller flag). A
// stored field only counts as explicit when its recorded source says so, so a
// derived default persisted at creation never masquerades as an author's words
// and never goes stale after a retitle.
function explicitExplanationFields(metadata) {
  const out = {};
  if (!metadata || typeof metadata !== 'object') return out;
  const nested = metadata.explanation && typeof metadata.explanation === 'object' ? metadata.explanation : {};
  const nestedSources = nested.sources && typeof nested.sources === 'object' ? nested.sources : null;
  for (const field of EXPLANATION_FIELDS) {
    const authored = !nestedSources || nestedSources[field] === 'explicit';
    const value = (authored ? cleanText(nested[field]) : '') || cleanText(metadata[field]);
    if (value) out[field] = value;
  }
  return out;
}

function explanationGoalText(task) {
  const metadata = task && task.metadata || {};
  return cleanText(metadata.task_goal || metadata.goal_objective || (task && task.objective) || metadata.objective);
}

function derivedWhatChanges(task) {
  const title = plainText(task && task.title);
  return title ? endSentence(title) : NO_TITLE_RECORDED;
}

function derivedWhyItMatters(task) {
  const goal = plainText(explanationGoalText(task));
  if (goal) return endSentence(goal);
  const parent = plainText(task && task.lineage && task.lineage.parent_title);
  if (parent) return endSentence(`This helps finish the larger work: ${parent}`);
  return 'The task does not say why this matters yet.';
}

function derivedDoneLooksLike(task) {
  const metadata = task && task.metadata || {};
  const review = task && task.review || {};
  const result = plainText(
    task && task.result
    || metadata.result
    || review.result && review.result.changed
    || review.landing && review.landing.happened
  );
  if (result) return endSentence(result);
  const exit = plainText(metadata.exit_condition);
  if (exit) return endSentence(exit);
  const verify = cleanText(metadata.verify);
  if (verify) return 'The required check passes, the proof is attached, and review clears the work.';
  return 'The owner shows proof the work is real and it clears review.';
}

// Task in, plain explanation out. Works on a raw task row, a projection task,
// or a bare { title, tag, metadata } shape, so every surface reads the same
// three sentences.
function taskExplanation(task) {
  const explicit = explicitExplanationFields(task && task.metadata);
  const derived = {
    what_changes: derivedWhatChanges(task),
    why_it_matters: derivedWhyItMatters(task),
    done_looks_like: derivedDoneLooksLike(task),
  };
  const explanation = { sources: {} };
  for (const field of EXPLANATION_FIELDS) {
    explanation[field] = endSentence(plainText(explicit[field])) || derived[field];
    explanation.sources[field] = explicit[field] ? 'explicit' : 'derived';
  }
  explanation.authored = EXPLANATION_FIELDS.every(field => explanation.sources[field] === 'explicit');
  explanation.reason_recorded = Boolean(explicit.why_it_matters || explanationGoalText(task));
  return explanation;
}

// Pull caller-supplied explanation fields off an options bag or an API body.
// Only the exact field names count, so ordinary metadata keys can never be
// mistaken for an author's sentence.
function explanationFieldsFromInput(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const nested = input.explanation && typeof input.explanation === 'object' ? input.explanation : {};
  for (const field of EXPLANATION_FIELDS) {
    const camel = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    for (const key of [field, camel]) {
      const value = cleanText(nested[key] !== undefined ? nested[key] : input[key]);
      if (value) { out[field] = value; break; }
    }
  }
  return out;
}

// Dense rows (list, day, desk, TODO) already print the title on the line
// above. Pass that title and a derived what_changes, which is the title, drops
// out instead of echoing. An authored what_changes always survives, because it
// says something the title does not.
function explanationFieldList(explanation, { title = null } = {}) {
  if (title == null) return EXPLANATION_FIELDS;
  const echo = endSentence(title);
  return EXPLANATION_FIELDS.filter(field => !(field === 'what_changes' && explanation.what_changes === echo));
}

function explanationLines(explanation, { indent = '', title = null } = {}) {
  return explanationFieldList(explanation, { title })
    .map(field => `${indent}${EXPLANATION_LABELS[field]}: ${explanation[field]}`);
}

function explanationMarkdownLines(explanation, { indent = '  ', title = null } = {}) {
  return explanationFieldList(explanation, { title })
    .map(field => `${indent}**${EXPLANATION_LABELS[field]}:** ${explanation[field]}`);
}

// The approval half of the first layer: approve the work, or ask for a change.
// The caller passes the answer from the existing certification gate; this
// helper only labels it. It can never widen what acceptance allows.
function taskApprovalControls({
  question = null,
  approveLabel = 'Approve this work',
  acceptEnabled = false,
  acceptCommand = null,
  requestChangeEnabled = false,
  requestChangeCommand = null,
  blockedReason = null,
  waitingOn = null,
} = {}) {
  const approveEnabled = Boolean(acceptEnabled && acceptCommand);
  return {
    question: question || (approveEnabled || requestChangeEnabled
      ? 'Approve this work, or ask for a change?'
      : 'Nothing to approve yet.'),
    approve: {
      label: approveLabel,
      enabled: approveEnabled,
      command: approveEnabled ? acceptCommand : null,
      human_only: true,
      blocked_reason: approveEnabled ? null : (blockedReason || null),
    },
    request_change: {
      label: 'Ask for a change',
      enabled: Boolean(requestChangeEnabled && requestChangeCommand),
      command: requestChangeEnabled ? requestChangeCommand : null,
    },
    waiting_on: waitingOn || null,
  };
}

function approvalLines(approval, { indent = '' } = {}) {
  const lines = [`${indent}${approval.question}`];
  if (approval.approve.enabled) lines.push(`${indent}Approve: ${approval.approve.command}`);
  else if (approval.approve.blocked_reason) lines.push(`${indent}Cannot approve yet: ${approval.approve.blocked_reason}`);
  if (approval.request_change.enabled) lines.push(`${indent}Ask for a change: ${approval.request_change.command}`);
  return lines;
}

module.exports = {
  EXPLANATION_FIELDS,
  EXPLANATION_LABELS,
  NO_REASON_RECORDED,
  plainText,
  taskExplanation,
  explanationFieldsFromInput,
  explanationLines,
  explanationMarkdownLines,
  taskApprovalControls,
  approvalLines,
};
