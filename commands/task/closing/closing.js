'use strict';

// commands/task/closing/closing.js: Closing and cleaning up tasks: done, finish, archive, reopen,
// clear-done, pruning test junk, reaping blockers and relabeling archived tasks.
// Owner: launcher. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read README.md
// first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, path, hasFlag, DEFAULT_OWNER, getTaskDb, flag, wantsJson, agentProofOnlyMode, workerEnvMarker,
  failAgentProofOnly, printJson, refreshCareerXpAfterReview, failTask, proofFlagValue,
  requireMeaningfulTaskProof, textFlag, landingFlags, warnIfLandingNeedsDayOnePm,
  requireExplicitLandingDayOnePm, positional, taskRef, writeDefaultProjection,
  createNextTaskIfRequested, compactTaskFromProjection, requireTaskId;
function bindMain(deps) {
  ({
    fs, path, hasFlag, DEFAULT_OWNER, getTaskDb, flag, wantsJson, agentProofOnlyMode,
    workerEnvMarker, failAgentProofOnly, printJson, refreshCareerXpAfterReview, failTask,
    proofFlagValue, requireMeaningfulTaskProof, textFlag, landingFlags, warnIfLandingNeedsDayOnePm,
    requireExplicitLandingDayOnePm, positional, taskRef, writeDefaultProjection,
    createNextTaskIfRequested, compactTaskFromProjection, requireTaskId,
  } = deps);
}

function cmdDone(args) {
  const pos = positional(args, { booleanFlags: ['--failed'] });
  const id = pos[0];
  if (!id) {
    failTask('atris task done', 'missing_id', 'id required');
  }
  const failed = hasFlag(args, '--failed');
  const proof = proofFlagValue(args);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task done');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const beforeTask = taskDb.getTask(db, taskId);
  const hasReview = hasFlag(args, '--review') || flag(args, '--lesson') || flag(args, '--next') || flag(args, '--proof') || flag(args, '--reward');
  if (agentProofOnlyMode() && !failed) {
    failAgentProofOnly(
      'atris task done',
      'Agent proof-only mode cannot mark tasks done. Use `atris task ready <id> --proof "..." --result "<day-one PM sentence>"` or `atris task review <id> --reward 0 --proof "..."`.',
    );
  }
  const canComplete = beforeTask && (beforeTask.status === 'open' || beforeTask.status === 'claimed');
  if (canComplete) {
    if (!failed || hasReview) requireMeaningfulTaskProof('atris task done', proof);
    else if (proof) requireMeaningfulTaskProof('atris task done', proof);
  }
  const result = taskDb.doneTask(db, {
    id: taskId,
    status: failed ? 'failed' : 'done',
    actor,
    action: failed ? 'failed' : 'done',
    proof,
  });
  if (result.updated) {
    const review = hasReview ? taskDb.reviewTask(db, {
      id: taskId,
      actor,
      reward: flag(args, '--reward') || (failed ? 0 : 1),
      lesson: typeof flag(args, '--lesson') === 'string' ? flag(args, '--lesson') : '',
      nextTask: typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '',
      proof,
      careerXpEligible: false,
    }) : null;
    const xpProjection = refreshCareerXpAfterReview(review);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: failed ? 'failed' : 'done',
        task_id: taskId,
        reviewed: Boolean(review && review.reviewed),
        reward: review && review.episode ? review.episode.reward.value : null,
        episode: review && review.episode || null,
        xp_projection: xpProjection,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
      });
      return;
    }
    const task = compactTaskFromProjection(projection, taskId);
    if (review && review.reviewed) {
      console.log(`${failed ? 'failed' : 'done'} ${taskRef(task)} reward=${review.episode.reward.value}`);
    } else {
      console.log(`${failed ? 'failed' : 'done'} ${taskRef(task)}`);
    }
  } else {
    const detail = `done failed: ${taskId} not in open|claimed`;
    if (wantsJson(args)) {
      printJson({
        ok: false,
        command: 'atris task done',
        reason: 'not_open_or_claimed',
        task_id: taskId,
        detail,
      });
      process.exit(1);
    }
    console.error(detail);
    process.exit(1);
  }
}

function cmdFinish(args) {
  const pos = positional(args, { booleanFlags: ['--failed'] });
  const id = pos[0];
  if (!id) {
    failTask('atris task finish', 'missing_id', 'id required');
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task finish');
  const currentTask = taskDb.getTask(db, taskId);
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const proof = proofFlagValue(args);
  const landing = landingFlags(args);
  const failed = hasFlag(args, '--failed');
  const hasReview = hasFlag(args, '--review') || flag(args, '--lesson') || flag(args, '--next') || flag(args, '--proof') || flag(args, '--reward');
  if (agentProofOnlyMode() && !failed) {
    failAgentProofOnly(
      'atris task finish',
      'Agent proof-only mode cannot finish tasks. Use `atris task ready <id> --proof "..." --result "<day-one PM sentence>"` or `atris task review <id> --reward 0 --proof "..."`.',
    );
  }
  const canComplete = currentTask && (currentTask.status === 'open' || currentTask.status === 'claimed');
  if (canComplete) {
    if (!failed || hasReview) requireMeaningfulTaskProof('atris task finish', proof);
    else if (proof) requireMeaningfulTaskProof('atris task finish', proof);
    if (!failed && hasReview) requireExplicitLandingDayOnePm('atris task finish', landing, currentTask.title);
  }
  const done = taskDb.doneTask(db, {
    id: taskId,
    status: failed ? 'failed' : 'done',
    actor,
    action: failed ? 'failed' : 'finished',
    proof,
  });
  if (!done.updated) {
    const detail = `finish failed: ${taskId} not in open|claimed`;
    if (wantsJson(args)) {
      printJson({
        ok: false,
        command: 'atris task finish',
        reason: 'not_open_or_claimed',
        task_id: taskId,
        detail,
      });
      process.exit(1);
    }
    console.error(detail);
    process.exit(1);
  }
  if (hasReview) {
    const landingAdvisory = !failed ? warnIfLandingNeedsDayOnePm(landing, currentTask && currentTask.title) : null;
    const result = taskDb.reviewTask(db, {
      id: taskId,
      actor,
      reward: flag(args, '--reward') || 1,
      lesson: typeof flag(args, '--lesson') === 'string' ? flag(args, '--lesson') : '',
      nextTask: typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '',
      proof,
      careerXpEligible: false,
      landing,
    });
    const nextCreated = createNextTaskIfRequested(taskDb, db, args, currentTask, result.episode.next_task_suggestion);
    const xpProjection = refreshCareerXpAfterReview(result);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'finished',
        task_id: taskId,
        reviewed: true,
        reward: result.episode.reward.value,
        episode: result.episode,
        xp_projection: xpProjection,
        landing_advisory: landingAdvisory,
        next_task_id: nextCreated ? nextCreated.id : null,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
        next_task: nextCreated ? compactTaskFromProjection(projection, nextCreated.id) : null,
      });
      return;
    }
    console.log(`finished ${taskRef(compactTaskFromProjection(projection, taskId))} reward=${result.episode.reward.value}`);
    if (result.episode.next_task_suggestion) console.log(`next: ${result.episode.next_task_suggestion}`);
    if (nextCreated) console.log(`created next ${taskRef(compactTaskFromProjection(projection, nextCreated.id))}`);
    return;
  }
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'finished',
      task_id: taskId,
      reviewed: false,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(`finished ${taskRef(compactTaskFromProjection(projection, taskId))}`);
}

// Distinct from `done --failed`: a bulk sweep of duplicates/off-roadmap work
// closes the task without ever claiming it did or didn't succeed. Writing
// 'failed' here would corrupt the reward signal readers rely on (see
// atris/reports/failed-tasks-analysis-2026-07-03.md, cluster 2, OBL-1622).
function cmdArchive(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task archive', 'missing_id', 'id required');
  }
  const notNeeded = hasFlag(args, '--not-needed');
  // The note clears a drop off the member's record, and --as is only a name. A
  // worker that dropped the job could name someone else and clear its own miss,
  // so inside an agent session or a dispatched worker it is refused outright.
  const workerMarker = notNeeded ? workerEnvMarker() : '';
  if (workerMarker) {
    failTask(
      'atris task archive',
      'not_needed_needs_a_person',
      `atris task archive --not-needed is for a person to confirm, and this shell looks like an agent session or a dispatched worker (${workerMarker} is set). Run it from a plain terminal.`,
    );
  }
  const reason = textFlag(args, ['--reason']);
  if (!reason) {
    failTask(
      'atris task archive',
      'missing_reason',
      notNeeded
        ? 'atris task archive --not-needed requires --reason "<why this job did not need doing>"'
        : 'atris task archive requires --reason "<why this is being swept, not failed>"',
    );
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task archive');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  // Explicit opt-in for sanctioned failed→archived cleanup (e.g. duplicate
  // loop-tick orphans fail-closed before 'archived' existed). Without the
  // flag, failed rows stay failed; done rows are never archivable.
  const fromFailed = hasFlag(args, '--from-failed');
  // --not-needed also writes who said so, which clears a dropped job off the
  // member's record when it is someone other than the member. A job that is
  // already archived only gets that note.
  const result = notNeeded
    ? taskDb.archiveNotNeeded(db, { id: taskId, actor, reason, fromFailed })
    : taskDb.archiveTask(db, { id: taskId, actor, reason, fromFailed });
  if (result.archived || result.recorded) {
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'archived',
        task_id: taskId,
        reason,
        ...(notNeeded ? { not_needed: true, not_needed_by: actor, already_archived: !result.archived } : {}),
        archived_from: result.row && result.row.metadata && result.row.metadata.archived_from || null,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
      });
      return;
    }
    const fromNote = result.row && result.row.metadata && result.row.metadata.archived_from
      ? ` (was ${result.row.metadata.archived_from})`
      : '';
    const ref = taskRef(compactTaskFromProjection(projection, taskId));
    if (notNeeded && !result.archived) {
      console.log(`${ref} was already archived; recorded as not needed by ${actor}: ${reason}`);
    } else {
      console.log(`archived ${ref}${fromNote}${notNeeded ? ' as not needed' : ''}: ${reason}`);
    }
  } else {
    const hint = result.reason === 'already_failed'
      ? ' (use --from-failed to archive a fail-closed duplicate/off-roadmap row)'
      : '';
    const detail = `archive failed: ${taskId} ${result.reason}${hint}`;
    if (wantsJson(args)) {
      printJson({ ok: false, command: 'atris task archive', reason: result.reason, task_id: taskId, detail });
      process.exit(1);
    }
    console.error(detail);
    process.exit(1);
  }
}

// Send a done, failed, or archived task back to open so it can be claimed
// again. Review sign-offs are cleared; the old status and reason are kept.
function cmdReopen(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task reopen', 'missing_id', 'task id required');
  const reason = textFlag(args, ['--reason']) || 'reopened';
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task reopen');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const result = taskDb.reopenTask(db, { id: taskId, actor, reason, fromReview: true });
  if (!result.reopened) {
    const detail = `reopen failed: ${taskId} ${result.reason}`;
    if (wantsJson(args)) {
      printJson({ ok: false, command: 'atris task reopen', reason: result.reason, task_id: taskId, detail });
      process.exit(1);
    }
    console.error(detail);
    process.exit(1);
  }
  const reopenedFrom = result.row && result.row.metadata && result.row.metadata.reopened_from || null;
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const task = compactTaskFromProjection(projection, taskId);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'reopened',
      task_id: taskId,
      reopened_from: reopenedFrom,
      reason,
      projection_path: outPath,
      task,
    });
    return;
  }
  console.log(`reopened ${taskRef(task)}${reopenedFrom ? ` (was ${reopenedFrom})` : ''}: ${reason}`);
}

function taskCompletionTime(row) {
  const doneAt = Number(row && row.done_at);
  if (Number.isFinite(doneAt) && doneAt > 0) return doneAt;
  const acceptedAt = Date.parse(String(row && row.metadata && row.metadata.accepted_at || ''));
  if (Number.isFinite(acceptedAt)) return acceptedAt;
  return Number(row && (row.updated_at || row.created_at) || 0);
}

function cmdClearDone(args) {
  const beforeRaw = flag(args, '--before');
  let beforeDays = null;
  if (beforeRaw !== null) {
    beforeDays = Number(beforeRaw);
    if (beforeRaw === true || !Number.isFinite(beforeDays) || beforeDays < 0) {
      failTask('atris task clear-done', 'invalid_before', '--before requires a non-negative number of days');
    }
  }

  const dryRun = hasFlag(args, '--dry-run');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const cutoff = beforeDays === null ? null : Date.now() - (beforeDays * 24 * 60 * 60 * 1000);
  const candidates = taskDb.listTasks(db, { workspaceRoot, status: 'done', limit: null })
    .filter(row => cutoff === null || taskCompletionTime(row) < cutoff)
    .sort((a, b) => taskCompletionTime(a) - taskCompletionTime(b) || String(a.id).localeCompare(String(b.id)));
  const sample = candidates.slice(0, 5).map(row => ({
    task_id: row.id,
    title: row.title,
    completed_at: new Date(taskCompletionTime(row)).toISOString(),
  }));

  if (dryRun) {
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'clear-done',
        dry_run: true,
        before_days: beforeDays,
        count: candidates.length,
        sample,
      });
      return;
    }
    console.log(`clear-done dry-run: ${candidates.length} completed task(s) would be archived.`);
    for (const row of sample) console.log(`  - ${row.title}`);
    if (candidates.length > sample.length) console.log(`  ...and ${candidates.length - sample.length} more`);
    return;
  }

  const reason = 'cleared by clear-done sweep';
  for (const row of candidates) {
    const result = taskDb.archiveTask(db, {
      id: row.id,
      actor: String(flag(args, '--as') || DEFAULT_OWNER),
      reason,
      fromDone: true,
    });
    if (!result.archived) {
      failTask('atris task clear-done', result.reason, `clear-done failed: ${row.id} ${result.reason}`, 1);
    }
  }
  const { outPath } = writeDefaultProjection(taskDb, db);

  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'clear-done',
      dry_run: false,
      before_days: beforeDays,
      count: candidates.length,
      reason,
      sample,
      projection_path: outPath,
    });
    return;
  }
  console.log(`cleared ${candidates.length} completed task(s).`);
}

function formatBytes(bytes) {
  const mb = Number(bytes || 0) / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(Number(bytes || 0) / 1024)} KB`;
}

// Test runs that forgot ATRIS_TASKS_DB left rows in the shared database
// under temp folders. Default is a read-only count; --yes backs up, then
// removes those rows and their history. Real project rows are never touched.
function cmdPruneTestJunk(args) {
  const taskDb = getTaskDb();
  const prune = require('../../../lib/task-prune');
  const dbPath = taskDb.getDbPath();
  const apply = hasFlag(args, '--yes') && !hasFlag(args, '--dry-run');
  const vacuum = apply && hasFlag(args, '--vacuum');
  if (!apply) {
    const plan = prune.dryRun(dbPath);
    const { rows, ...summary } = plan;
    if (wantsJson(args)) {
      printJson({ ok: true, action: 'prune-test-junk', dry_run: true, ...summary });
      return;
    }
    if (plan.missing) {
      console.log(`no task database at ${dbPath}. nothing to prune.`);
      return;
    }
    const r = plan.remove;
    console.log('prune-test-junk dry run: nothing was changed.');
    console.log(`database: ${dbPath} (${formatBytes(plan.db_bytes)}, ${plan.total_tasks} tasks)`);
    console.log(`would remove ${r.tasks} test task(s) from temp folders, ${r.history_rows} history row(s), `
      + `${r.stray_history_rows} stray history row(s), ${r.part_uses} part use row(s).`);
    for (const g of plan.groups) {
      console.log(`  ${g.prefix.padEnd(22)} ${String(g.tasks).padStart(7)} tasks  ${String(g.history_rows + g.stray_history_rows).padStart(8)} history rows`);
    }
    const k = plan.kept;
    console.log(`kept: ${k.folder_exists} temp task(s) whose folder still exists, ${k.recent} active in the last ${plan.grace_hours} hour(s), `
      + `${k.held} with history from a real project, ${k.stray_held + k.stray_recent} leftover history set(s) that are recent or name a real project.`);
    if (r.tasks || r.stray_history_rows) {
      console.log('run with --yes to remove them. a backup copy is written next to the database first.');
    }
    return;
  }

  if (vacuum && !wantsJson(args)) {
    console.log('note: --vacuum rewrites the whole file and needs every other atris process idle; it waits a few seconds, then gives up.');
  }
  let result;
  try {
    result = prune.applyPrune(dbPath, { vacuum });
  } catch (err) {
    failTask('atris task prune-test-junk', 'prune_failed', `prune-test-junk stopped: ${err && err.message || err}`, 1);
  }
  if (wantsJson(args)) {
    printJson({ ok: true, action: 'prune-test-junk', dry_run: false, ...result });
    return;
  }
  if (result.missing) {
    console.log(`no task database at ${dbPath}. nothing to prune.`);
    return;
  }
  const r = result.removed;
  console.log(`backup: ${result.backup_path} (${result.backup_tasks} tasks)`);
  console.log(`removed ${r.tasks} test task(s), ${r.history_rows} history row(s), `
    + `${r.stray_history_rows} stray history row(s), ${r.part_uses} part use row(s).`);
  const sk = result.skipped;
  if (sk.held || sk.changed_since_backup || sk.recent || sk.folder_exists) {
    console.log(`left ${sk.changed_since_backup} that changed after the backup, ${sk.recent} that became active, `
      + `${sk.folder_exists} whose folder came back, and ${sk.held} with real-project history.`);
  }
  console.log(`database now has ${result.total_tasks} tasks, ${formatBytes(result.bytes_after)} on disk`
    + (result.vacuumed ? ' after vacuum.' : '. run again with --yes --vacuum to shrink the file.'));
}

function cmdReapMissionBlockers(args) {
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const missions = require('../../mission').listMissions(workspaceRoot);
  const result = taskDb.reapMissionBlockerTasks(db, { workspaceRoot, missions, actor });
  const { outPath } = writeDefaultProjection(taskDb, db);
  const taskById = new Map(taskDb.withTaskDisplayRefs(taskDb.listTasks(db, { workspaceRoot, limit: null }))
    .map(task => [task.id, task]));
  const closed = result.closed.map(row => ({
    ...row,
    task_ref: taskRef(taskById.get(row.task_id)),
  }));
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'reaped_mission_blockers',
      closed_count: closed.length,
      closed,
      projection_path: outPath,
    });
    return;
  }
  console.log(`closed ${closed.length} mission blocker task(s).`);
  for (const row of closed) {
    console.log(`closed ${row.task_ref} because its mission is ${row.mission_status}.`);
  }
}

// One-time migration for OBL-1622: the 2026-06-10 "first-principles backlog
// reset" archived ~125 certified, proof-backed tasks by writing status
// 'failed' (no distinct archived status existed yet). This relabels exactly
// the rows that carry that reset's metadata marker, using the same
// UPDATE+appendTaskEvent write path as every other status transition in
// lib/task-db.js, never a raw projection-JSON edit.
function cmdRelabelArchived(args) {
  const apply = hasFlag(args, '--apply');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const result = taskDb.relabelArchivedTasks(db, { workspaceRoot, apply, actor });
  if (apply && result.count > 0) {
    appendRelabelArchivedJournalReceipt(workspaceRoot, { actor, count: result.count, ids: result.ids });
  }
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: apply ? 'relabeled' : 'preview',
      dry_run: !apply,
      workspace_root: workspaceRoot,
      ...result,
    });
    return;
  }
  if (!apply) {
    console.log(`relabel-archived (dry-run): ${result.count} failed task(s) match the June 10 backlog-reset marker.`);
    for (const s of result.sample) console.log(`  - ${s.id} ${s.title}`);
    if (result.count > result.sample.length) console.log(`  ...and ${result.count - result.sample.length} more`);
    console.log('Run with --apply --as <you> to relabel these failed -> archived.');
    return;
  }
  console.log(`relabeled ${result.count} task(s) failed -> archived (June 10 backlog reset, OBL-1622).`);
}

function appendRelabelArchivedJournalReceipt(workspaceRoot, { actor, count, ids }) {
  if (!workspaceRoot || !fs.existsSync(path.join(workspaceRoot, 'atris'))) return null;
  const now = new Date();
  const logName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
  const stamp = now.toTimeString().slice(0, 5);
  const projectDir = path.join(workspaceRoot, 'atris', 'logs', logName.slice(0, 4));
  fs.mkdirSync(projectDir, { recursive: true });
  const logPath = path.join(projectDir, logName);
  const idPreview = ids.slice(0, 10).join(', ') + (ids.length > 10 ? `, ...(+${ids.length - 10} more)` : '');
  fs.appendFileSync(logPath, [
    `## ${stamp} · Task relabel: failed -> archived (OBL-1622)`,
    `- count: ${count}`,
    `- reason: June 10 backlog-reset rows mislabeled failed; relabeled to archived`,
    `- actor: ${actor}`,
    `- ids: ${idPreview}`,
    '',
  ].join('\n'), 'utf8');
  return logPath;
}

module.exports = {
  bindMain, cmdDone, cmdFinish, cmdArchive, cmdReopen, taskCompletionTime, cmdClearDone,
  formatBytes, cmdPruneTestJunk, cmdReapMissionBlockers, cmdRelabelArchived,
  appendRelabelArchivedJournalReceipt,
};
