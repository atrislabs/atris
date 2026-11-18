'use strict';

// commands/task/audit/audit.js: Task audits and the review command: rerun a task's checks and
// record what they show.
// Owner: validator. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, path, hasFlag, parseVerifyCommand, DEFAULT_OWNER, getTaskDb, flag, hasEmptyFlagValue,
  wantsJson, agentProofOnlyMode, failAgentProofOnly, printJson, refreshCareerXpAfterReview,
  compactCareerXpProjection, failTask, proofFlagValue, requireMeaningfulTaskProof, textFlag,
  positional, taskRef, writeDefaultProjection, normalizeReviewNextTaskInput,
  createNextTaskIfRequested, compactTaskFromProjection, requireTaskId, guardExplicitActor;
function bindMain(deps) {
  ({
    fs, path, hasFlag, parseVerifyCommand, DEFAULT_OWNER, getTaskDb, flag, hasEmptyFlagValue,
    wantsJson, agentProofOnlyMode, failAgentProofOnly, printJson, refreshCareerXpAfterReview,
    compactCareerXpProjection, failTask, proofFlagValue, requireMeaningfulTaskProof, textFlag,
    positional, taskRef, writeDefaultProjection, normalizeReviewNextTaskInput,
    createNextTaskIfRequested, compactTaskFromProjection, requireTaskId, guardExplicitActor,
  } = deps);
}

function taskAuditTimestamp(task) {
  const acceptedAt = Date.parse(String(task?.metadata?.accepted_at || ''));
  if (Number.isFinite(acceptedAt)) return acceptedAt;
  return Number(task?.done_at || task?.updated_at || task?.created_at || 0);
}

function taskAuditOutput(value, max = 800) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `...${text.slice(-max)}`;
}

function taskAuditReceiptPath(at) {
  const safeTime = at.replace(/[:.]/g, '-');
  return path.join('atris', 'runs', `task-audit-${safeTime}.json`);
}

function runTaskAuditVerify(task, verify) {
  const { spawnSync } = require('child_process');
  // Same measured ceiling as the landing gate: honest suites need minutes,
  // not seconds. See lib/auto-accept-certified.js verifyTimeoutMs().
  const rawTimeout = Number(process.env.ATRIS_VERIFY_TIMEOUT_MS);
  const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(rawTimeout, 60 * 60 * 1000)
    : 10 * 60 * 1000;
  const result = spawnSync('bash', ['-c', verify], {
    cwd: task.workspace_root,
    encoding: 'utf8',
    timeout,
  });
  const passed = !result.error && result.status === 0;
  return {
    passed,
    exit: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    output: taskAuditOutput(`${result.stdout || ''}${result.stderr || ''}`),
  };
}

function cmdAudit(args) {
  const limitRaw = flag(args, '--limit');
  const limit = limitRaw === null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error('atris task audit: --limit must be a positive integer');
    process.exit(2);
  }

  const revise = hasFlag(args, '--revise');
  const actor = String(flag(args, '--as') || 'task-audit');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const workspaceRoot = taskDb.workspaceRoot();
  const allRows = taskDb.listTasks(db, { workspaceRoot });
  const accepted = taskDb.withTaskDisplayRefs(
    allRows
      .filter(task => task.status === 'done' && task.metadata?.approval_status === 'accepted')
      .sort((a, b) => taskAuditTimestamp(b) - taskAuditTimestamp(a))
      .slice(0, limit),
    allRows,
  );
  const at = new Date().toISOString();
  const receiptPath = taskAuditReceiptPath(at);
  const results = accepted.map(task => {
    const verify = typeof task.metadata?.verify === 'string' ? task.metadata.verify : '';
    if (!verify.trim()) {
      return {
        task_id: task.id,
        ref: task.display_id || task.legacy_ref || taskRef(task),
        status: 'skipped-no-verify',
        verify: null,
      };
    }
    const run = runTaskAuditVerify(task, verify);
    return {
      task_id: task.id,
      ref: task.display_id || task.legacy_ref || taskRef(task),
      status: run.passed ? 'passed' : 'failed',
      verify,
      exit: run.exit,
      signal: run.signal,
      error: run.error,
      output: run.output,
    };
  });

  const failing = results.filter(row => row.status === 'failed');
  if (revise) {
    const note = `task audit re-ran the stored verify and it failed; see ${receiptPath}`;
    for (const row of failing) {
      const revised = taskDb.reviseTask(db, {
        id: row.task_id,
        actor,
        note,
        allowDone: true,
      });
      row.revised = revised.revised === true;
      row.revise_reason = revised.revised ? null : revised.reason;
    }
    if (failing.some(row => row.revised)) writeDefaultProjection(taskDb, db);
  }

  const summary = {
    sampled: results.length,
    passed: results.filter(row => row.status === 'passed').length,
    failed: failing.length,
    'skipped-no-verify': results.filter(row => row.status === 'skipped-no-verify').length,
    revised: results.filter(row => row.revised === true).length,
  };
  const receipt = {
    schema: 'atris.task_audit_receipt.v1',
    at,
    workspace_root: workspaceRoot,
    limit,
    revise,
    summary,
    failing_task_ids: failing.map(row => row.task_id),
    results,
  };
  const receiptFile = path.join(workspaceRoot, receiptPath);
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'task_audit',
      receipt_path: receiptPath,
      ...receipt,
    });
    return;
  }
  console.log(`task audit: sampled ${summary.sampled}, passed ${summary.passed}, failed ${summary.failed}, skipped-no-verify ${summary['skipped-no-verify']}`);
  console.log(`failing task ids: ${failing.length ? failing.map(row => row.ref).join(', ') : 'none'}`);
  if (revise) console.log(`revised: ${summary.revised}`);
  console.log(`receipt: ${receiptPath}`);
}

function cmdReview(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    failTask('atris task review', 'missing_id', 'id required');
  }
  const reward = flag(args, '--reward');
  const lessonFlag = flag(args, '--lesson');
  const nextTaskFlag = flag(args, '--next');
  const clearLesson = hasEmptyFlagValue(args, '--lesson');
  const clearNextTask = hasEmptyFlagValue(args, '--next');
  const lesson = clearLesson
    ? ''
    : typeof lessonFlag === 'string'
    ? lessonFlag
    : '';
  const nextTaskInput = normalizeReviewNextTaskInput(
    clearNextTask
      ? ''
      : typeof nextTaskFlag === 'string'
      ? nextTaskFlag
      : ''
  );
  const clearedFields = [];
  if (clearLesson || (typeof lessonFlag === 'string' && !String(lessonFlag).trim())) clearedFields.push('lesson');
  if (clearNextTask || (typeof nextTaskFlag === 'string' && !String(nextTaskFlag).trim())) clearedFields.push('next_task');
  const proof = proofFlagValue(args);
  const verify = textFlag(args, ['--verify']);
  guardExplicitActor('atris task review', flag(args, '--as'));
  const actor = flag(args, '--as') || DEFAULT_OWNER;
  const rewardValue = reward === true || reward === null ? 0 : reward;
  if (agentProofOnlyMode() && Number(rewardValue) > 0) {
    failAgentProofOnly(
      'atris task review',
      'Agent proof-only mode allows verifier notes with `--reward 0` only. Positive reward and acceptance stay human-gated.',
    );
  }
  if (Number(rewardValue) > 0 || proof) {
    requireMeaningfulTaskProof('atris task review', proof);
  }
  if (verify) {
    const parsedVerify = parseVerifyCommand(verify);
    if (!parsedVerify.ok) {
      failTask(
        'atris task review',
        parsedVerify.reason || 'invalid_verify_command',
        'Verify command must be a safe simple command accepted by strict auto-accept.',
      );
    }
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task review');
  const currentTask = taskDb.getTask(db, taskId);
  const result = taskDb.reviewTask(db, {
    id: taskId,
    actor: String(actor),
    reward: rewardValue,
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: nextTaskInput.nextTask,
    proof,
    verify,
    careerXpEligible: false,
    clearedFields,
  });
  if (!result.reviewed) {
    if (result.reason === 'judge_equals_worker') {
      console.error(`review failed: judge_equals_worker: ${result.builder} built this task and cannot judge it. Hand off: atris task review ${id} --reward 1 --as <another member>`);
    } else {
      console.error(`review failed: ${result.reason}`);
    }
    process.exit(1);
  }
  const nextCreated = createNextTaskIfRequested(taskDb, db, args, currentTask, result.episode.next_task_suggestion);
  const xpProjection = refreshCareerXpAfterReview(result);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'reviewed',
      task_id: taskId,
      version: result.event.version,
      reward: result.episode.reward.value,
      episode: result.episode,
      xp_projection: compactCareerXpProjection(xpProjection),
      next_task_id: nextCreated ? nextCreated.id : null,
      ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
      next_task: nextCreated ? compactTaskFromProjection(projection, nextCreated.id) : null,
    });
    return;
  }
  console.log(`reviewed ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version} reward=${result.episode.reward.value}`);
  if (result.episode.next_task_suggestion) console.log(`next: ${result.episode.next_task_suggestion}`);
  if (nextCreated) console.log(`created next ${taskRef(compactTaskFromProjection(projection, nextCreated.id))}`);
}

module.exports = {
  bindMain, taskAuditTimestamp, taskAuditOutput, taskAuditReceiptPath, runTaskAuditVerify, cmdAudit,
  cmdReview,
};
