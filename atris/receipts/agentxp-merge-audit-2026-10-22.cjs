'use strict';

// Read-only diagnosis. Current metadata cannot authorize historical XP.
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { careerXpRoot } = require('../../lib/career-xp-root');
const { independentReviewActors } = require('../../lib/review-integrity');
const root = careerXpRoot(process.cwd());
const prefix = path.join(path.dirname(root), '.agent-worktrees', path.basename(root)) + path.sep;
const weekStart = Date.parse('2026-10-16T00:00:00Z');
const db = new DatabaseSync(process.env.ATRIS_TASKS_DB || path.join(os.homedir(), '.atris/tasks.db'), { readOnly: true });
let completions;
let reviews;
let evidence;
try {
  completions = db.prepare(`SELECT e.task_id,e.event_id,e.actor,e.payload,e.created_at,
    t.workspace_root,t.status,t.title,t.claimed_by,t.metadata FROM task_events e
    JOIN tasks t ON t.id=e.task_id WHERE e.event_type='completed' AND e.created_at>=?
    ORDER BY e.created_at,e.event_id`).all(weekStart);
  reviews = db.prepare(`SELECT task_id,event_id,payload,created_at FROM task_events
    WHERE event_type='reviewed' ORDER BY created_at,event_id`).all();
  evidence = db.prepare(`SELECT task_id,event_type,actor,payload FROM task_events
    WHERE event_type IN ('reviewed','proof_ready')`).all();
} finally { db.close(); }
const positive = new Map();
for (const row of reviews) {
  const payload = JSON.parse(row.payload || '{}');
  if (Number(payload.reward) > 0) positive.set(row.task_id, row.event_id);
}
const mergeRows = completions.filter(row => /^merged(?:_|$)/.test(JSON.parse(row.payload || '{}').action || ''));
const scoped = mergeRows.filter(row => row.workspace_root === root || row.workspace_root.startsWith(prefix));
const candidates = scoped.map(row => {
  const metadata = JSON.parse(row.metadata || '{}');
  const events = evidence.filter(event => event.task_id === row.task_id)
    .map(event => ({ ...event, payload: JSON.parse(event.payload || '{}') }));
  return {
    event_id: row.event_id, task_id: row.task_id, title: row.title,
    completed_at: new Date(row.created_at).toISOString(),
    action: JSON.parse(row.payload).action, current_status: row.status,
    positive_review_event: positive.get(row.task_id) || null,
    current_independent_review_actors: [...independentReviewActors({ ...row, metadata, events })],
    current_certified_verified_by: metadata.certified_verified_by || null,
    current_independent_review_by: metadata.independent_review_by || null,
    current_machine_verified: metadata.machine_verified === true,
    current_agent_certified: metadata.agent_certified === true,
    current_proof_present: Boolean(String(metadata.latest_agent_proof || '').trim()),
  };
});
console.log(JSON.stringify({
  scope: 'Read-only diagnosis. Directory naming selects candidates only. Current metadata is not acceptance-time evidence and cannot authorize XP.',
  week_start: new Date(weekStart).toISOString(), all_workspace_merge_completions: mergeRows.length,
  cli_merge_completions: candidates.length,
  cli_without_positive_review: candidates.filter(row => !row.positive_review_event).length,
  cli_without_positive_review_with_current_independent_actor: candidates.filter(row => !row.positive_review_event && row.current_independent_review_actors.length).length,
  candidates,
}, null, 2));
