'use strict';

// A bounded, read-only handoff of facts for the next decision. Ranking and
// execution stay with the existing picker, member and verification gates.
const fs = require('fs');
const path = require('path');
const { meaningfulWords } = require('./short-name');

function clip(value, max = 360) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function localFile(root, name) {
  try {
    const base = fs.realpathSync(root);
    const file = fs.realpathSync(path.resolve(base, name));
    const rel = path.relative(base, file);
    if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) return null;
    return fs.statSync(file).isFile() ? file : null;
  } catch { return null; }
}

function readSource(root, name, maxBytes) {
  const file = localFile(root, name);
  if (!file) return { path: name, text: '', unavailable: true };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { path: name, text: buffer.subarray(0, count).toString('utf8'), truncated: stat.size > maxBytes, modified_at: stat.mtime.toISOString() };
  } catch { return { path: name, text: '', unavailable: true }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Keep the offline projection fallback, but a known row's current database
// status always wins. Include finished rows so their outcomes are not lost.
function reconcileTaskRows(rows, projected, lookup = () => null) {
  const known = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set();
  const merged = [];
  for (const row of projected) {
    if (!row || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    const current = known.get(row.id) || lookup(row.id);
    if (current !== false) merged.push(current || row);
  }
  return [...merged, ...rows.filter((row) => !seen.has(row.id))];
}

function matchingParts(root, map, query) {
  const wanted = new Set(meaningfulWords(query, 100));
  const found = new Map();
  map.text.split(/\r?\n/).forEach((line, index) => {
    if (!line.startsWith('|')) return;
    const score = meaningfulWords(line, 100).filter((word) => wanted.has(word)).length;
    if (!score) return;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const name = match[1].replace(/:\d+$/, '');
      if (path.isAbsolute(name) || !localFile(root, name) || found.has(name)) continue;
      found.set(name, { path: name, source: `${map.path}:${index + 1}`, description: clip(line.replace(/`/g, ''), 180), score });
    }
  });
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 5)
    .map(({ score, ...part }) => part);
}

function recentOutcomes(tasks, selected) {
  return tasks.filter((task) => ['done', 'failed', 'review'].includes(task.status))
    .sort((a, b) => Number(b.id === selected?.id) - Number(a.id === selected?.id)
      || Number(b.updated_at || 0) - Number(a.updated_at || 0))
    .slice(0, 3).map((task) => {
      const meta = task.metadata || {};
      return {
        task_id: clip(task.id, 120),
        title: clip(task.title, 160),
        status: task.status,
        result: clip(task.result || meta.result),
        lesson: clip(task.review?.lesson || meta.latest_agent_lesson),
        next: clip(task.review?.next_task || meta.latest_agent_next_task),
        proof: clip(task.review?.proof || meta.latest_agent_proof),
        validation: task.status === 'failed' ? 'failed' : task.status === 'review' ? 'review_pending'
          : meta.accepted_by && meta.accepted_at ? 'accepted' : 'reported',
      };
    });
}

function otherOwner(task, owner) {
  const assigned = typeof task.metadata?.assigned_to === 'string' ? task.metadata.assigned_to.trim() : '';
  return Boolean((task.claimed_by && task.claimed_by !== owner) || (assigned && assigned !== owner));
}

function candidateEvidence(tasks, selected, goal, owner) {
  const words = new Set(meaningfulWords(goal?.text, 100));
  const { heldForPerson } = require('./member-task-pick');
  return tasks.filter((task) => task.id !== selected?.id && ['open', 'claimed', 'review'].includes(task.status))
    .map((task) => {
      const meta = task.metadata || {};
      const why = clip(meta.why_it_matters || task.explanation?.why_it_matters, 240);
      const overlap = new Set(meaningfulWords(`${task.title} ${meta.objective || ''} ${why}`, 100).filter((word) => words.has(word))).size;
      return {
        task_id: clip(task.id, 120), title: clip(task.title, 160), status: task.status,
        owner: clip(task.claimed_by || meta.assigned_to, 80) || null,
        why: why || null,
        held: heldForPerson(task) || (otherOwner(task, owner) ? 'other_owner' : null),
        goal_word_overlap: overlap,
      };
    }).sort((a, b) => b.goal_word_overlap - a.goal_word_overlap).slice(0, 3);
}

function buildNextWorkContext({ root, tasks = [], selected = null, owner = '', taskSource = 'projection', objective = '', generatedAt = null }) {
  const scoreboard = readSource(root, '.atris/state/scoreboard.json', 16384);
  const map = readSource(root, 'atris/MAP.md', 65536);
  let goal = null;
  try {
    const value = scoreboard.truncated ? null : JSON.parse(scoreboard.text);
    if (clip(value?.goal)) goal = { text: clip(value.goal, 600), source: scoreboard.path, updated_at: typeof value.updated_at === 'string' ? clip(value.updated_at, 80) : null };
  } catch { /* Missing or unreadable knowledge stays unknown. */ }
  const meta = selected?.metadata || {};
  const rawCheck = typeof (meta.verify || meta.verifier) === 'string' ? (meta.verify || meta.verifier).trim() : '';
  // Never offer an ellipsis as an executable command.
  const check = rawCheck.length <= 600 ? rawCheck : '';
  const { taskCheck, heldForPerson } = require('./member-task-pick');
  const runnable = check && taskCheck({ metadata: { verify: check } }).runnable;
  const parts = matchingParts(root, map, [objective, selected?.title, meta.objective, goal?.text].filter(Boolean).join(' '));
  const gaps = [];
  if (!goal) gaps.push('current_goal_missing');
  if (taskSource === 'none') gaps.push('task_state_missing');
  if (scoreboard.truncated) gaps.push('goal_source_truncated');
  if (map.unavailable) gaps.push('parts_map_missing');
  else if (!parts.length) gaps.push('matching_parts_missing');
  if (map.truncated) gaps.push('parts_map_truncated');
  if (selected && !runnable) gaps.push('runnable_check_missing');
  if (rawCheck.length > 600) gaps.push('check_too_large_for_snapshot');
  if (taskSource === 'projection' || taskSource === 'mixed') gaps.push('task_snapshot_not_authoritative');
  if (generatedAt && Date.now() - Date.parse(generatedAt) > 3 * 86400000) gaps.push('task_snapshot_stale');
  const why = clip(meta.why_it_matters || selected?.explanation?.why_it_matters);
  if (selected && !why) gaps.push('reason_missing');
  let kind = selected && runnable ? 'execute' : 'discover';
  if (gaps.includes('task_snapshot_not_authoritative') || gaps.includes('task_snapshot_stale')) kind = 'discover';
  let reason = selected ? 'Inspect the relevant source and establish the missing evidence before changing it.'
    : 'No selectable job is recorded. Find one observed gap toward the current goal, with a falsifying check.';
  if (kind === 'execute') reason = why || 'Run the recorded check against the relevant source before claiming progress.';
  if (selected && !['open', 'claimed', 'review'].includes(selected.status)) {
    kind = 'discover'; reason = 'The bound task is no longer active. Inspect its recorded result before proposing another gap.';
    gaps.push(selected.status === 'done' ? 'bound_task_already_finished' : 'bound_task_not_active');
  } else if (selected && heldForPerson(selected)) { kind = 'human_decision'; reason = 'This work is held for a person by the existing task policy.'; }
  else if (selected?.status === 'review') {
    const certified = selected.review?.agent_certified || meta.agent_certified || Number(meta.agent_review_pass_count) >= 2;
    kind = certified ? 'human_decision' : selected.claimed_by === owner ? 'wait' : 'review';
    reason = certified ? 'The recorded work needs human acceptance.' : 'A different actor must check the finished diff before more work is chosen.';
  } else if (selected && otherOwner(selected, owner)) {
    kind = 'wait'; reason = 'Another owner holds this job. Do not duplicate their work.';
  }
  const context = {
    schema: 'atris.next_work_context.v1',
    workspace_root: path.resolve(root),
    captured_at: new Date().toISOString(),
    task_source: taskSource,
    goal,
    parts,
    candidates: candidateEvidence(tasks, selected, goal, owner),
    recent_outcomes: recentOutcomes(tasks, selected),
    gaps,
    next_step: { kind, reason, check: check || null },
    sources: [scoreboard, map].map(({ text, ...source }) => source),
    selection_basis: 'existing queue policy; candidate keyword overlap is a discovery hint, not measured business value',
  };
  // Keep the packet bounded even with long unicode text or unusual paths.
  while (Buffer.byteLength(JSON.stringify(context)) > 10000) {
    if (!gaps.includes('context_budget_limited')) gaps.push('context_budget_limited');
    if (context.parts.length) context.parts.pop();
    else if (context.candidates.length) context.candidates.pop();
    else if (context.recent_outcomes.length) context.recent_outcomes.pop();
    else {
      context.next_step.check = null;
      if (context.next_step.kind === 'execute') context.next_step.kind = 'discover';
      break;
    }
  }
  return context;
}

module.exports = { buildNextWorkContext, reconcileTaskRows };
