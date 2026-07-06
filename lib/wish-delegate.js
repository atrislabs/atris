'use strict';

const fs = require('fs');
const path = require('path');
const { getLogPath, ensureLogDirectory, createLogFile, addInboxIdea } = require('./file-ops');
const { resolveFunctionalOwner } = require('./functional-owner');
const { buildMissionRoom, writeMissionRoomReceipt } = require('./mission-room');
const { delegateTask } = require('../commands/task');
const { startMission, listMissions } = require('../commands/mission');
const {
  appendWishRecord,
  eventAnswers,
  latestWishEventMap,
  readWishes,
  stampIso,
  wishId,
} = require('./wish-store');
const {
  BUDGET_LABELS,
  JOURNAL_RESULT_TEXT,
  WAITING_INPUT_STATUSES,
  WISH_MISSION_RUNNER,
  WISH_SWEEP_LIMIT,
  analyzeWishParts,
  auditWish,
  deriveVerifyPlan,
  inferBudgetTier,
  quoteText,
  sharesMeaningfulWords,
  validateEngineOverride,
  verifyOutcomeText,
} = require('./wish-audit');

function withRoot(root, fn) {
  const previous = process.cwd();
  if (root && previous !== root) process.chdir(root);
  try {
    return fn();
  } finally {
    if (process.cwd() !== previous) process.chdir(previous);
  }
}

function captureWishToJournal(text, root = process.cwd()) {
  if (!fs.existsSync(path.join(root, 'atris'))) {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  }
  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();
  if (!fs.existsSync(logFile)) createLogFile(logFile, dateFormatted);
  const inboxId = addInboxIdea(logFile, text);
  return { logFile, inbox_id: inboxId };
}

function machineRecord(wish, status, audit, extra = {}) {
  const record = {
    wish_id: wish.id,
    status,
    task_id: extra.task_id || null,
    mission_id: extra.mission_id || null,
    engine: extra.engine || (audit && audit.executor ? audit.executor.id : null),
    budget: audit ? audit.budget : (extra.budget || null),
    questions: audit ? audit.questions : (extra.questions || []),
  };
  const requestedEngine = extra.requested_engine || (audit && audit.requested_engine);
  const engineFallbackReason = extra.engine_fallback_reason || (audit && audit.engine_fallback_reason);
  if (requestedEngine) record.requested_engine = requestedEngine;
  if (engineFallbackReason) record.engine_fallback_reason = engineFallbackReason;
  return record;
}

function engineAuditFields(audit) {
  const fields = {};
  if (audit && audit.requested_engine) fields.requested_engine = audit.requested_engine;
  if (audit && audit.engine_fallback_reason) fields.engine_fallback_reason = audit.engine_fallback_reason;
  return fields;
}

function wishDelegationEngine(audit, options = {}) {
  if (options.engine) return String(options.engine);
  if (audit && audit.requested_engine && audit.executor && audit.executor.id) return audit.executor.id;
  return WISH_MISSION_RUNNER;
}

function printQuestions(wishText, questions) {
  console.log(`You wished: ${quoteText(wishText)}`);
  questions.forEach((question, index) => {
    console.log(`${index + 1}. ${question}`);
  });
  console.log('answer with atris wish grant <n> "your answer".');
}

function engineLabel(engine) {
  const text = String(engine || 'the worker');
  if (text === 'codex') return 'Codex';
  if (text === 'claude') return 'Claude';
  if (text === 'atris-fast') return 'Atris Fast';
  return text;
}

function printGranted(text, audit, options = {}) {
  const verifyPlan = options.verifyPlan || deriveVerifyPlan(text);
  if (options.grantNumber) {
    console.log(`Granting wish ${options.grantNumber}: ${quoteText(text)}`);
  } else {
    console.log(`I heard you: ${quoteText(text)}`);
  }
  console.log(`I delegated it to ${engineLabel(options.engine || audit.executor.id)} with a ${audit.budget} budget, ${BUDGET_LABELS[audit.budget]}.`);
  if (verifyPlan.status === 'needs-review') console.log(verifyPlan.outcome + '.');
  else console.log(`You will know it came true when ${verifyOutcomeText(verifyPlan)}.`);
}

function latestMissionStatus(root, missionId) {
  if (!missionId) return '';
  try {
    const mission = listMissions(root).find((row) => row.id === missionId);
    return mission ? String(mission.status || '') : '';
  } catch {
    return '';
  }
}

function operatorStatus(wish, root = process.cwd()) {
  if (WAITING_INPUT_STATUSES.has(String(wish.status || ''))) return 'waiting on you';
  if (wish.status === 'delegated' || wish.status === 'decomposed') {
    const missionStatus = latestMissionStatus(root, wish.mission_id);
    if (missionStatus === 'complete') return 'came true';
    if (missionStatus === 'stopped') return 'stopped';
    if (missionStatus === 'blocked') return 'blocked';
    if (missionStatus === 'paused') return 'paused';
    if (missionStatus === 'ready') return 'ready for review';
    if (missionStatus) return 'in flight';
    if (Array.isArray(wish.out_of_scope_parts) && wish.out_of_scope_parts.length) return 'waiting on another home';
    return 'in flight';
  }
  if (wish.status === 'complete') return 'came true';
  return wish.status || 'waiting';
}

function reviewedMarker(wish) {
  return wish && (wish.reviewed || (Array.isArray(wish.reviews) && wish.reviews.length)) ? ' [reviewed]' : '';
}

function openWishes(root = process.cwd()) {
  return readWishes(root).filter((wish) => ['needs_input', 'waiting_input', 'delegated', 'decomposed', 'complete'].includes(String(wish.status || '')));
}

function printList(root = process.cwd()) {
  const wishes = openWishes(root);
  if (!wishes.length) {
    console.log('No open wishes.');
    return 0;
  }
  wishes.forEach((wish, index) => {
    console.log(`${index + 1}. ${wish.text} - ${operatorStatus(wish, root)}${reviewedMarker(wish)}`);
  });
  return 0;
}

function actorName() {
  return process.env.ATRIS_AGENT_ID || process.env.USER || 'operator';
}

function reviewableWish(wish) {
  const status = String(wish && wish.status || '').trim();
  return status === 'delegated' || status === 'complete' || status === 'completed';
}

function wishReviewTime(wish, fallback) {
  const parsed = Date.parse(wish.completed_at || wish.dispatched_at || wish.ts || wish.first_ts || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function latestReviewableWish(wishes) {
  let latest = null;
  let latestTime = -Infinity;
  wishes.forEach((wish, index) => {
    if (!reviewableWish(wish)) return;
    const time = wishReviewTime(wish, index);
    if (time >= latestTime) {
      latest = wish;
      latestTime = time;
    }
  });
  return latest;
}

function looksLikeWishId(value) {
  return /^wish[-_]/i.test(String(value || '').trim());
}

function resolveReviewTarget(root, ref) {
  const wishes = readWishes(root);
  if (!wishes.length) {
    return { ok: false, message: 'No wishes to review yet.' };
  }
  if (!ref || ref === 'latest') {
    const latest = latestReviewableWish(wishes);
    if (!latest) return { ok: false, message: 'No delegated or completed wishes to review.' };
    return { ok: true, wish: latest };
  }
  const wish = wishes.find((row) => row.id === ref);
  if (!wish) return { ok: false, message: `No wish found with id ${ref}.` };
  return { ok: true, wish };
}

function reviewWish(positionals, root = process.cwd(), options = {}) {
  const score = { ok: true, value: options.reviewScore === undefined ? null : options.reviewScore };
  const parts = positionals.slice(1).map(String).filter((value) => value.trim());
  if (!parts.length) {
    console.error('wish review needs one sentence of feedback.');
    return 2;
  }
  const knownIds = new Set(readWishes(root).map((wish) => wish.id));
  let targetRef = 'latest';
  let reviewParts = parts;
  const first = parts[0];
  if (first === 'latest' || knownIds.has(first) || looksLikeWishId(first)) {
    targetRef = first;
    reviewParts = parts.slice(1);
  }
  const reviewText = reviewParts.join(' ').trim();
  if (!reviewText) {
    console.error('wish review needs one sentence of feedback.');
    return 2;
  }
  const target = resolveReviewTarget(root, targetRef);
  if (!target.ok) {
    console.error(target.message);
    return 2;
  }
  appendWishRecord(root, {
    kind: 'review',
    wish_id: target.wish.id,
    ts: stampIso(),
    review_text: reviewText,
    review_score: score.value,
    reviewed_by: actorName(),
  });
  console.log(`Review captured for ${quoteText(target.wish.text || target.wish.id)}.`);
  return 0;
}

function startWishDelegation(wish, audit, root, options = {}) {
  const taskText = String(options.taskText || wish.text);
  const recordText = String(options.recordText || wish.text);
  const verifyPlan = options.verifyPlan || deriveVerifyPlan(taskText);
  const engine = wishDelegationEngine(audit, options);
  const now = stampIso();
  const ownerResolution = resolveFunctionalOwner({
    requestedOwner: audit.executor.id,
    title: taskText,
    tag: 'wish',
    goal: taskText,
    root,
    fallbackOwners: ['mission-lead', 'task-planner', 'architect', 'validator'],
  });
  const baseRoom = buildMissionRoom(taskText, {
    owner: ownerResolution.owner,
    root,
    ownerResolution,
    trustedRun: true,
    verifier: verifyPlan.command || '',
  });
  const room = {
    ...baseRoom,
    wish_id: wish.id,
    wish: {
      id: wish.id,
      text: recordText,
      task_text: taskText,
    },
    source: {
      ...(baseRoom.source || {}),
      wish_id: wish.id,
      wish_text: recordText,
    },
  };
  const writtenRoom = writeMissionRoomReceipt(room, { root });
  const routeOwner = writtenRoom.room?.member_route?.suggested_member
    || writtenRoom.room?.owner
    || ownerResolution.owner
    || 'mission-lead';
  const note = [
    `Wish: ${taskText}`,
    `Wish id: ${wish.id}`,
    `Mission Room: ${writtenRoom.relativePath}`,
    verifyPlan.command
      ? `Verify: ${verifyPlan.command} (${verifyOutcomeText(verifyPlan)})`
      : `Verify: needs human review (${verifyPlan.outcome})`,
    `Budget: ${audit.budget}`,
  ].join('\n');
  const { taskPayload, missionPayload } = withRoot(root, () => {
    const delegated = delegateTask([
      taskText,
      '--to',
      routeOwner,
      '--executed-by',
      engine,
      '--tag',
      'wish',
      '--goal-objective',
      taskText,
      '--note',
      note,
    ]);
    const missionArgs = [
      taskText,
      '--owner',
      routeOwner,
      '--runner',
      engine,
      '--budget',
      audit.budget,
      '--task',
      delegated.task_id,
      '--duplicate',
      '--json',
    ];
    if (verifyPlan.command) missionArgs.push('--verify', verifyPlan.command);
    return {
      taskPayload: delegated,
      missionPayload: startMission(missionArgs, {
        silent: true,
        missionPatch: {
          wish_id: wish.id,
          wish_text: recordText,
          mission_room_receipt_path: writtenRoom.relativePath,
          mission_room_name: writtenRoom.room?.name || null,
          source: 'wish',
          metadata: {
            wish_id: wish.id,
            wish_text: recordText,
            mission_room_receipt_path: writtenRoom.relativePath,
            mission_room_name: writtenRoom.room?.name || null,
            mission_room_owner: routeOwner,
          },
        },
      }),
    };
  });
  const mission = missionPayload && missionPayload.mission ? missionPayload.mission : null;
  const record = {
    id: wish.id,
    ts: now,
    text: recordText,
    status: 'delegated',
    dispatched_at: now,
    task_id: taskPayload.task_id,
    mission_id: mission ? mission.id : null,
    engine,
    validator: audit.validator.id,
    budget: audit.budget,
    verify: verifyPlan.command,
    verify_status: verifyPlan.status,
    verify_outcome: verifyPlan.outcome,
    task_text: taskText,
    mission_room_receipt_path: writtenRoom.relativePath,
    mission_room_name: writtenRoom.room?.name || null,
    mission_owner: routeOwner,
    ...engineAuditFields(audit),
  };
  return { record, taskPayload, mission, verifyPlan };
}

function appendDelegatedWishRecord(wish, audit, root, options = {}) {
  const { record, verifyPlan } = startWishDelegation(wish, audit, root, options);
  appendWishRecord(root, record);
  return { record, verifyPlan };
}

function delegateWish(wish, audit, root, asJson, options = {}) {
  const { record, verifyPlan } = appendDelegatedWishRecord(wish, audit, root, options);
  const payload = machineRecord(wish, 'delegated', audit, {
    task_id: record.task_id,
    mission_id: record.mission_id,
    engine: record.engine,
  });
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else printGranted(options.taskText || wish.text, audit, { ...options, verifyPlan, engine: record.engine });
  return 0;
}

function captureOnlyWish(wish, audit, root, asJson) {
  const now = stampIso();
  appendWishRecord(root, {
    id: wish.id,
    ts: now,
    text: wish.text,
    status: 'captured_no_mission',
    no_mission: true,
    budget: audit ? audit.budget : inferBudgetTier(wish.text),
    questions: audit ? audit.questions : [],
    ...engineAuditFields(audit),
  });
  const payload = machineRecord(wish, 'captured', audit, {
    engine: null,
    budget: audit ? audit.budget : inferBudgetTier(wish.text),
  });
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`I heard you: ${quoteText(wish.text)}`);
    console.log('Captured only; no mission started.');
  }
  return 0;
}

function formatPartRefs(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (!sorted.length) return 'no parts';
  if (sorted.length === 1) return `part ${sorted[0]}`;
  const contiguous = sorted.every((value, index) => index === 0 || value === sorted[index - 1] + 1);
  if (contiguous) return `parts ${sorted[0]}-${sorted[sorted.length - 1]}`;
  return `parts ${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
}

function partAgreement(numbers, singular, plural) {
  return numbers.length === 1 ? singular : plural;
}

function printDecomposed(parts, delegatedParts, waitingParts) {
  console.log(`This wish has ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}.`);
  parts.forEach((part) => {
    console.log(`Part ${part.part}: ${part.text}`);
  });
  const delegatedNumbers = delegatedParts.map((part) => part.part);
  const ownHomeNumbers = waitingParts
    .filter((part) => part.reason && /not in this checkout/.test(part.reason))
    .map((part) => part.part);
  const otherWaitingNumbers = waitingParts
    .filter((part) => !ownHomeNumbers.includes(part.part))
    .map((part) => part.part);
  if (delegatedNumbers.length && ownHomeNumbers.length) {
    const needs = partAgreement(ownHomeNumbers, 'needs its own home', 'need their own homes');
    console.log(`I can start ${formatPartRefs(delegatedNumbers)} now; ${formatPartRefs(ownHomeNumbers)} ${needs}.`);
  } else if (delegatedNumbers.length) {
    console.log(`I can start ${formatPartRefs(delegatedNumbers)} now.`);
  } else if (ownHomeNumbers.length) {
    const needs = partAgreement(ownHomeNumbers, 'needs its own home', 'need their own homes');
    console.log(`${formatPartRefs(ownHomeNumbers)} ${needs}.`);
  }
  if (otherWaitingNumbers.length) {
    const need = partAgreement(otherWaitingNumbers, 'needs', 'need');
    console.log(`${formatPartRefs(otherWaitingNumbers)} ${need} one clearer answer before I start.`);
  }
}

function decomposeWish(wish, parts, root, asJson, options = {}) {
  const delegatedParts = [];
  const waitingParts = [];
  let firstAudit = null;
  for (const part of parts) {
    if (part.waiting_reason) {
      waitingParts.push({
        part: part.part,
        text: part.text,
        status: 'waiting',
        reason: part.waiting_reason,
      });
      continue;
    }
    const audit = auditWish(part.text, root, options);
    if (!audit.ok) {
      waitingParts.push({
        part: part.part,
        text: part.text,
        status: 'waiting',
        reason: audit.questions[0] || 'needs a clearer scope',
        questions: audit.questions,
      });
      continue;
    }
    if (!firstAudit) firstAudit = audit;
    const { record, verifyPlan } = startWishDelegation(wish, audit, root, {
      taskText: part.text,
      recordText: wish.text,
      verifyPlan: deriveVerifyPlan(part.text),
    });
    const delegated = {
      part: part.part,
      text: part.text,
      status: 'delegated',
      task_id: record.task_id,
      mission_id: record.mission_id,
      dispatched_at: record.dispatched_at,
      budget: record.budget,
      engine: record.engine,
      verify: record.verify,
      verify_status: record.verify_status,
      verify_outcome: record.verify_outcome,
      ...engineAuditFields(audit),
    };
    delegatedParts.push(delegated);
    appendWishRecord(root, {
      ...record,
      decomposed_part: part.part,
      parts_total: parts.length,
      verify_status: verifyPlan.status,
    });
  }
  const statusParts = parts.map((part) => {
    const delegated = delegatedParts.find((item) => item.part === part.part);
    if (delegated) return { part: part.part, text: part.text, status: 'delegated' };
    const waiting = waitingParts.find((item) => item.part === part.part);
    return {
      part: part.part,
      text: part.text,
      status: 'waiting',
      reason: waiting ? waiting.reason : 'needs its own home',
    };
  });
  const firstDelegated = delegatedParts[0] || null;
  const record = {
    id: wish.id,
    ts: stampIso(),
    text: wish.text,
    status: 'decomposed',
    task_id: firstDelegated ? firstDelegated.task_id : null,
    mission_id: firstDelegated ? firstDelegated.mission_id : null,
    engine: firstAudit && firstAudit.executor ? firstAudit.executor.id : null,
    validator: firstAudit && firstAudit.validator ? firstAudit.validator.id : null,
    budget: firstAudit ? firstAudit.budget : inferBudgetTier(wish.text),
    parts: statusParts,
    delegated_parts: delegatedParts,
    ...engineAuditFields(firstAudit),
    out_of_scope_parts: waitingParts
      .filter((part) => part.reason && /not in this checkout/.test(part.reason))
      .map((part) => ({ ...part, status: 'waiting' })),
    waiting_parts: waitingParts,
  };
  appendWishRecord(root, record);
  const payload = {
    ...machineRecord(wish, 'decomposed', firstAudit, {
      task_id: record.task_id,
      mission_id: record.mission_id,
      engine: record.engine,
      budget: record.budget,
      questions: [],
    }),
    parts: statusParts,
    delegated_parts: delegatedParts,
    out_of_scope_parts: record.out_of_scope_parts,
  };
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else printDecomposed(parts, delegatedParts, waitingParts);
  return delegatedParts.length ? 0 : 1;
}

function askForInput(wish, audit, root, asJson) {
  appendNeedsInputRecord(wish, audit, root);
  const payload = machineRecord(wish, 'needs_input', audit);
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else printQuestions(wish.text, audit.questions);
  return 1;
}

function appendNeedsInputRecord(wish, audit, root) {
  appendWishRecord(root, {
    id: wish.id,
    ts: stampIso(),
    text: wish.text,
    status: 'needs_input',
    questions: audit.questions,
    vague: !!audit.vague,
    missing_slots: audit.missing_slots || [],
    ...engineAuditFields(audit),
  });
}

function latestStatusFor(wish, latestEvent) {
  return String((latestEvent && latestEvent.status) || wish.status || '').trim();
}

function latestEventHasGrantAnswer(latestEvent) {
  return eventAnswers(latestEvent).length > 0;
}

function dispatchableWishReason(wish, latestEvent) {
  if (!wish || !wish.id || wish.dispatched_at || wish.no_mission || (latestEvent && latestEvent.no_mission)) return '';
  const status = latestStatusFor(wish, latestEvent);
  if (status === 'captured') return 'captured';
  if (WAITING_INPUT_STATUSES.has(status) && latestEventHasGrantAnswer(latestEvent)) return 'answered';
  return '';
}

function waitingWishNeed(questions = []) {
  const first = (Array.isArray(questions) ? questions : [])
    .map((question) => String(question || '').trim())
    .find(Boolean) || 'Answer the open question before I dispatch it.';
  if (/working builder/i.test(first)) return 'needs a working builder before it can start';
  if (/working reviewer/i.test(first)) return 'needs a working reviewer before it can start';
  if (/file or folder/i.test(first)) return 'needs the file or folder location before it can start';
  if (/workspace, repo, file, or team member/i.test(first)) return first.replace(/^Which /, 'needs the ');
  return first;
}

function waitingOperatorWishes(root = process.cwd()) {
  const latest = latestWishEventMap(root);
  return readWishes(root)
    .filter((wish) => {
      const latestEvent = latest.get(wish.id) || wish;
      const status = latestStatusFor(wish, latestEvent);
      return WAITING_INPUT_STATUSES.has(status) && !latestEventHasGrantAnswer(latestEvent) && !wish.dispatched_at;
    })
    .map((wish) => {
      const latestEvent = latest.get(wish.id) || wish;
      const questions = Array.isArray(latestEvent.questions) ? latestEvent.questions : (wish.questions || []);
      return {
        id: wish.id,
        text: String(wish.text || '').trim(),
        questions,
        need: waitingWishNeed(questions),
        first_ts: wish.first_ts || wish.ts || latestEvent.ts || null,
      };
    });
}

function dispatchWishHeadlessly(wish, root, reason) {
  const auditText = reason === 'answered'
    ? [wish.text, ...(wish.answers || [])].join(' ')
    : wish.text;
  const audit = auditWish(auditText, root);
  if (!audit.ok) {
    appendNeedsInputRecord(wish, audit, root);
    return {
      id: wish.id,
      status: 'waiting_on_operator',
      no_executor: !audit.executor,
      no_validator: !audit.validator,
      questions: audit.questions,
    };
  }
  const { record } = appendDelegatedWishRecord(wish, audit, root);
  return {
    id: wish.id,
    status: 'delegated',
    dispatched: true,
    task_id: record.task_id,
    mission_id: record.mission_id,
    engine: record.engine,
    dispatched_at: record.dispatched_at,
  };
}

function sweepWishes(root = process.cwd(), options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : WISH_SWEEP_LIMIT;
  const latest = latestWishEventMap(root);
  const summary = {
    scanned: 0,
    dispatched: 0,
    capped: 0,
    waiting_on_operator: 0,
    skipped_no_executor: 0,
    results: [],
  };
  for (const wish of readWishes(root)) {
    const latestEvent = latest.get(wish.id) || wish;
    const reason = dispatchableWishReason(wish, latestEvent);
    if (!reason) continue;
    summary.scanned += 1;
    if (summary.dispatched >= limit) {
      summary.capped += 1;
      continue;
    }
    const result = dispatchWishHeadlessly(wish, root, reason);
    summary.results.push(result);
    if (result.dispatched) summary.dispatched += 1;
    if (result.no_executor) summary.skipped_no_executor += 1;
  }
  summary.waiting_on_operator = waitingOperatorWishes(root).length;
  return summary;
}

function runCapturedWish(text, root = process.cwd(), options = {}) {
  const asJson = !!options.asJson;
  const noMission = !!options.noMission;
  let engineOverride = '';
  try {
    engineOverride = validateEngineOverride(options.engineOverride, root);
  } catch (error) {
    console.error(error.message || String(error));
    return 2;
  }
  const ts = stampIso();
  const wish = {
    id: wishId(text, ts),
    ts,
    text,
    status: 'captured',
  };
  captureWishToJournal(text, root);
  appendWishRecord(root, wish);
  const parts = analyzeWishParts(text, root);
  if (parts && noMission) return captureOnlyWish(wish, null, root, asJson);
  if (parts) return decomposeWish(wish, parts, root, asJson, { engineOverride });
  const audit = auditWish(text, root, { engineOverride });
  if (!audit.ok) return askForInput(wish, audit, root, asJson);
  if (noMission) return captureOnlyWish(wish, audit, root, asJson);
  return delegateWish(wish, audit, root, asJson);
}

function grantWish(positionals, root = process.cwd(), options = {}) {
  const asJson = !!options.asJson;
  const noMission = !!options.noMission;
  let engineOverride = '';
  try {
    engineOverride = validateEngineOverride(options.engineOverride, root);
  } catch (error) {
    console.error(error.message || String(error));
    return 2;
  }
  const number = Number(positionals[1]);
  const answer = positionals.slice(2).join(' ').trim();
  if (!Number.isInteger(number) || number <= 0 || !answer) {
    console.error('wish grant needs a list number and an answer.');
    return 2;
  }
  const waiting = openWishes(root);
  const wish = waiting[number - 1];
  if (!wish) {
    console.error('No wish is waiting at that number.');
    return 2;
  }
  if (!WAITING_INPUT_STATUSES.has(String(wish.status || ''))) {
    if (!asJson) console.log(`Granting wish ${number}: ${quoteText(wish.text)}`);
    console.error('That wish is not waiting on an answer.');
    return 2;
  }
  const vagueFlagged = wish.vague === true
    || (Array.isArray(wish.missing_slots) && wish.missing_slots.length > 0)
    || (Array.isArray(wish.questions) && wish.questions.some((question) => /\b(outcome|Who is|What part)\b/i.test(String(question))));
  if (vagueFlagged && !sharesMeaningfulWords(wish.text, answer)) {
    const notice = 'This answer may be for a different wish, so I did not dispatch it.';
    if (asJson) {
      const payload = machineRecord(wish, 'needs_input', {
        executor: null,
        budget: wish.budget || inferBudgetTier(wish.text),
        questions: wish.questions || [],
      }, {
        engine: wish.engine || null,
      });
      console.log(JSON.stringify({
        ...payload,
        mismatch: true,
        notice,
        wish_text: wish.text,
      }, null, 2));
    } else {
      console.log(`Granting wish ${number}: ${quoteText(wish.text)}`);
      console.log(notice);
      printList(root);
    }
    return 1;
  }
  appendWishRecord(root, {
    id: wish.id,
    ts: stampIso(),
    text: wish.text,
    status: 'needs_input',
    answer,
  });
  const answeredWish = {
    ...wish,
    answers: [...(wish.answers || []), answer],
  };
  const auditText = [wish.text, ...(answeredWish.answers || [])].join(' ');
  const audit = auditWish(auditText, root, { engineOverride });
  if (!audit.ok) return askForInput(answeredWish, audit, root, asJson);
  if (noMission) return captureOnlyWish(answeredWish, audit, root, asJson);
  return delegateWish(answeredWish, audit, root, asJson, { grantNumber: number });
}

module.exports = {
  appendDelegatedWishRecord,
  appendNeedsInputRecord,
  askForInput,
  captureOnlyWish,
  captureWishToJournal,
  delegateWish,
  dispatchWishHeadlessly,
  grantWish,
  openWishes,
  printList,
  reviewWish,
  runCapturedWish,
  sweepWishes,
  waitingOperatorWishes,
};
