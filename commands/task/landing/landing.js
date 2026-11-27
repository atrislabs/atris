'use strict';

// commands/task/landing/landing.js: Landing a task: ready with proof, receipts, accept and
// accept-group, certify-verified, auto-accept and the sweep.
// Owner: orb. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read README.md
// first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, execSync, path, hasFlag, compactSuccessPayload, printCliJson, candidatePolicyGate,
  declaredCandidatePathValues, evaluateAutoAccept, isAgentCertified,
  isAutoCertifyVerifyCommandAllowed, openPullRequestRefusal, parseVerifyChain, runVerifyCommand,
  DENIED_TAGS, protectedLaneOf, evaluateAcceptVerify, nonFalsifyingIssue, checkedCodeSha,
  mainLineSha, runVerifyAtJobCode, proveTaskLanding, extractReceiptEvidence, reviewIntegrity,
  DEFAULT_OWNER, MISSION_XP_END_TO_END_REASON, getTaskDb, flag, scopedWorkspaceRoot,
  hasEmptyFlagValue, wantsJson, parseAcceptReward, validHumanActorFlag, agentProofOnlyMode,
  failAgentProofOnly, writeStdoutSync, printJson, refreshCareerXpAfterReview, failTask,
  refuseCandidatePolicyGate, requireResultSentence, requireMeaningfulTaskProof,
  requireRanNamedProofCommand, textFlag, landingFlags, readyMergeFlags, warnIfLandingNeedsDayOnePm,
  requireExplicitLandingDayOnePm, missionXpEndToEndProofIssue, positional, taskFromProjection,
  taskRef, writeDefaultProjection, normalizeReviewNextTaskInput, certifiedReviewNextAction,
  proofBoundaryBlockedEvaluation, enrichTaskProjection, taskReviewClip, taskReviewEvidenceCommands,
  taskReviewChatHandoff, taskWithReviewEvidence, taskWithAgentCertification,
  compactTaskFromProjection, clipStatusText, evidenceRiskRank, taskReviewQueue,
  certifiedPendingReviewTasks, reviewGroupKey, reviewGroupValue, cmdReviews, requireTaskId,
  guardExplicitActor, taskDetail, refreshBrainScorecardsAfterAccept, nextMissionRouteAfterAccept,
  renderAcceptLanding, publishAcceptAgentXp, buildAutomaticResultTrace, FAILED_CHECK_TRUSTED_MS,
  SWEEP_AUTO_ACCEPT_PROTECTED, refreshExistingTodoMarkdown, autoRenderTodoFromDb;
function bindMain(deps) {
  ({
    fs, execSync, path, hasFlag, compactSuccessPayload, printCliJson, candidatePolicyGate,
    declaredCandidatePathValues, evaluateAutoAccept, isAgentCertified,
    isAutoCertifyVerifyCommandAllowed, openPullRequestRefusal, parseVerifyChain, runVerifyCommand,
    DENIED_TAGS, protectedLaneOf, evaluateAcceptVerify, nonFalsifyingIssue, checkedCodeSha,
    mainLineSha, runVerifyAtJobCode, proveTaskLanding, extractReceiptEvidence, reviewIntegrity,
    DEFAULT_OWNER, MISSION_XP_END_TO_END_REASON, getTaskDb, flag, scopedWorkspaceRoot,
    hasEmptyFlagValue, wantsJson, parseAcceptReward, validHumanActorFlag, agentProofOnlyMode,
    failAgentProofOnly, writeStdoutSync, printJson, refreshCareerXpAfterReview, failTask,
    refuseCandidatePolicyGate, requireResultSentence, requireMeaningfulTaskProof,
    requireRanNamedProofCommand, textFlag, landingFlags, readyMergeFlags,
    warnIfLandingNeedsDayOnePm, requireExplicitLandingDayOnePm, missionXpEndToEndProofIssue,
    positional, taskFromProjection, taskRef, writeDefaultProjection, normalizeReviewNextTaskInput,
    certifiedReviewNextAction, proofBoundaryBlockedEvaluation, enrichTaskProjection, taskReviewClip,
    taskReviewEvidenceCommands, taskReviewChatHandoff, taskWithReviewEvidence,
    taskWithAgentCertification, compactTaskFromProjection, clipStatusText, evidenceRiskRank,
    taskReviewQueue, certifiedPendingReviewTasks, reviewGroupKey, reviewGroupValue, cmdReviews,
    requireTaskId, guardExplicitActor, taskDetail, refreshBrainScorecardsAfterAccept,
    nextMissionRouteAfterAccept, renderAcceptLanding, publishAcceptAgentXp,
    buildAutomaticResultTrace, FAILED_CHECK_TRUSTED_MS, SWEEP_AUTO_ACCEPT_PROTECTED,
    refreshExistingTodoMarkdown, autoRenderTodoFromDb,
  } = deps);
}

function stampAcceptGroupMetadata(taskDb, db, taskId, { actor, group, verified, sampleVerifiedIds }) {
  taskDb.updateTaskMetadata(db, taskId, (metadata) => {
    metadata.accept_group = group;
    metadata.accept_group_by = actor;
    metadata.accept_group_at = new Date().toISOString();
    metadata.accepted_by_sampling = !verified;
    if (!verified) metadata.sample_verified_ids = sampleVerifiedIds;
  });
}

// Accept a whole certified cluster honestly: the human spot-checks K rows (real career XP), the rest
// are accepted-by-sampling (cleared from the backlog, provenance recorded, NO career XP, never fake XP).
function cmdAcceptGroup(args) {
  const pos = positional(args);
  const spec = pos[0];
  if (!spec || !spec.includes('=')) {
    console.error('atris task accept-group: <key>=<value> required (key = tag|owner|source, e.g. tag=self-improve)');
    process.exit(2);
  }
  const eq = spec.indexOf('=');
  const key = reviewGroupKey(spec.slice(0, eq));
  const value = spec.slice(eq + 1);
  const spotCheck = Math.max(1, Math.floor(Number(flag(args, '--spot-check')) || 3));
  const confirm = hasFlag(args, '--confirm-human-accept');
  const actor = String(flag(args, '--as') || '');
  const verifiedRaw = flag(args, '--verified');

  if (confirm && agentProofOnlyMode()) {
    failAgentProofOnly('atris task accept-group', 'Only a human can accept tasks / award XP. Leave proof in Review.');
  }

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection } = writeDefaultProjection(taskDb, db);
  const group = certifiedPendingReviewTasks(projection).filter(task => reviewGroupValue(task, key) === value);
  if (!group.length) {
    console.error(`accept-group: no certified-pending tasks in ${key}=${value}`);
    process.exit(1);
  }
  // Deterministic sample, weakest evidence first: missing/failing receipts beat
  // prose-only proofs beat validated green evidence; id tie-break keeps the same
  // command surfacing the same rows to verify.
  const groupRoot = projection.workspace_root || process.cwd();
  const groupEvidence = new Map(group.map(task => [task.id, extractReceiptEvidence(task.review?.proof, groupRoot)]));
  const need = Math.min(spotCheck, group.length);
  const sample = [...group].sort((a, b) =>
    evidenceRiskRank(groupEvidence.get(a.id)) - evidenceRiskRank(groupEvidence.get(b.id))
    || String(a.id).localeCompare(String(b.id))).slice(0, need);

  if (!confirm) {
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'accept_group_preview',
        group: `${key}=${value}`,
        count: group.length,
        evidence_passing: group.filter(task => groupEvidence.get(task.id)?.all_passing).length,
        spot_check: sample.map(task => ({ ref: taskRef(task), id: task.id, title: task.title, proof: taskReviewClip(task.review?.proof, 240) || null, evidence: groupEvidence.get(task.id) || null })),
        verified_ids_to_paste: sample.map(task => task.id),
      });
      return;
    }
    console.log(`accept-group DRY RUN, ${key}=${value}: ${group.length} certified task(s)`);
    console.log(`Spot-check these ${need} (weakest evidence first; open + verify), then accept the whole cluster:`);
    sample.forEach((task) => {
      console.log(`  ${taskRef(task)}  ${task.title}`);
      const proof = taskReviewClip(task.review?.proof, 200);
      if (proof) console.log(`     proof: ${proof}`);
      const evidence = groupEvidence.get(task.id);
      if (evidence) {
        evidence.receipts.forEach((receipt) => {
          const verdict = receipt.verifier_passed === true ? ' verifier:passed'
            : receipt.verifier_passed === false ? ' verifier:FAILED' : '';
          console.log(`     receipt: ${receipt.path}${verdict}`);
        });
        evidence.missing.forEach((missingPath) => console.log(`     receipt: ${missingPath} MISSING`));
      }
    });
    console.log('');
    console.log(`If they hold up, accept all ${group.length} (career XP only on the ${need} you verified):`);
    console.log(`  atris task accept-group ${key}=${JSON.stringify(value)} --spot-check ${spotCheck} --confirm-human-accept --as <you> --verified ${sample.map(task => task.id).join(',')}`);
    return;
  }

  if (!actor) {
    console.error('accept-group: --as <human> required to accept');
    process.exit(2);
  }
  const verifiedInput = typeof verifiedRaw === 'string' ? verifiedRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const groupIds = new Set(group.map(task => task.id));
  const verifiedIds = new Set();
  for (const ref of verifiedInput) {
    let resolved = groupIds.has(ref) ? ref : null;
    if (!resolved) { try { resolved = requireTaskId(taskDb, db, ref, 'atris task accept-group'); } catch { resolved = null; } }
    if (resolved && groupIds.has(resolved)) verifiedIds.add(resolved);
  }
  if (verifiedIds.size < need) {
    console.error(`accept-group: spot-check requires you to verify ${need} task(s) IN this group via --verified <ids>. Got ${verifiedIds.size}.`);
    console.error('Run the same command without --confirm-human-accept to see which rows to verify.');
    process.exit(2);
  }

  const groupLabel = `${key}=${value}`;
  const accepted = [];
  for (const task of group) {
    const isVerified = verifiedIds.has(task.id);
    const proof = String(task.review?.proof || task.metadata?.latest_agent_proof || '').trim()
      || `Accepted via group spot-check (${groupLabel}); human ${actor} verified ${verifiedIds.size}/${group.length}.`;
    const missionXpIssue = missionXpEndToEndProofIssue(task, proof, task.workspace_root || taskDb.workspaceRoot());
    if (missionXpIssue) {
      accepted.push({ id: task.id, ok: false, reason: MISSION_XP_END_TO_END_REASON, detail: missionXpIssue });
      continue;
    }
    const done = taskDb.acceptTask(db, {
      id: task.id,
      actor,
      reward: 1,
      lesson: String(task.review?.lesson || ''),
      nextTask: String(task.review?.next_task || ''),
      proof,
      careerXpEligible: isVerified, // honest: career XP ONLY for rows the human actually verified
    });
    if (!done.updated) { accepted.push({ id: task.id, ok: false, reason: 'not_review' }); continue; }
    const reviewed = done.reviewed;
    refreshCareerXpAfterReview(reviewed);
    stampAcceptGroupMetadata(taskDb, db, task.id, { actor, group: groupLabel, verified: isVerified, sampleVerifiedIds: [...verifiedIds] });
    accepted.push({ id: task.id, ok: true, verified: isVerified, career_xp: isVerified });
  }
  const { outPath: afterPath } = writeDefaultProjection(taskDb, db);
  const okCount = accepted.filter(a => a.ok).length;
  const verifiedCount = accepted.filter(a => a.ok && a.verified).length;
  const sampledCount = accepted.filter(a => a.ok && !a.verified).length;
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'accept_group',
      group: groupLabel,
      accepted: okCount,
      verified_career_xp: verifiedCount,
      sampled_no_career_xp: sampledCount,
      projection_path: afterPath,
      results: accepted,
    });
    return;
  }
  console.log(`accept-group ${groupLabel}: accepted ${okCount}/${group.length}`);
  console.log(`  ${verifiedCount} verified (career XP) + ${sampledCount} accepted-by-sampling (no career XP, provenance recorded)`);
}

// --work-root <path>, or ATRIS_WORK_ROOT only when the flag is absent. Nothing named gives
// undefined. The job then records the main folder's commit as before. A flag that is present
// but empty is an error, never a quiet fall back to the env var. A relative path resolves
// from the current folder. The folder must be a real checkout with a commit, because that
// commit is what the job records.
function readyWorkRoot(args) {
  const at = args.indexOf('--work-root');
  let named;
  if (at !== -1) {
    named = String(args[at + 1] === undefined ? '' : args[at + 1]).trim();
    if (!named) {
      console.error('work root is empty');
      process.exit(1);
    }
  } else {
    named = String(process.env.ATRIS_WORK_ROOT || '').trim();
  }
  if (!named) return undefined;
  const resolved = path.resolve(named);
  let isDir = false;
  try { isDir = fs.statSync(resolved).isDirectory(); } catch (_) { isDir = false; }
  if (!isDir) {
    console.error(`work root not found: ${resolved}`);
    process.exit(1);
  }
  if (!getTaskDb().workspaceHead(resolved)) {
    console.error(`work root has no git commit: ${resolved}`);
    process.exit(1);
  }
  return resolved;
}

function cmdReady(args) {
  const pos = positional(args);
  const id = pos[0];
  const proofFlag = flag(args, '--proof');
  const verifyFlag = flag(args, '--verify');
  const resultFlag = textFlag(args, ['--result']);
  if (!id || (!proofFlag && !verifyFlag && !resultFlag)) {
    console.log('Usage: atris task ready <id> --proof "..." --result "<sentence>" [--work-root <path>] (the copy you built in; ATRIS_WORK_ROOT is the fallback; a relative path resolves from the current folder)');
    process.exit(2);
  }
  // The copy the builder actually built in. Its commit is the one the job records.
  // Without it the job records the main folder's commit, as before.
  const workRoot = readyWorkRoot(args);
  // Two ways to prove: --proof "<note>" (claimed, pattern-checked) or
  // --verify "<command>" which actually RUNS the command and gates ready on exit 0.
  // If --proof names npm test, node --test, or git diff --check, this process
  // must have run that command. A sentence that names one of those is a lie.
  const proofUrl = textFlag(args, ['--proof-url']);
  const iFetched = hasFlag(args, '--i-fetched');
  if (proofUrl && !iFetched) {
    failTask(
      'atris task ready',
      'unfetched_proof_url',
      'CI run URLs only count after atris fetches them, or with --proof-url and --i-fetched',
    );
  }
  if (iFetched && !proofUrl && !(typeof proofFlag === 'string' && /https?:\/\/github[.]com\//i.test(proofFlag))) {
    failTask(
      'atris task ready',
      'proof_url_required',
      '--i-fetched requires --proof-url <actions-run-url> (or a URL inside --proof)',
    );
  }
  const usedVerify = typeof verifyFlag === 'string' ? verifyFlag.trim() : '';
  const resultSentence = requireResultSentence('atris task ready', textFlag(args, ['--result']), {
    ready: true,
    allowCommandMention: Boolean(usedVerify),
  });
  let proof = typeof proofFlag === 'string' ? proofFlag : '';
  if (proofUrl && iFetched) {
    const attested = `[i-fetched] ${proofUrl}`;
    proof = proof.trim() ? `${proof.trim()} ${attested}` : attested;
  }
  const verifyAutoCertifyAllowed = !usedVerify || isAutoCertifyVerifyCommandAllowed(verifyFlag);
  const landing = landingFlags(args);
  // What this process can refuse from the flags and the task alone is refused before the verifier
  // runs. Wording or a name the gate would turn away never costs a test run. The verifier's own
  // wording, the actor, the task lookup and the landing sentence only need the flags and the task
  // row. Without --verify nothing slow comes first. The actor, task and landing checks then keep
  // their place after the proof checks below.
  let readyTarget = null;
  const resolveReadyTarget = () => {
    if (readyTarget) return readyTarget;
    guardExplicitActor('atris task ready', flag(args, '--as'));
    const taskDb = getTaskDb();
    const db = taskDb.open();
    const taskId = requireTaskId(taskDb, db, id, 'atris task ready');
    const beforeTask = taskDetail(taskDb, db, taskId);
    requireExplicitLandingDayOnePm('atris task ready', landing, beforeTask && beforeTask.title);
    readyTarget = { taskDb, db, taskId, beforeTask };
    return readyTarget;
  };
  // The start of the proof written once the verifier passes. It is built from the flags alone. A
  // proof that names a command the verifier did not run is refused before the verifier runs. The
  // command's output and the receipt path follow it. Then the same check runs again on the whole
  // proof.
  const verifiedLead = usedVerify
    ? `[verified] \`${verifyFlag}\` passed (exit 0)${proof.trim() ? `, ${proof.trim()}` : ''}`
    : '';
  if (usedVerify) {
    if (!hasFlag(args, '--no-falsify-check')) {
      const { classifyVerifier } = require('../../../lib/verifier-quality');
      const quality = classifyVerifier(verifyFlag);
      if (!quality.ok) {
        console.error(`atris task ready: weak verifier, ${quality.reason}`);
        console.error(`  command: ${verifyFlag}`);
        console.error('  allowlisted examples: node --test, npm test, git diff --check, node --check, rg <symbol>');
        console.error('  or pass --no-falsify-check to accept anyway.');
        process.exit(1);
      }
    }
    requireRanNamedProofCommand('atris task ready', verifiedLead, usedVerify);
    resolveReadyTarget();
  }
  if (usedVerify) {
    // Run the verifier once and write a receipt (pass or fail) so the review
    // gate in lib/receipt-evidence.js can validate the exact path named in
    // the proof, not just trust the prose.
    const { writeTaskReceipt } = require('../../../lib/task-receipt');
    // The check runs in the copy the work was built in. Its receipt still lands under the
    // folder ready ran from, because that is where a reviewer looks for the path in the proof.
    const receipt = writeTaskReceipt({ taskId: id, command: verifyFlag, root: workRoot || process.cwd(), receiptRoot: process.cwd() });
    if (!receipt.passed) {
      const detail = receipt.exit != null ? ` (exit ${receipt.exit})` : (receipt.signal ? ` (signal ${receipt.signal})` : '');
      console.error(`atris task ready: verifier failed${detail}: ${verifyFlag}`);
      if (receipt.output) console.error(receipt.output);
      else if (receipt.error) console.error(receipt.error);
      if (receipt.receiptPath) console.error(`receipt: ${receipt.receiptPath}`);
      process.exit(1);
    }
    // Exit 0 says the check passed. It does not say the check could have
    // failed. Run it again with none of the work present: a check anchored to
    // this codebase fails there, and one that passes anywhere passes there too.
    if (!hasFlag(args, '--no-falsify-check')) {
      const { probeVerifierCanFail } = require('../../../lib/falsifier-probe');
      const probe = probeVerifierCanFail({ command: verifyFlag });
      if (probe.probed && probe.canFail === false) {
        console.error(`atris task ready: this check cannot fail, ${probe.reason}`);
        console.error(`  command: ${verifyFlag}`);
        console.error('  give a check that fails when the work is missing, or pass --no-falsify-check to accept anyway.');
        process.exit(1);
      }
      if (!probe.probed && !wantsJson(args)) console.log(`  ${probe.reason}`);
    }
    proof = `${verifiedLead}${receipt.output ? `\n${receipt.output}` : ''}\nReceipt: ${receipt.receiptPath}`;
    if (!wantsJson(args)) console.log(`✓ verified: \`${verifyFlag}\` exited 0 (receipt ${receipt.receiptPath})`);
  }
  if (!proof) {
    console.error('atris task ready: --proof or --verify required');
    process.exit(2);
  }
  requireMeaningfulTaskProof('atris task ready', proof);
  requireRanNamedProofCommand('atris task ready', proof, usedVerify);
  const lesson = flag(args, '--lesson') || '';
  const nextTaskInput = normalizeReviewNextTaskInput(typeof flag(args, '--next') === 'string' ? flag(args, '--next') : '');
  const merge = readyMergeFlags(args);
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  // The others who built the work with --as, by name, comma apart: a flight that ran for a member
  // hands in under the member's name and names the engines that ran here. Only a hand-in uses it.
  const builtWith = textFlag(args, ['--built-with']).split(',').map((name) => name.trim()).filter(Boolean);
  const resultFields = {
    changed: textFlag(args, ['--changed', '--done']),
    checked: textFlag(args, ['--checked', '--check', '--verified']),
    passed: textFlag(args, ['--passed', '--pass']),
    failed: textFlag(args, ['--failed', '--fail']),
    cost: textFlag(args, ['--cost']),
    saved: textFlag(args, ['--saved', '--savings']),
    tryNext: textFlag(args, ['--try', '--try-next', '--handoff']),
    status: textFlag(args, ['--status']),
    files: textFlag(args, ['--files']),
    commands: textFlag(args, ['--commands', '--command']),
  };
  const { taskDb, db, taskId } = resolveReadyTarget();
  // The verifier may have run for a while. The task is read again after it. Without one, nothing
  // elapsed and the read from the checks above stands. The landing sentence is checked against the
  // refreshed title too, since a verifier can rename the task.
  const beforeTask = usedVerify ? taskDetail(taskDb, db, taskId) : readyTarget.beforeTask;
  if (usedVerify) requireExplicitLandingDayOnePm('atris task ready', landing, beforeTask && beforeTask.title);
  const missionXpIssue = missionXpEndToEndProofIssue(beforeTask, proof, taskDb.workspaceRoot());
  if (missionXpIssue) {
    failTask('atris task ready', MISSION_XP_END_TO_END_REASON, missionXpIssue);
  }
  const readyPolicyTask = {
    ...beforeTask,
    workspace_root: workRoot || process.cwd(),
    metadata: {
      ...(beforeTask && beforeTask.metadata || {}),
      ...(resultFields.files ? { changed_files: resultFields.files } : {}),
    },
  };
  const readyPolicyGate = candidatePolicyGate(readyPolicyTask, { executeDetectors: true });
  if (!readyPolicyGate.ok) refuseCandidatePolicyGate('atris task ready', readyPolicyGate);
  const resultTrace = buildAutomaticResultTrace(taskDb, db, taskId, {
    actor,
    proof: String(proof),
    ...resultFields,
    changed: resultFields.changed || resultSentence,
  });
  let result;
  try {
    result = taskDb.readyTask(db, {
      id: taskId,
      actor,
      proof: String(proof),
      lesson: typeof lesson === 'string' ? lesson : '',
      nextTask: nextTaskInput.nextTask,
      resultTrace: resultTrace && resultTrace.trace,
      landing,
      merge,
      result: resultSentence,
      builtWith,
      workRoot,
    });
  } catch (err) {
    if (err.code !== 'claim_lost') throw err;
    // The proof is the one thing this run made that the job would have kept; print it so it is not lost.
    console.error(`ready refused: ${err.message}`);
    console.error(`Your work is still in ${workRoot || process.cwd()}. The proof you gave was:\n${proof}`);
    // Its own exit code, so a flight can tell a lost claim from a hand-in it should try again.
    process.exit(3);
  }
  if (!result.ready) {
    console.error(`ready failed: ${result.reason}`);
    process.exit(1);
  }
  // Store the exact verifier command on the task itself (not just baked into
  // proof prose) so sweep --auto-accept and certify-verified can re-run it
  // live against the current checkout later, instead of re-deriving it from
  // text or trusting a receipt file that may no longer exist.
  if (usedVerify) stampReadyVerifyMetadata(taskDb, db, taskId, usedVerify);
  const landingAdvisory = warnIfLandingNeedsDayOnePm(landing, result.row && result.row.title);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const agentCertified = result.event.payload.agent_certified === true;
  const projectionTask = taskFromProjection(projection, taskId)
    || compactTaskFromProjection(projection, taskId)
    || result.row;
  const verifierTask = taskWithReviewEvidence(taskWithAgentCertification(projectionTask, agentCertified), {
    proof: String(proof),
    lesson: typeof lesson === 'string' ? lesson : '',
    nextTask: nextTaskInput.nextTask,
  });
  const reviewChat = taskReviewChatHandoff(verifierTask, { reviewer: 'codex-review' });
  const autolandLib = require('../../../lib/autoland');
  const workspaceRoot = taskDb.workspaceRoot();
  const autolandOn = autolandLib.liveAcceptAuthorization(workspaceRoot).ok;
  const whenLands = autolandLib.whenAutolandLands(workspaceRoot);
  const needsExternalVerifier = Boolean(usedVerify && !verifyAutoCertifyAllowed);
  const handoff = {
    native_goal_status: agentCertified ? 'agent_certified' : 'needs_second_agent_review',
    career_xp_status: 'pending_human_accept',
    next_action: agentCertified ? certifiedReviewNextAction(nextTaskInput.nextTask) : 'agent_review_again',
    rule: autolandOn
      ? (agentCertified
        ? `double-check complete; autoland will accept this ${whenLands}.`
        : needsExternalVerifier
        ? 'proof is ready; this verifier needs a second agent review because autoland cannot rerun it.'
        // Autoland accepts; landing is a git fact it proves separately. Do not
        // promise "lands it" for work that may not be committed or merged.
        : `proof is ready; autoland runs the second check and accepts it ${whenLands}; it lands once committed and merged.`)
      : (agentCertified
        ? 'double-check complete; ready to keep moving. XP is awarded only after the human approves the task.'
        : 'proof is ready; one more agent check before human approval. XP waits for the human.'),
  };
  if (reviewChat) {
    handoff.review_chat_command = reviewChat.command;
    handoff.codex_prompt = reviewChat.codex_prompt;
    handoff.verification_focus = reviewChat.verification_focus;
  }
  // Mined proof lessons without runnable detectors remain coaching. Promoted,
  // path-scoped detector lessons already passed the hard gate above.
  const { readPolicyLessons, policyHintsForProof } = require('../../../lib/policy-lessons');
  const policyHints = policyHintsForProof(String(proof), readPolicyLessons(taskDb.workspaceRoot()), taskDb.workspaceRoot());
  if (policyHints.length) handoff.policy_hints = policyHints;
  if (readyPolicyGate.gate.advisories.length) handoff.policy_gate = readyPolicyGate.gate;
  if (wantsJson(args)) {
    const taskCard = compactTaskFromProjection(projection, taskId);
    const nextCommand = handoff.review_chat_command
      || (agentCertified
        ? `atris task accept ${taskRef(taskCard || result.row || taskId)}`
        : `atris task reviews`);
    const fullReady = {
      ok: true,
      action: 'ready',
      task_id: taskId,
      version: result.event.version,
      approval_status: 'pending',
      review_pass_count: result.event.payload.review_pass_count,
      agent_certified: agentCertified,
      handoff,
      result_trace: resultTrace,
      landing_advisory: landingAdvisory,
      ...(nextTaskInput.ignored ? { review_next_task_ignored: nextTaskInput.ignored } : {}),
      projection_path: outPath,
      task: taskCard,
      next_command: nextCommand,
    };
    printCliJson(
      fullReady,
      compactSuccessPayload({
        action: 'ready',
        ids: {
          task_id: taskId,
          selected_ref: taskRef(taskCard || result.row || taskId),
          version: result.event.version,
          agent_certified: agentCertified,
        },
        next_command: nextCommand,
      }),
      args,
    );
    return;
  }
  console.log(`ready for approval ${taskRef(compactTaskFromProjection(projection, taskId))} v${result.event.version}`);
  if (resultTrace) console.log('Result trace recorded.');
  console.log(handoff.rule);
  if (!verifyAutoCertifyAllowed) {
    const ref = taskRef(compactTaskFromProjection(projection, taskId) || result.row || taskId);
    console.log(`note: this verify command is outside the auto-certify allowlist, so autoland cannot run the second check itself. use a test command like node --test <file> or git diff --check, or have a second agent run: atris task review-chat ${ref} --as <reviewer>`);
  }
  for (const hint of policyHints) {
    console.log(`policy (${hint.id}): ${hint.hint}`);
  }
}

// Standalone receipt writer: runs a verifier for a task and writes atris/runs/
// evidence without moving the task to ready. Useful when you want a receipt
// on record before or independent of a ready call, or to record a failed
// verifier run for the audit trail. `atris task ready --verify` calls the
// same writer inline and folds the resulting path into the proof.
function cmdTaskReceipt(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task receipt: id required');
    process.exit(2);
  }
  const verifyFlag = flag(args, '--verify');
  if (typeof verifyFlag !== 'string' || !verifyFlag.trim()) {
    console.error('atris task receipt: --verify "<cmd>" required');
    process.exit(2);
  }
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task receipt');
  const { writeTaskReceipt } = require('../../../lib/task-receipt');
  const receipt = writeTaskReceipt({ taskId, command: verifyFlag, root: process.cwd() });
  if (wantsJson(args)) {
    printJson({
      ok: receipt.passed,
      task_id: taskId,
      command: verifyFlag,
      receipt_path: receipt.receiptPath,
      exit: receipt.exit,
      passed: receipt.passed,
    });
    if (!receipt.passed) process.exit(1);
    return;
  }
  if (receipt.passed) {
    console.log(`receipt written: ${receipt.receiptPath} (exit 0)`);
    console.log(`use: atris task ready ${taskId} --proof "Receipt: ${receipt.receiptPath}" --result "<what someone can do now and why it matters>"`);
  } else {
    console.error(`verifier failed (exit ${receipt.exit}); receipt written: ${receipt.receiptPath}`);
    if (receipt.output) console.error(receipt.output);
    process.exit(1);
  }
}

async function cmdAccept(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) {
    console.error('atris task accept: id required');
    process.exit(2);
  }
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const reward = flag(args, '--reward');
  const lessonFlag = flag(args, '--lesson');
  const nextTaskFlag = flag(args, '--next');
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task accept');
  if (agentProofOnlyMode()) {
    failAgentProofOnly(
      'atris task accept',
      'Agent proof-only mode cannot accept tasks or award XP. Leave proof in Review for human accept/revise.',
    );
  }
  const beforeProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId }));
  const beforeTask = beforeProjection.tasks[0] || null;
  const proofFlag = flag(args, '--proof');
  const hasExplicitProof = typeof proofFlag === 'string';
  const proof = hasExplicitProof
    ? proofFlag
    : String(beforeTask?.metadata?.latest_agent_proof || '').trim();
  if (!proof) {
    console.error('atris task accept: proof required or task must already have fresh proof_ready proof');
    process.exit(2);
  }
  requireMeaningfulTaskProof('atris task accept', proof);
  const missionXpIssue = missionXpEndToEndProofIssue(beforeTask, proof, taskDb.workspaceRoot());
  if (missionXpIssue) {
    failTask('atris task accept', MISSION_XP_END_TO_END_REASON, missionXpIssue);
  }
  // The proof must be able to fail. Run the stored verify command and refuse the
  // accept if it does not parse, does not run, or does not pass. Prose describing a
  // check is not a check.
  const acceptVerify = evaluateAcceptVerify(beforeTask, taskDb.workspaceRoot());
  const verifyOverride = hasFlag(args, '--accept-unverified');
  const overrideReason = String(flag(args, '--reason') || '').trim();
  if (!acceptVerify.ok && !verifyOverride) {
    failTask(
      'atris task accept',
      acceptVerify.reason,
      `${acceptVerify.detail}. Stored verify: ${acceptVerify.command || '(none)'}. `
        + 'Fix the verify command and re-run, or accept deliberately with '
        + '--accept-unverified --reason "why this cannot be machine-checked".',
    );
  }
  if (!acceptVerify.ok && verifyOverride && !overrideReason) {
    failTask(
      'atris task accept',
      'unverified_accept_needs_reason',
      '--accept-unverified records an unfalsifiable accept in the ledger, so it requires --reason "<why>".',
    );
  }
  const readyReview = beforeTask?.review || {};
  const clearLesson = hasEmptyFlagValue(args, '--lesson');
  const clearNextTask = hasEmptyFlagValue(args, '--next');
  const lesson = clearLesson
    ? ''
    : typeof lessonFlag === 'string'
    ? lessonFlag
    : String(readyReview.lesson || beforeTask?.metadata?.latest_agent_lesson || '');
  const nextTask = clearNextTask
    ? ''
    : typeof nextTaskFlag === 'string'
    ? nextTaskFlag
    : String(readyReview.next_task || beforeTask?.metadata?.latest_agent_next_task || '');
  const clearedFields = [];
  if (clearLesson || (typeof lessonFlag === 'string' && !String(lessonFlag).trim())) clearedFields.push('lesson');
  if (clearNextTask || (typeof nextTaskFlag === 'string' && !String(nextTaskFlag).trim())) clearedFields.push('next_task');
  const parsedReward = parseAcceptReward(reward);
  if (!parsedReward.ok) {
    console.error('atris task accept: reward must be a positive number');
    process.exit(2);
  }
  // One transaction: done and accepted land together or not at all (lib/task-db.js acceptTask).
  const done = taskDb.acceptTask(db, {
    id: taskId,
    actor,
    reward: parsedReward.value,
    lesson,
    nextTask,
    proof,
    careerXpEligible: true,
    clearedFields,
  });
  if (!done.updated) {
    console.error(`accept failed: ${taskId} not open|claimed|review`);
    process.exit(1);
  }
  const reviewed = done.reviewed;
  const xpProjection = refreshCareerXpAfterReview(reviewed);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const workspaceRoot = projection.workspace_root || process.cwd();
  refreshExistingTodoMarkdown(taskDb, db, workspaceRoot);
  const brainScorecards = refreshBrainScorecardsAfterAccept(workspaceRoot);
  const nextMissionRoute = nextMissionRouteAfterAccept(workspaceRoot);
  // Inform the gate, never block it: show what the receipts named in the proof
  // actually say so the accepting human isn't trusting prose.
  const evidence = extractReceiptEvidence(proof, workspaceRoot);
  const publicSync = hasFlag(args, '--public') ? await publishAcceptAgentXp(args, actor) : null;
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'accepted',
      task_id: taskId,
      reviewed: true,
      reward: reviewed.episode.reward.value,
      episode: reviewed.episode,
      evidence,
      public_sync: publicSync,
      xp_projection: xpProjection,
      brain_scorecards: brainScorecards,
      next_mission_route: nextMissionRoute,
      projection_path: outPath,
      task: compactTaskFromProjection(projection, taskId),
    });
    if (publicSync && !publicSync.ok) process.exitCode = 1;
    return;
  }
  console.log(renderAcceptLanding({
    task: taskDetail(taskDb, db, taskId) || compactTaskFromProjection(projection, taskId),
    proof,
    nextTask,
    publicSync,
    xpProjection,
    brainScorecards,
    nextMissionRoute,
  }));
  if (publicSync && !publicSync.ok) process.exitCode = 1;
}

// Every auto-accept passes through here, so this is where the record says
// whether the work actually landed. Accepted is a review verdict; landed is a
// fact about git, proven by lib/landing-proof.js or not claimed at all.
// The check behind a landing is the one that actually ran: the verifier's
// passing re-run first, then the check the proof names, then the builder's
// recorded verify.
function landingProofVerify(task) {
  const metadata = task.metadata || {};
  const cache = metadata.verify_cache;
  if (cache && typeof cache === 'object' && cache.ok === true && String(cache.command || '').trim()) {
    return String(cache.command).trim();
  }
  return certifyVerifyCandidate(task) || String(metadata.verify || '').trim();
}

function stampAutoAcceptMetadata(taskDb, db, task, actor, policy) {
  const taskId = task.id;
  const row = taskDb.getTask(db, taskId);
  if (!row) return null;
  // The caller's task object was read before the re-check ran, so it lacks
  // the verify_cache and certify stamps written since. Prove from the row as
  // it stands now, keeping the caller's events and review for claimed paths.
  const current = { ...task, ...row, metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {} };
  let landing;
  try {
    landing = proveTaskLanding(current, {
      files: declaredCandidatePathValues(current),
      verify: landingProofVerify(current),
    });
  } catch (err) {
    landing = { status: 'unverified', reason: 'landing_proof_failed', detail: String((err && err.message) || err).slice(0, 200) };
  }
  // The landing proof runs git, so it is worked out first; only the write holds the lock.
  taskDb.updateTaskMetadata(db, taskId, (metadata) => {
    metadata.auto_accepted_at = new Date().toISOString();
    metadata.auto_accepted_by = actor;
    metadata.auto_accept_policy = policy;
    metadata.landing = { ...landing, checked_at: metadata.auto_accepted_at };
  });
  return landing;
}

function acceptReviewTask(taskDb, db, taskId, { actor, proof, reward, lesson = '', nextTask = '', autoAccepted = false }) {
  const task = taskDetail(taskDb, db, taskId);
  // The last door for the machine: whatever decided this job was eligible, a job
  // whose pull request is still open is never completed without a person. A
  // person's own accept (autoAccepted false) is untouched.
  if (autoAccepted) {
    const pullRequestOpen = openPullRequestRefusal(task, taskId);
    if (pullRequestOpen) return { ok: false, reason: pullRequestOpen.reason, pull_request: pullRequestOpen.pull_request };
  }
  const missionXpIssue = missionXpEndToEndProofIssue(task, proof, taskDb.workspaceRoot());
  if (missionXpIssue) {
    return { ok: false, reason: MISSION_XP_END_TO_END_REASON, detail: missionXpIssue };
  }
  // One transaction: done and accepted land together or not at all (lib/task-db.js acceptTask).
  const accepted = taskDb.acceptTask(db, {
    id: taskId,
    actor,
    reward,
    lesson,
    nextTask,
    proof,
    careerXpEligible: true,
    autoAccepted,
  });
  if (!accepted.updated) {
    return { ok: false, reason: 'not_open_claimed_or_review' };
  }
  const reviewed = accepted.reviewed;
  const acceptedRow = taskDb.getTask(db, taskId);
  refreshExistingTodoMarkdown(taskDb, db, acceptedRow && acceptedRow.workspace_root);
  return { ok: true, reviewed };
}

// Second-actor certification for proof-backed Review rows whose proof names a
// runnable, allowlisted check. Re-running that check as a distinct actor IS
// the independent verification the certification gate asks for, the row
// becomes certified and autoland can land it on the same heartbeat. Rows in
// denied lanes, without a runnable check, or already certified keep their
// existing paths (review chats, human accept).
function certifyVerifyCandidate(task) {
  const metadata = task.metadata || {};
  const review = task.review || {};
  const recorded = typeof metadata.verify === 'string' && metadata.verify.trim() ? [metadata.verify.trim()] : [];
  const proof = String(review.proof || metadata.latest_agent_proof || '');
  // The extractor splits on &&, so rebuild chains the proof actually wrote
  // ("a && b") and try each one before its pieces.
  const flatProof = proof.replace(/`/g, '').replace(/\s+/g, ' ');
  const pieces = taskReviewEvidenceCommands(proof);
  const ordered = [];
  for (let i = 0; i < pieces.length; i += 1) {
    for (let j = pieces.length; j > i + 1; j -= 1) {
      const chain = pieces.slice(i, j).join(' && ');
      if (flatProof.includes(chain)) ordered.push(chain);
    }
    ordered.push(pieces[i]);
  }
  for (const raw of [...recorded, ...ordered]) {
    // The evidence extractor can keep trailing prose ("git diff --check. Evidence
    // inspected: ..."); try the full clause, then the first sentence of it,
    // then the part before ", exit 0": six atrisos-web jobs wrote
    // "Verifier result at that commit: <command>, exit 0" and no second
    // actor ever found their check. Only a comma, "exit" and then a number
    // is cut (", exit 0", ", exit code 0"), so a list of test files is never
    // shortened into a smaller check, even when a file name starts with exit.
    const firstSentence = raw.split(/\.(?:\s|$)/)[0];
    const exitLine = /,\s*exit(?:ed)?(?:\s+(?:code|status))?(?:\s+|\s*[:=]\s*)\d+(?![\w-]|\.\w)/i;
    for (const candidate of [raw, firstSentence, firstSentence.split(exitLine)[0]].map((c) => String(c || '').trim())) {
      if (candidate && !nonFalsifyingIssue(candidate) && isAutoCertifyVerifyCommandAllowed(candidate) && !verifyIsOnlyFileChecks(candidate)) return candidate;
    }
  }
  return null;
}

// "File exists" is not certification: a verify made only of test -s / test -f
// steps does not qualify on its own.
function verifyIsOnlyFileChecks(verify) {
  const chain = parseVerifyChain(verify);
  return chain.ok && chain.steps.every((step) => step.argv[0] === 'test' && /^-[sf]$/.test(step.argv[1] || ''));
}

function stampCertifyVerifyMetadata(taskDb, db, taskId, actor, verify) {
  taskDb.updateTaskMetadata(db, taskId, (metadata) => {
    metadata.verify = metadata.verify || verify;
    metadata.certified_verified_at = new Date().toISOString();
    metadata.certified_verified_by = actor;
    metadata.machine_verified = true;
  });
}

function currentHeadSha(workspaceRoot) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: workspaceRoot || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

// metadata.verify_cache is the read path's only verify verdict: `reviews`
// must never spawn a check (that read-side execution fork-bombed the fleet
// on 2026-07-29), so the two lanes that legitimately execute verifies,
// certify-verified and the autoland landing re-check, persist the outcome
// here for the read path to consult.
function stampVerifyCacheMetadata(taskDb, db, taskId, { verify, result, actor, workspaceRoot, mainSha = null }) {
  if (!taskDb.getTask(db, taskId)) return;
  const verifyCache = {
    command: verify,
    ok: result && result.ok === true,
    reason: (result && result.reason) || null,
    ran_at: new Date().toISOString(),
    ran_by: actor,
    // The commit the check ran on: the job's own code when it has some,
    // else the folder the job lives in. Read before the write lock is taken.
    code_sha: (result && result.code_sha) || currentHeadSha(workspaceRoot),
    code_source: (result && result.code_source) || 'checkout',
    // The main line's tip when the check ran. A failure is only trusted again
    // while both this and the job's code are unchanged.
    main_sha: mainSha || null,
  };
  // A check is not a touch. Bumping updated_at here put every failed job at
  // the front of the next pass, so the same six failing jobs won every hour.
  taskDb.updateTaskMetadata(db, taskId, (metadata) => {
    metadata.verify_cache = verifyCache;
  }, { touch: false });
}

// When a review job was last given a second check; never checked reads 0.
function lastCheckedMs(task) {
  const ranAt = Date.parse(String(task?.metadata?.verify_cache?.ran_at || ''));
  return Number.isFinite(ranAt) ? ranAt : 0;
}

function failedOnSameCode(task, verify, codeSha, mainSha, now = Date.now()) {
  const cache = task?.metadata?.verify_cache;
  if (!cache || typeof cache !== 'object' || cache.ok !== false || cache.reason !== 'verify_failed') return false;
  if (cache.command !== verify || !codeSha || cache.code_sha !== codeSha) return false;
  if (!mainSha || cache.main_sha !== mainSha) return false;
  const ranAt = Date.parse(String(cache.ran_at || ''));
  return Number.isFinite(ranAt) && now - ranAt < FAILED_CHECK_TRUSTED_MS;
}

// `atris task ready --verify "<cmd>"` already runs the command live and
// gates on exit 0, but that alone leaves no machine re-runnable trace once
// the proof text scrolls out of easy reach: storing the exact command on
// metadata.verify is what lets sweep --auto-accept (and certify-verified)
// re-run it later against the current checkout instead of re-parsing prose.
function stampReadyVerifyMetadata(taskDb, db, taskId, verify) {
  taskDb.updateTaskMetadata(db, taskId, (metadata) => {
    metadata.verify = verify;
    // A real verify stamped at ready means the creation-time degraded flag is
    // stale: clear it so `task show` stops warning about a missing check. A
    // diff-only verify keeps the flag; it still cannot fail on real breakage.
    if (verify.toLowerCase() !== 'git diff --check') {
      delete metadata.verification_status;
      delete metadata.verification_degraded_reason;
    }
  });
}

function landingVerifyFailureNote(verify, result) {
  const exit = result && result.status != null ? result.status : 'unknown';
  return `Autoland re-ran allowlisted verify at landing and it failed: ${verify} (exit ${exit}).`;
}

function reverifyBeforeLanding(taskDb, db, task, { actor = 'autoland-verifier', verifyCache = null } = {}) {
  const verify = certifyVerifyCandidate(task);
  if (!verify) {
    // No runnable check on record. Landing anyway converts "never verified"
    // into "accepted with XP", the exact signal poisoning this gate exists
    // to prevent, so bounce the task back for a recorded verify instead.
    const note = 'Autoland refused to land without a runnable verify command: record one with `atris task ready --verify "<cmd>" --result "<sentence>"`.';
    const revised = taskDb.reviseTask(db, { id: task.id, actor, note });
    return {
      ok: false,
      verify: null,
      result: { reason: 'strict_verify_missing', status: null },
      note,
      revised: revised.revised === true,
      revise_reason: revised.reason || null,
    };
  }
  const mainSha = mainLineSha(task, process.cwd());
  const result = runVerifyAtJobCode(verify, task, { root: process.cwd(), cache: verifyCache });
  stampVerifyCacheMetadata(taskDb, db, task.id, { verify, result, actor, workspaceRoot: task.workspace_root, mainSha });
  if (result.ok) return { ok: true, verify, result };
  const note = landingVerifyFailureNote(verify, result);
  const revised = taskDb.reviseTask(db, {
    id: task.id,
    actor,
    note,
  });
  return {
    ok: false,
    verify,
    result,
    note,
    revised: revised.revised === true,
    revise_reason: revised.reason || null,
  };
}

// A run with a time limit starts a slow step only while the slowest step it
// has run so far would still finish in time. The first step runs as long as
// there is time left at all: nothing is known about the cost yet. A step left
// out is named as deferred and comes first again on the next run, so a long
// queue is worked through across hours instead of killed in the middle.
// 2026-11-15: in the web project each check is a vitest run of one to two
// and a half minutes on a busy machine. The second check ran up to six of
// them before any accept, the hourly pass killed the whole run at 300s every
// hour, and four jobs that were ready to land never reached the accept step.
function createRunBudget(now = Date.now) {
  let longest = 0;
  return {
    allows(deadlineMs) {
      return !deadlineMs || now() + longest < deadlineMs;
    },
    time(fn) {
      const started = now();
      try {
        return fn();
      } finally {
        longest = Math.max(longest, now() - started);
      }
    },
  };
}

// The accept step's order: jobs already certified first, since accepting one
// is the whole point of the step; among them, and among the rest, a job left
// out for time on an earlier run comes before newer arrivals, oldest
// deferral first. Otherwise the order given is kept. Without this a ready
// job behind three failing checks was left out the same way every hour.
function acceptOrder(items, rows = []) {
  const byId = new Map((rows || []).map((row) => [row.id, row]));
  const deferredAt = (item) => {
    const at = Date.parse(String((byId.get(item.id) || item)?.metadata?.accept_deferred_at || ''));
    return Number.isFinite(at) ? at : Infinity;
  };
  const certified = (item) => (isAgentCertified(byId.get(item.id) || item) ? 0 : 1);
  return items
    .map((item, index) => ({ item, index, certified: certified(item), deferred: deferredAt(item) }))
    .sort((a, b) => (a.certified - b.certified) || (a.deferred - b.deferred) || (a.index - b.index))
    .map((entry) => entry.item);
}

// Remember that a job was left out for time, so the next run reaches it
// first, and forget it once the job is reached. Not a touch: updated_at is
// the job's own news, and a deferral is not.
function markAcceptDeferred(taskDb, db, taskId, deferred) {
  const row = taskDb.getTask(db, taskId);
  if (!row) return;
  const has = Boolean(row.metadata && row.metadata.accept_deferred_at);
  if (deferred === has) return;
  taskDb.updateTaskMetadata(db, taskId, (metadata) => {
    if (deferred) metadata.accept_deferred_at = new Date().toISOString();
    else delete metadata.accept_deferred_at;
  }, { touch: false });
}

function cmdCertifyVerified(args, options = {}) {
  // preview: the hourly pass's dry run. Reads the named workspace's jobs and
  // writes nothing, not even the task list file.
  const preview = options.preview === true;
  const dryRun = preview || hasFlag(args, '--dry-run');
  const asJson = wantsJson(args);
  const silent = options.silent === true;
  const verifyCache = options.verifyCache || null;
  const includeProtected = options.includeProtected === true;
  const budget = options.budget || null;
  const actor = String(flag(args, '--as') || 'autoland-verifier');
  const limitRaw = flag(args, '--limit');
  const max = limitRaw && limitRaw !== true ? Math.max(1, Number(limitRaw) || 6) : 6;

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const projection = preview
    ? enrichTaskProjection(taskDb.taskProjection(db, { workspaceRoot: options.workspaceRoot || taskDb.workspaceRoot(), limit: 500 }))
    : writeDefaultProjection(taskDb, db).projection;
  // Least recently checked first, oldest first among never-checked jobs. The
  // limit counts checks that actually run, so skipped rows never use a turn.
  const candidates = (projection.tasks || [])
    .filter((t) => t && t.status === 'review')
    .sort((a, b) => lastCheckedMs(a) - lastCheckedMs(b) || Number(a.updated_at || 0) - Number(b.updated_at || 0));
  const results = [];
  let checks = 0;
  for (const item of candidates) {
    if (checks >= max) break;
    const fullProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId: item.id }));
    const task = fullProjection.tasks[0] || null;
    if (!task) {
      results.push({ ref: item.display_id || item.id, action: 'skipped', reason: 'task_not_found' });
      continue;
    }
    const ref = task.display_id || task.legacy_ref || task.id;
    const metadata = task.metadata || {};
    const review = task.review || {};
    if (task.status !== 'review') {
      results.push({ ref, action: 'skipped', reason: 'not_in_review' });
      continue;
    }
    const approval = String(review.approval_status || metadata.approval_status || 'pending').toLowerCase();
    if (approval !== 'pending') {
      results.push({ ref, action: 'skipped', reason: `approval_${approval}` });
      continue;
    }
    const tag = String(task.tag || '').toLowerCase();
    if (!includeProtected && DENIED_TAGS.has(tag)) {
      results.push({ ref, action: 'skipped', reason: `denied_tag_${tag}` });
      continue;
    }
    const proofBoundary = proofBoundaryBlockedEvaluation(task);
    if (proofBoundary) {
      results.push({ ref, action: 'skipped', reason: proofBoundary.reason });
      continue;
    }
    // Skip only rows the accept lane can already land, or rows blocked by
    // something an executed second-actor check cannot cure. A row with two
    // passes from ONE actor is exactly what this command exists to cure,
    // "certified" alone is not landable.
    // strictVerify stays off in this eligibility probe: certify-verified runs
    // the check itself right below, and strict mode here would execute it a
    // second time per row before the real run. executeVerify: false as well,
    // an untrusted trust tier re-enables the strict block internally even
    // with strictVerify off, which is how this probe spawned a verify per row.
    const evaluation = evaluateAutoAccept(task, { strictVerify: false, includeProtected, executeVerify: false });
    if (evaluation.eligible) {
      results.push({ ref, action: 'skipped', reason: 'already_landable' });
      continue;
    }
    // proof_not_executed is curable by definition: this command re-runs the
    // named check and replaces the free-text claim with executed evidence.
    const curable = ['not_agent_certified', 'needs_independent_reviewer', 'needs_second_reviewer_or_third_pass', 'insufficient_review_passes', 'proof_not_executed'];
    if (!curable.includes(evaluation.reason)) {
      results.push({ ref, action: 'skipped', reason: evaluation.reason });
      continue;
    }
    // judge != worker: the re-run only counts as an independent check when its actor never built
    // the row it is judging: not its builder now, and not anyone who built it before (the store
    // reads the whole history, so a job sent back, let go or reopened does not forget its builders).
    const builder = reviewIntegrity.taskBuilder(task);
    const verifier = reviewIntegrity.normalizeActor(actor);
    if (verifier && ((builder && verifier === builder) || taskDb.authorsOfTask(db, task).has(verifier))) {
      results.push({ ref, action: 'skipped', reason: 'verifier_is_builder' });
      continue;
    }
    const verify = certifyVerifyCandidate(task);
    if (!verify) {
      results.push({ ref, action: 'skipped', reason: 'no_runnable_check_in_proof' });
      continue;
    }
    const mainSha = mainLineSha(task, process.cwd());
    if (failedOnSameCode(task, verify, checkedCodeSha(task, process.cwd()), mainSha)) {
      results.push({ ref, action: 'skipped', reason: 'failed_on_this_code', verify });
      continue;
    }
    if (!dryRun && budget && !budget.allows(options.deadlineMs)) {
      results.push({ ref, action: 'deferred', reason: 'time_budget', verify });
      continue;
    }
    checks += 1;
    if (dryRun) {
      results.push({ ref, action: 'would_certify', verify });
      continue;
    }
    const runCheck = () => runVerifyAtJobCode(verify, task, { root: process.cwd(), cache: verifyCache });
    const run = budget ? budget.time(runCheck) : runCheck();
    stampVerifyCacheMetadata(taskDb, db, task.id, { verify, result: run, actor, workspaceRoot: task.workspace_root, mainSha });
    if (!run.ok) {
      results.push({ ref, action: 'verify_failed', reason: run.reason, verify });
      continue;
    }
    const policyGate = candidatePolicyGate(task, { verifyCache, executeDetectors: true });
    if (!policyGate.ok) {
      results.push({ ...policyGate, ref, action: 'skipped' });
      continue;
    }
    const builderProof = String(review.proof || metadata.latest_agent_proof || '').slice(0, 200);
    const readied = taskDb.readyTask(db, {
      id: task.id,
      actor,
      proof: `Second-actor check: \`${verify}\` re-run by ${actor}, exited 0. Builder proof inspected: ${builderProof}`,
      lesson: '',
      nextTask: '',
    });
    if (!readied.ready) {
      results.push({ ref, action: 'certify_failed', reason: readied.reason, verify });
      continue;
    }
    stampCertifyVerifyMetadata(taskDb, db, task.id, actor, verify);
    const certifiedNow = readied.event?.payload?.agent_certified === true;
    results.push({ ref, action: certifiedNow ? 'certified' : 'pass_recorded', verify });
  }
  const outPath = preview ? null : writeDefaultProjection(taskDb, db).outPath;
  const certified = results.filter((r) => r.action === 'certified').length;
  const payload = {
    ok: true,
    action: dryRun ? 'certify_verified_dry_run' : 'certify_verified',
    actor,
    certified,
    would_certify: results.filter((r) => r.action === 'would_certify').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
    failed: results.filter((r) => r.action === 'verify_failed' || r.action === 'certify_failed').length,
    deferred: results.filter((r) => r.action === 'deferred').length,
    results,
    projection_path: outPath,
  };
  if (silent) {
    return payload;
  }
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (results.length === 0) {
    console.log('certify-verified: no review rows to consider.');
  } else {
    for (const r of results) {
      const gateDetail = r.reason === 'slop_gate' && Array.isArray(r.offenders)
        ? `  [${r.offenders.join('; ')}]`
        : (r.reason === 'lesson_gate' && Array.isArray(r.lesson_ids)
          ? `  [lessons: ${r.lesson_ids.join(', ')}]`
          : '');
      console.log(`${r.action.padEnd(14)} ${r.ref}${r.verify ? `  \`${r.verify}\`` : ''}${r.reason ? `  (${r.reason})` : ''}${gateDetail}`);
    }
    console.log(`certified ${certified}; humans keep denied lanes and rows without a runnable check.`);
  }
  return payload;
}

// The landing: everything certified, one summary, one human gesture.
// Review-by-N-pastes was the operator pain; this is the batch gate that
// keeps human accept as the one gate without making it N gates.
function cmdLanding(args) {
  if (hasFlag(args, '--accept')) {
    const passthrough = args.filter(arg => arg !== '--accept');
    if (!passthrough.includes('--confirm-human-accept')) passthrough.push('--confirm-human-accept');
    return cmdAutoAcceptCertified(passthrough);
  }
  cmdReviews(args);
  console.log('');
  console.log('land everything certified above in one gesture:');
  console.log('  atris task landing --accept --as <you>');
  console.log('(items needing one more check stay in review; only certified work lands)');
}

function cmdAutoAcceptCertified(args) {
  const dryRun = hasFlag(args, '--dry-run');
  const acceptAll = hasFlag(args, '--all');
  const includeProtected = hasFlag(args, '--include-protected');
  const certifyFirst = hasFlag(args, '--certify-first');
  const strictVerify = !hasFlag(args, '--no-strict-verify') && !acceptAll;
  const actorFlag = flag(args, '--as');
  const hasHumanActor = validHumanActorFlag(actorFlag);
  const confirmedHumanAccept = hasFlag(args, '--confirm-human-accept');
  // Standing owner authorization: when the autoland policy is on for this
  // workspace, live accepts run as the owner who flipped it, no per-run
  // confirmation needed. See lib/autoland.js and 'atris autoland'.
  const dryRunEarly = hasFlag(args, '--dry-run');
  const policyAuth = (!dryRunEarly && !confirmedHumanAccept)
    ? require('../../../lib/autoland').liveAcceptAuthorization()
    : { ok: false };
  const actor = String(actorFlag || (policyAuth.ok ? policyAuth.actor : 'auto-accept-certified'));
  const limitRaw = flag(args, '--limit');
  const hasExplicitLimit = Boolean(limitRaw) && limitRaw !== true;
  // --all means sweep the full certified backlog, not just the first page of
  // it. Before this fix `max` was hard-capped at 12 even under --all, so a
  // real backlog (78 certified rows observed live) only ever drained 12/run,
  // an invisible undercount the autoland heartbeat repeated every hour.
  // AUTO_ACCEPT_ALL_SWEEP_CAP is a safety ceiling, not a target: a well-formed
  // --all run should always scan fewer rows than this.
  const AUTO_ACCEPT_ALL_SWEEP_CAP = 500;
  const max = hasExplicitLimit
    ? Math.max(1, Number(limitRaw) || 12)
    : (acceptAll ? AUTO_ACCEPT_ALL_SWEEP_CAP : 12);
  const parsedReward = parseAcceptReward(flag(args, '--reward'));
  if (!parsedReward.ok) {
    console.error('atris task auto-accept-certified: reward must be a positive number');
    process.exit(2);
  }
  if (!dryRun && !confirmedHumanAccept && !policyAuth.ok) {
    failTask(
      'atris task auto-accept-certified',
      'human_accept_confirmation_required',
      'live auto-accept requires --confirm-human-accept --as <human>, or the owner flips the standing policy with atris autoland on; use --dry-run to preview',
    );
  }
  if (!dryRun && !hasHumanActor && !policyAuth.ok) {
    failTask(
      'atris task auto-accept-certified',
      'human_actor_required',
      'live auto-accept requires --as <human> so XP has an explicit human acceptance actor',
    );
  }
  // The standing autoland policy clears this gate too, same as the two
  // per-run human gates above: the owner flipped the policy, accepts run as
  // that owner, and the cron tick would land the same rows an hour later
  // anyway. Without this exception `atris autoland tick` was blind whenever
  // invoked from an agent session (CLAUDECODE etc. in env): the spawned
  // sweep failTask'd with no summary and the tick receipt showed nulls.
  // A per-run --confirm-human-accept claim from an agent is still refused,
  // policyAuth is only consulted when no per-run confirmation is passed.
  if (agentProofOnlyMode() && !dryRun && !policyAuth.ok) {
    failAgentProofOnly(
      'atris task auto-accept-certified',
      'Agent proof-only mode can preview certified rows with --dry-run, but cannot live-accept them without the standing autoland policy.',
    );
  }

  // A heartbeat certifies and lands in one process so its live verifier result
  // remains available to the landing gate. The cache is process-local and is
  // never persisted: a later heartbeat must prove the checkout again.
  const verifyCache = new Map();
  // --budget-ms: the whole run, both phases, stays inside this many
  // milliseconds. The second check gets the first half. Each phase keeps its
  // own slowest step: one slow failing check in the second check once left
  // the accept step unable to start anything, every hour (2026-11-15).
  const startedMs = Date.now();
  const budgetRaw = Number(flag(args, '--budget-ms'));
  const budgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 0;
  const budget = budgetMs ? createRunBudget() : null;
  const acceptDeadlineMs = budgetMs ? startedMs + budgetMs : 0;
  const certification = certifyFirst && !dryRun
    ? cmdCertifyVerified([], { verifyCache, silent: true, includeProtected, budget: budgetMs ? createRunBudget() : null, deadlineMs: budgetMs ? startedMs + budgetMs / 2 : 0 })
    : null;

  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const queue = taskReviewQueue(projection, ['--limit', String(max)]);
  const pendingReview = (projection.tasks || [])
    .filter((t) => t && t.status === 'review' && t.review && t.review.approval_status === 'pending');
  // Honest denominator for the summary line below: how many rows the
  // projection actually certified, independent of any scan cap. If `scanned`
  // ever comes in under `certified`, the undercount is visible instead of
  // silent (the exact failure mode this fix closes).
  const certifiedTotal = pendingReview.filter((t) => isAgentCertified(t)).length;
  // The review queue only surfaces certified rows. Under --all the bar is
  // the protected lanes, not certification, so scan every pending review.
  const pool = acceptOrder(acceptAll
    ? pendingReview
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
      .slice(0, max)
    : queue.items.filter(item => item.queue_role !== 'blocked'), pendingReview);
  const results = [];

  for (const item of pool) {
    if (budget && !budget.allows(acceptDeadlineMs)) {
      results.push({ ref: item.display_id || item.id, eligible: false, reason: 'time_budget', action: 'deferred' });
      if (!dryRun) markAcceptDeferred(taskDb, db, item.id, true);
      continue;
    }
    if (!dryRun) markAcceptDeferred(taskDb, db, item.id, false);
    if (budget) budget.time(() => acceptOne(item));
    else acceptOne(item);
  }

  function acceptOne(item) {
    const fullProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId: item.id }));
    const task = fullProjection.tasks[0] || null;
    if (!task) {
      results.push({ ref: item.display_id || item.id, eligible: false, reason: 'task_not_found', action: 'skipped' });
      return;
    }
    const proofBoundary = proofBoundaryBlockedEvaluation(task);
    if (proofBoundary) {
      results.push({ ...proofBoundary, action: 'skipped' });
      return;
    }
    // A job not yet certified would have its check run here. When that check
    // already failed on this exact code, running it again proves nothing and
    // only takes the time a ready job behind it needs.
    if (!isAgentCertified(task)) {
      const verify = certifyVerifyCandidate(task);
      if (verify && failedOnSameCode(task, verify, checkedCodeSha(task, process.cwd()), mainLineSha(task, process.cwd()))) {
        results.push({ ref: task.display_id || task.id, eligible: false, reason: 'failed_on_this_code', action: 'skipped', verify });
        return;
      }
    }
    const evaluation = evaluateAutoAccept(task, { strictVerify, acceptAll, includeProtected, verifyCache });
    if (!evaluation.eligible) {
      results.push({ ...evaluation, action: 'skipped' });
      return;
    }
    if (dryRun) {
      results.push({ ...evaluation, action: 'would_accept', reward: parsedReward.value });
      return;
    }
    const landingVerify = reverifyBeforeLanding(taskDb, db, task, { verifyCache });
    if (!landingVerify.ok) {
      // A refused landing whose revise also failed is the worst state in the
      // loop: the work does not land AND nobody is told to fix it, so the row
      // sits in review forever being re-refused every hour. Mark it so the
      // heartbeat can raise it instead of counting it as routine.
      results.push({
        ...evaluation,
        eligible: false,
        action: landingVerify.revised ? 'revised' : 'revise_failed',
        reason: landingVerify.result.reason || landingVerify.revise_reason || 'verify_failed',
        ...(landingVerify.result.unrunnable_cause
          ? { unrunnable_cause: landingVerify.result.unrunnable_cause }
          : {}),
        alarm: landingVerify.revised !== true || landingVerify.result.reason === 'verify_unrunnable',
        verify: landingVerify.verify,
        exit_code: landingVerify.result.status,
        revision_note: landingVerify.note,
        task_id: task.id,
      });
      return;
    }
    const accepted = acceptReviewTask(taskDb, db, task.id, {
      actor,
      proof: includeProtected && protectedLaneOf(task)
        ? `${evaluation.proof}\nprotected lane accepted by owner policy (${protectedLaneOf(task)})`
        : evaluation.proof,
      reward: parsedReward.value,
      lesson: String(task.review?.lesson || task.metadata?.latest_agent_lesson || ''),
      nextTask: String(task.review?.next_task || task.metadata?.latest_agent_next_task || ''),
      autoAccepted: true,
    });
    if (!accepted.ok) {
      results.push({ ...evaluation, action: 'accept_failed', reason: accepted.reason });
      return;
    }
    const landing = stampAutoAcceptMetadata(taskDb, db, task, actor, evaluation.policy);
    refreshCareerXpAfterReview(accepted.reviewed);
    results.push({
      ...evaluation,
      action: 'accepted',
      landing,
      reward: accepted.reviewed.episode.reward.value,
      task_id: task.id,
    });
  }

  const { projection: finalProjection, outPath: finalPath } = writeDefaultProjection(taskDb, db);
  const summary = {
    certified: certifiedTotal,
    scanned: pool.length,
    accepted: results.filter(row => row.action === 'accepted').length,
    would_accept: results.filter(row => row.action === 'would_accept').length,
    revised: results.filter(row => row.action === 'revised').length,
    skipped: results.filter(row => row.action === 'skipped').length,
    failed: results.filter(row => row.action === 'accept_failed' || row.action === 'revise_failed').length,
    deferred: results.filter(row => row.action === 'deferred').length,
    // Visible undercount flag: true only if the pool was cut short by `max`
    // while certified rows still existed beyond it. --all uses a high safety
    // cap (AUTO_ACCEPT_ALL_SWEEP_CAP), so this should stay false in practice;
    // if it ever flips true, the cap itself needs raising, not silence.
    undercounted: certifiedTotal > pool.length,
  };
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: dryRun ? 'auto_accept_certified_dry_run' : 'auto_accept_certified',
      strict_verify: strictVerify,
      accept_all: acceptAll,
      summary,
      ...summary,
      results,
      certification,
      projection_path: finalPath,
      queue,
    });
    return { ...summary, results, certification, projection_path: finalPath, queue };
  }
  console.log(`AUTO-ACCEPT CERTIFIED (${dryRun ? 'dry-run' : 'execute'})`);
  console.log(`${summary.certified} certified, ${summary.scanned} scanned, ${summary.accepted || summary.would_accept} accepted, ${summary.skipped} skipped${summary.revised ? `, ${summary.revised} revised` : ''}${summary.failed ? `, ${summary.failed} failed` : ''}${summary.undercounted ? ' (UNDERCOUNTED, raise --limit or the sweep cap)' : ''}`);
  for (const row of results) {
    const nextAction = row.next_action ? ` next_action=${row.next_action}` : '';
    const reviewChat = row.review_chat_command ? ` review_chat=${row.review_chat_command}` : '';
    console.log(`${row.action.toUpperCase()} ${row.ref}: ${row.reason}${row.reward ? ` reward=${row.reward}` : ''}${nextAction}${reviewChat}`);
  }
  return { ...summary, results, certification, projection_path: finalPath, queue };
}

function autoAcceptSweepLabelValues(task) {
  const metadata = task && task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  return [
    task && task.tag,
    task && task.lane,
    metadata.tag,
    metadata.lane,
    metadata.mission_lane,
    metadata.stage,
    ...tags,
  ].filter(value => value !== undefined && value !== null && String(value).trim());
}

function autoAcceptSweepNormalizedTokens(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return [];
  return [normalized, ...normalized.split(/[^a-z0-9-]+/).filter(Boolean)];
}

function autoAcceptSweepLane(task) {
  for (const value of autoAcceptSweepLabelValues(task)) {
    for (const token of autoAcceptSweepNormalizedTokens(value)) {
      const lane = [...SWEEP_AUTO_ACCEPT_PROTECTED].find((denied) => token === denied || token.replace(/s$/, '') === denied);
      if (lane) return lane;
    }
  }
  return null;
}

function autoAcceptSweepDeniedReason(task, includeProtected = false) {
  for (const value of autoAcceptSweepLabelValues(task)) {
    const tokens = autoAcceptSweepNormalizedTokens(value);
    for (const token of tokens) {
      if (token === 'needs-human' || token === 'needshuman' || token === 'decision') {
        return 'needs_human';
      }
      const protectedLane = [...SWEEP_AUTO_ACCEPT_PROTECTED].find((denied) =>
        token === denied || token.replace(/s$/, '') === denied
      );
      if (protectedLane && !includeProtected) return 'protected_lane';
    }
  }
  return null;
}

function autoAcceptSweepLatestProof(task) {
  const metadata = task && task.metadata || {};
  const review = task && task.review || {};
  return String(review.proof || metadata.latest_agent_proof || '').trim();
}

function autoAcceptSweepVerifierEvidence(proof, root) {
  const evidence = extractReceiptEvidence(proof, root);
  if (!evidence || !evidence.receipts || !evidence.receipts.length) {
    return { ok: false, reason: 'no_passing_verifier', evidence: evidence || null };
  }
  if (evidence.missing && evidence.missing.length) {
    return { ok: false, reason: 'receipt_missing', evidence };
  }
  const passing = evidence.receipts.filter((receipt) => receipt.verifier_passed === true);
  if (!passing.length) {
    return { ok: false, reason: 'no_passing_verifier', evidence };
  }
  const notPassed = evidence.receipts.find((receipt) => receipt.verifier_passed !== true);
  if (notPassed) {
    return { ok: false, reason: 'receipt_verifier_not_passed', evidence };
  }
  return {
    ok: true,
    evidence,
    passing,
    proved_by: passing.map((receipt) => `${receipt.path} verifier_passed=true`),
  };
}

function autoAcceptSweepHappened(task) {
  const review = task && task.review || {};
  return clipStatusText(
    review.landing?.happened
      || review.result?.changed
      || task?.title
      || 'accepted verified task',
    180,
  );
}

function evaluateSweepAutoAccept(task, root, includeProtected = false) {
  const ref = taskRef(task);
  if (!task) return { eligible: false, ref, reason: 'task_not_found' };
  if (task.status !== 'review') return { eligible: false, ref, reason: 'not_in_review' };
  const metadata = task.metadata || {};
  const review = task.review || {};
  const approval = String(review.approval_status || metadata.approval_status || 'pending').toLowerCase();
  if (approval !== 'pending') return { eligible: false, ref, reason: `approval_${approval}` };
  if (metadata.auto_accepted_at) return { eligible: false, ref, reason: 'already_auto_accepted' };
  const denied = autoAcceptSweepDeniedReason(task, includeProtected);
  if (denied) return { eligible: false, ref, reason: denied };
  // A job whose pull request is still open has not landed, whatever its stored check
  // says: the same refusal as auto-accept-certified, before any check is run.
  const pullRequestOpen = openPullRequestRefusal(task, ref);
  if (pullRequestOpen) return pullRequestOpen;
  const proof = autoAcceptSweepLatestProof(task);
  if (!proof) return { eligible: false, ref, reason: 'no_proof' };
  const storedVerify = typeof metadata.verify === 'string' ? metadata.verify.trim() : '';
  if (storedVerify && nonFalsifyingIssue(storedVerify)) {
    return { eligible: false, ref, reason: 'non_falsifying_verify', verify: storedVerify };
  }
  const policyGate = candidatePolicyGate(task, { executeDetectors: true });
  if (!policyGate.ok) return { ...policyGate, ref };

  // 1. An explicit, stored verifier (`atris task ready --verify`, or a prior
  // certify-verified stamp) is the strongest signal: re-run it live, right
  // now, against the current checkout, and let it decide outright. This is
  // what unblocks CLI-762/CLI-861-shaped proofs: a real green test cited (or
  // executed) in the proof, but the older receipt-path check below could not
  // find file evidence for it once `ready --verify` stopped writing a
  // receipt file and started embedding the executed result into proof text.
  if (storedVerify) {
    const result = runVerifyCommand(storedVerify, root);
    if (!result.ok) return { eligible: false, ref, reason: result.reason, verify: storedVerify };
    return {
      eligible: true,
      ref,
      reason: 'verified_command',
      policy: 'sweep_auto_accept_verified_command',
      proof,
      verify: storedVerify,
      candidate_gate: policyGate.gate,
      proved_by: [`${storedVerify} exited 0`],
      happened: autoAcceptSweepHappened(task),
    };
  }

  // 2. Legacy path: a receipt file explicitly named in proof text.
  const verifier = autoAcceptSweepVerifierEvidence(proof, root);
  if (verifier.ok) {
    return {
      eligible: true,
      ref,
      reason: 'verified_receipt',
      policy: 'sweep_auto_accept_verified',
      proof,
      evidence: verifier.evidence,
      candidate_gate: policyGate.gate,
      proved_by: verifier.proved_by,
      happened: autoAcceptSweepHappened(task),
    };
  }

  // 3. No stored verifier and no receipt was even cited: try deriving a
  // safe, runnable command straight from the proof text itself (same
  // extractor certify-verified uses) and re-run it live. Only reached when
  // there is nothing else to go on, so a proof that legitimately cites a
  // real receipt keeps taking the receipt path above rather than racing an
  // unrelated command mentioned in the same sentence.
  if (verifier.reason === 'no_passing_verifier') {
    const derived = certifyVerifyCandidate(task);
    if (derived) {
      const result = runVerifyCommand(derived, root);
      if (result.ok) {
        return {
          eligible: true,
          ref,
          reason: 'verified_derived_command',
          policy: 'sweep_auto_accept_verified_derived',
          proof,
          verify: derived,
          candidate_gate: policyGate.gate,
          proved_by: [`${derived} exited 0`],
          happened: autoAcceptSweepHappened(task),
        };
      }
      return { eligible: false, ref, reason: result.reason, verify: derived };
    }
    // Certification filters these out, but the sweep should explain why a
    // legacy proof with only whitespace evidence cannot approve the work.
    const proofCommands = taskReviewEvidenceCommands(proof);
    if (proofCommands.length && proofCommands.every(command => nonFalsifyingIssue(command))) {
      return { eligible: false, ref, reason: 'non_falsifying_verify' };
    }
  }

  return { eligible: false, ref, reason: verifier.reason, evidence: verifier.evidence };
}

// atris task sweep --held: ask GitHub about each job waiting on an open pull request and write
// down what happened (lib/held-pull-requests.js). Anyone may run it, agents included: GitHub is
// the only source and the run grants nothing, so the agent block that guards --auto-accept does
// not apply here. It takes none of the expired-claims flags.
function cmdSweepHeld(args) {
  for (const name of ['--auto-accept', '--stale-days', '--claimer']) {
    if (hasFlag(args, name)) {
      failTask('atris task sweep', 'held_flags_conflict', `atris task sweep: --held cannot be combined with ${name}`);
    }
  }
  const named = flag(args, '--as');
  if (named === true) failTask('atris task sweep', 'missing_actor', 'atris task sweep: --as needs a name');
  guardExplicitActor('atris task sweep', named);
  const actor = String(named || DEFAULT_OWNER);
  const dryRun = hasFlag(args, '--dry-run');
  const json = wantsJson(args);
  const taskDb = getTaskDb();
  const workspaceRoot = scopedWorkspaceRoot(taskDb, args);
  const { sweepHeldJobs, describeHeldSweep } = require('../../../lib/held-pull-requests');

  // A dry run only reads: it opens the task list read only and never creates one.
  let db = null;
  let reader = null;
  if (!dryRun) {
    db = taskDb.open();
  } else if (fs.existsSync(taskDb.getDbPath())) {
    const { DatabaseSync } = require('node:sqlite');
    reader = new DatabaseSync(taskDb.getDbPath(), { readOnly: true });
    db = reader;
  }
  let report;
  try {
    report = sweepHeldJobs(taskDb, db, { workspaceRoot, actor, dryRun });
  } finally {
    if (reader) reader.close();
  }

  const changed = report.summary.landed + report.summary.released > 0;
  const projectionPath = changed ? writeDefaultProjection(taskDb, db).outPath : null;
  if (json) printJson({ ...report, ...(projectionPath ? { projection_path: projectionPath } : {}) });
  else writeStdoutSync(`${describeHeldSweep(report).join('\n')}\n`);
  if (report.ok) return;

  // GitHub could not be reached, so the rest were not asked and nothing more changed. Whatever
  // was settled before that is still refreshed on the task list.
  if (changed) autoRenderTodoFromDb();
  if (!json) {
    const left = report.summary.not_asked;
    console.error(`stopped: ${report.outage.detail}${left ? `. ${left} held ${left === 1 ? 'job was' : 'jobs were'} not asked` : ''}`);
  }
  process.exit(1);
}

function cmdSweep(args) {
  if (hasFlag(args, '--held')) return cmdSweepHeld(args);
  if (!hasFlag(args, '--auto-accept')) {
    const taskDb = getTaskDb();
    const staleRaw = flag(args, '--stale-days');
    if (staleRaw === true || (staleRaw != null && (!Number.isFinite(Number(staleRaw)) || Number(staleRaw) < 0))) throw new Error('stale days must be a nonnegative number');
    const claimer = flag(args, '--claimer');
    if (claimer === true) throw new Error('claimer requires a name');
    const dryRun = hasFlag(args, '--dry-run');
    const options = { staleDays: staleRaw == null ? undefined : Number(staleRaw), claimer };
    const tasks = dryRun ? taskDb.previewExpiredLeases(options) : taskDb.expireLeases(taskDb.open(), options);
    const groups = {};
    for (const task of tasks) (groups[task.claimed_by] ||= []).push(task);
    if (wantsJson(args)) printJson({ dry_run: dryRun, groups, tasks });
    else if (!tasks.length) console.log(dryRun ? 'no claims would be released' : 'no claims released');
    else for (const [name, entries] of Object.entries(groups)) {
      console.log(`${name}: ${entries.length} ${dryRun ? 'would be released' : 'released'}`);
      for (const entry of entries) console.log(`  ${entry.title}: ${entry.reason}`);
    }
    return;
  }
  // Sweep has no dry-run implementation: every successful invocation can
  // write accepts, even when an unrecognized --dry-run flag is supplied.
  if (agentProofOnlyMode()) {
    failAgentProofOnly(
      'atris task sweep',
      'agents cannot accept tasks or award xp. leave proof in review for a human to accept or revise.',
    );
  }
  const actor = String(flag(args, '--as') || 'orb-autoaccept');
  const parsedReward = parseAcceptReward(flag(args, '--reward'));
  if (!parsedReward.ok) {
    failTask('atris task sweep', 'invalid_reward', 'atris task sweep --auto-accept reward must be a positive number');
  }
  const limitRaw = flag(args, '--limit');
  const explicitLimit = limitRaw && limitRaw !== true ? Math.max(1, Number(limitRaw) || 0) : null;
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const { projection } = writeDefaultProjection(taskDb, db);
  const root = projection.workspace_root || process.cwd();
  let pendingReview = (projection.tasks || [])
    .filter((task) => task && task.status === 'review' && task.review && task.review.approval_status === 'pending')
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  if (explicitLimit) pendingReview = pendingReview.slice(0, explicitLimit);
  const results = [];
  for (const item of pendingReview) {
    const fullProjection = enrichTaskProjection(taskDb.taskProjection(db, { taskId: item.id }));
    const task = fullProjection.tasks[0] || null;
    const includeProtected = hasFlag(args, '--include-protected');
    const evaluation = evaluateSweepAutoAccept(task, root, includeProtected);
    if (!evaluation.eligible) {
      results.push({ ...evaluation, action: 'skipped', task_id: task?.id || item.id || null });
      continue;
    }
    const accepted = acceptReviewTask(taskDb, db, task.id, {
      actor,
      proof: includeProtected && (protectedLaneOf(task) || autoAcceptSweepLane(task))
        ? `${evaluation.proof}\nprotected lane accepted by owner policy (${protectedLaneOf(task) || autoAcceptSweepLane(task)})`
        : evaluation.proof,
      reward: parsedReward.value,
      lesson: String(task.review?.lesson || task.metadata?.latest_agent_lesson || ''),
      nextTask: String(task.review?.next_task || task.metadata?.latest_agent_next_task || ''),
      autoAccepted: true,
    });
    if (!accepted.ok) {
      results.push({ ...evaluation, action: 'accept_failed', task_id: task.id, reason: accepted.reason });
      continue;
    }
    const landing = stampAutoAcceptMetadata(taskDb, db, task, actor, evaluation.policy);
    refreshCareerXpAfterReview(accepted.reviewed);
    results.push({
      ...evaluation,
      action: 'accepted',
      landing,
      task_id: task.id,
      reward: accepted.reviewed.episode.reward.value,
    });
  }
  const { outPath } = writeDefaultProjection(taskDb, db);
  const summary = {
    scanned: pendingReview.length,
    accepted: results.filter((row) => row.action === 'accepted').length,
    skipped: results.filter((row) => row.action === 'skipped').length,
    failed: results.filter((row) => row.action === 'accept_failed').length,
  };
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'sweep_auto_accept',
      actor,
      summary,
      ...summary,
      results,
      projection_path: outPath,
    });
    return;
  }
  console.log(`TASK SWEEP AUTO-ACCEPT: ${summary.accepted} accepted / ${summary.scanned} scanned / ${summary.skipped} skipped${summary.failed ? ` / ${summary.failed} failed` : ''}`);
  for (const row of results.filter((item) => item.action === 'accepted')) {
    console.log(`ACCEPTED ${row.ref}: ${row.happened} | proved by ${row.proved_by.join(', ')}`);
  }
}

module.exports = {
  bindMain, stampAcceptGroupMetadata, cmdAcceptGroup, readyWorkRoot, cmdReady, cmdTaskReceipt,
  cmdAccept, landingProofVerify, stampAutoAcceptMetadata, acceptReviewTask, certifyVerifyCandidate,
  verifyIsOnlyFileChecks, stampCertifyVerifyMetadata, currentHeadSha, stampVerifyCacheMetadata,
  lastCheckedMs, failedOnSameCode, stampReadyVerifyMetadata, landingVerifyFailureNote,
  reverifyBeforeLanding, createRunBudget, acceptOrder, markAcceptDeferred, cmdCertifyVerified,
  cmdLanding, cmdAutoAcceptCertified, autoAcceptSweepLabelValues, autoAcceptSweepNormalizedTokens,
  autoAcceptSweepLane, autoAcceptSweepDeniedReason, autoAcceptSweepLatestProof,
  autoAcceptSweepVerifierEvidence, autoAcceptSweepHappened, evaluateSweepAutoAccept, cmdSweepHeld,
  cmdSweep,
};
