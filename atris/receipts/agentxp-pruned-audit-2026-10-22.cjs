'use strict';

// Read-only, operator-local evidence audit. This never reconstructs or awards XP.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { normalizeActor, taskBuilder } = require('../../lib/review-integrity');
const { careerXpRoot } = require('../../lib/career-xp-root');

const main = careerXpRoot(process.cwd());
const dbPath = process.env.ATRIS_TASKS_DB || path.join(os.homedir(), '.atris/tasks.db');
const listing = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
  cwd: main, encoding: 'utf8',
});
if (listing.status !== 0) throw new Error(listing.stderr || 'cannot read registered checkouts');
const roots = new Set(listing.stdout.split('\0')
  .filter(field => field.startsWith('worktree ')).map(field => field.slice(9)));
const db = new DatabaseSync(dbPath, { readOnly: true });
let rows;
try {
  rows = db.prepare(`SELECT t.status,t.workspace_root,t.title,t.claimed_by,t.metadata,
    e.event_id,e.actor,e.payload,e.created_at FROM tasks t
    JOIN task_events e ON t.id=e.task_id WHERE e.event_type='reviewed'
    ORDER BY e.created_at,e.event_id`).all();
} finally {
  db.close();
}
const receiptIds = new Set(fs.readFileSync(path.join(main, '.atris/state/career_xp_receipts.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line).receipt_id));
// This naming convention only selects candidates. It cannot authorize recovery.
const prefix = path.join(path.dirname(main), '.agent-worktrees', path.basename(main)) + path.sep;
const eligible = rows.filter(row => JSON.parse(row.payload).career_xp_eligible === true
  && row.workspace_root.startsWith(prefix));
const candidates = eligible.filter(row => !roots.has(row.workspace_root)).map(row => {
  const metadata = JSON.parse(row.metadata);
  const payload = JSON.parse(row.payload);
  const builder = taskBuilder({ ...row, metadata });
  const reviewer = normalizeActor(row.actor);
  const verified = normalizeActor(metadata.certified_verified_by);
  const actors = (metadata.agent_review_actors || []).map(normalizeActor);
  const independent = Boolean(builder && ((reviewer && reviewer !== builder)
    || (metadata.agent_certified === true && metadata.machine_verified === true
      && verified && verified !== builder
      && normalizeActor(metadata.independent_review_by) === verified && actors.includes(verified))));
  return {
    event_id: row.event_id, title: row.title, workspace_root: row.workspace_root,
    accepted_at: new Date(row.created_at).toISOString(), current_status: row.status,
    reward: payload.reward, has_proof: Boolean(String(payload.proof || '').trim()),
    independent_evidence_in_current_row: independent, builder, reviewer, verified_by: verified,
    folder_exists: fs.existsSync(row.workspace_root),
    episode_file_exists: fs.existsSync(path.join(row.workspace_root, '.atris/state/task_episodes.jsonl')),
    already_in_main_receipts: receiptIds.has(`task_review:${row.event_id}`),
    has_commit_hint: Boolean(metadata.work_commit || metadata.start_commit),
    location_metadata_keys: Object.keys(metadata).filter(key => /root|repo|workspace/i.test(key)),
  };
});
console.log(JSON.stringify({
  scope: 'Read-only candidates, not authorized recovery. Folder names do not prove repository identity; current reviewer metadata is not an immutable acceptance snapshot.',
  week_start: '2026-10-16T00:00:00Z', eligible_linked_cli_events: eligible.length,
  eligible_this_week: eligible.filter(row => row.created_at >= Date.parse('2026-10-16T00:00:00Z')).length,
  unregistered_candidates: candidates.length,
  missing_main_receipts: candidates.filter(row => !row.already_in_main_receipts).length,
  candidates,
}, null, 2));
