'use strict';

const fs = require('fs');
const path = require('path');
const { getLogPath, ensureLogDirectory, createLogFile, addInboxIdea } = require('./file-ops');
const { resolveFunctionalOwner } = require('./functional-owner');
const { buildMissionRoom, writeMissionRoomReceipt } = require('./mission-room');
const { delegateTask } = require('../commands/task');
const { startMission, listMissions, pingMission } = require('../commands/mission');
const {
  appendWishRecord,
  eventAnswers,
  improveWishes,
  latestWishEventMap,
  nextWishNumber,
  readJsonLines,
  readWishEvents,
  readWishes,
  stampIso,
  wishId,
  wishLessonsBrief,
} = require('./wish-store');
const {
  recordMatchesRef,
  shortRecordLabel,
  shortRecordRef,
} = require('./short-name');
const {
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

const METRIC_OPS = { '>=': '--gte', '<=': '--lte', '==': '--eq', '>': '--gt', '<': '--lt' };
const METRIC_VERIFY_ROOT = '/Users/keshavrao/arena/atrisos-backend';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const IMPLICIT_ANSWER_STALE_MS = HOUR_MS;
const WISH_LIST_RECENT_DAYS = 7;
const REVIEW_WORD_SCORES = new Map([
  ['great', 5],
  ['love it', 5],
  ['perfect', 5],
  ['good', 4],
  ['nice', 4],
  ['fine', 3],
  ['ok', 3],
  ['meh', 3],
  ['weak', 2],
  ['bad', 1],
  ['wrong', 1],
]);

// "stripe.active_subs>=10" -> { metric, op, target, flag, expression }.
function parseMetricExpression(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) {
    return { ok: false, message: `Invalid --metric "${raw}": expected <metric><op><number> with op one of >=, >, <=, <, == (example: stripe.active_subs>=10).` };
  }
  const [, metric, op, target] = match;
  return { ok: true, expression: `${metric}${op}${target}`, metric, op, target, flag: METRIC_OPS[op] };
}

// Wire to backend/scripts/metric_verify.py: exits 0 when the metric meets
// target and prints a JSON line with value + proof_uri.
function metricVerifierCommand(parsed) {
  return `cd ${METRIC_VERIFY_ROOT} && venv/bin/python backend/scripts/metric_verify.py ${parsed.metric} ${parsed.flag} ${parsed.target}`;
}

const MISSION_TERMINAL_STATUSES = new Set(['complete', 'stopped']);
const WISH_CLOSED_FOR_STEER = new Set(['complete', 'completed', 'captured_no_mission']);

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

// "#8 haiku loop" -> "#8: haiku loop" so replies read like a person naming the wish.
function wishTitle(wish) {
  return wishLabel(wish).replace(/^(#\d+)\s+/, '$1: ');
}

// One question at a time, always ending with how to answer it.
function printQuestion(wish, question) {
  console.log(`Got it, wish ${wishTitle(wish)}.`);
  console.log(String(question || 'What should be different when this wish comes true?'));
  console.log('Answer with: atris wish answer "your words"');
}

function printGranted(text, audit, options = {}) {
  const verifyPlan = options.verifyPlan || deriveVerifyPlan(text);
  const title = options.wish ? wishTitle(options.wish) : quoteText(text);
  console.log(`Got it, wish ${title}. I'm on it.`);
  if (verifyPlan.status === 'needs-review') console.log('I will show you the result to judge.');
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

// Everything the operator sees maps to five plain words:
// working / done / stuck / waiting on you / new. Storage values stay unchanged.
function operatorStatus(wish, root = process.cwd()) {
  const status = String(wish.status || '');
  if (WAITING_INPUT_STATUSES.has(status)) return 'waiting on you';
  if (status === 'builder') return 'waiting on you';
  if (status === 'complete' || status === 'completed') return 'done';
  if (status === 'delegated' || status === 'decomposed') {
    const missionStatus = latestMissionStatus(root, wish.mission_id);
    if (missionStatus === 'complete') return 'done';
    if (missionStatus === 'stopped' || missionStatus === 'blocked') return 'stuck';
    if (missionStatus === 'paused' || missionStatus === 'ready') return 'waiting on you';
    if (missionStatus) return 'working';
    if (Array.isArray(wish.out_of_scope_parts) && wish.out_of_scope_parts.length) return 'stuck';
    return 'working';
  }
  return 'new';
}

function reviewedMarker(wish) {
  return wish && (wish.reviewed || (Array.isArray(wish.reviews) && wish.reviews.length)) ? ' [reviewed]' : '';
}

function wishHasReview(wish) {
  return !!(wish && (wish.reviewed || (Array.isArray(wish.reviews) && wish.reviews.length)));
}

function wishLabel(wish) {
  return shortRecordLabel(wish, wish && (wish.text || wish.task_text || wish.id));
}

function wishRef(wish) {
  return shortRecordRef(wish);
}

function wishMatchesRef(wish, ref) {
  return recordMatchesRef(wish, ref);
}

function answerWishMatchesRef(wish, ref) {
  if (wishMatchesRef(wish, ref)) return true;
  return !!(wish && wish._answer_parent && wishMatchesRef(wish._answer_parent, ref));
}

function openWishes(root = process.cwd()) {
  return readWishes(root).filter((wish) => ['needs_input', 'waiting_input', 'delegated', 'decomposed', 'complete', 'builder', 'captured', 'captured_no_mission'].includes(String(wish.status || '')));
}

function parseWishTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function latestWishMoveTime(wish) {
  const times = [
    wish && wish.updated_at,
    wish && wish.completed_at,
    wish && wish.verified_at,
    wish && wish.dispatched_at,
    wish && wish.ts,
    wish && wish.first_ts,
    wish && wish.latest_review && wish.latest_review.ts,
    wish && wish.latest_steer && wish.latest_steer.ts,
  ].map(parseWishTime).filter((time) => time !== null);
  return times.length ? Math.max(...times) : null;
}

function shippedWish(wish, root = process.cwd()) {
  if (!wish || !wish.id) return false;
  const status = String(wish.status || '').trim();
  const verifyStatus = String(wish.verify_status || '').trim();
  if (status === 'complete' || status === 'completed') return true;
  if (['verified', 'passed', 'success'].includes(verifyStatus)) return true;
  return status === 'delegated' && latestMissionStatus(root, wish.mission_id) === 'complete';
}

function shippedWishTime(wish) {
  const status = String(wish && wish.status || '').trim();
  const verifyStatus = String(wish && wish.verify_status || '').trim();
  const fields = status === 'complete' || status === 'completed'
    ? ['completed_at', 'updated_at', 'ts', 'verified_at', 'dispatched_at', 'first_ts']
    : (['verified', 'passed', 'success'].includes(verifyStatus)
      ? ['verified_at', 'updated_at', 'ts', 'completed_at', 'dispatched_at', 'first_ts']
      : ['completed_at', 'verified_at', 'updated_at', 'ts', 'dispatched_at', 'first_ts']);
  return fields.map((field) => parseWishTime(wish && wish[field])).find((time) => time !== null) ?? null;
}

function staleUnreviewedShippedWish(wish, root = process.cwd(), now = Date.now()) {
  if (!shippedWish(wish, root) || wishHasReview(wish)) return false;
  const shippedAt = shippedWishTime(wish);
  return shippedAt !== null && now - shippedAt >= DAY_MS;
}

function listStatus(wish, root = process.cwd(), now = Date.now()) {
  if (staleUnreviewedShippedWish(wish, root, now)) return 'done, unreviewed';
  return operatorStatus(wish, root);
}

function listedWishes(root = process.cwd(), options = {}) {
  const all = options.all === true;
  const wishes = openWishes(root);
  if (all) return { visible: wishes, resting: [] };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const cutoff = now - (WISH_LIST_RECENT_DAYS * DAY_MS);
  const visible = [];
  const resting = [];
  wishes.forEach((wish) => {
    const status = operatorStatus(wish, root);
    const movedAt = latestWishMoveTime(wish);
    if (status === 'working' || status === 'waiting on you' || (movedAt !== null && movedAt >= cutoff)) {
      visible.push(wish);
    } else {
      resting.push(wish);
    }
  });
  return { visible, resting };
}

function printList(root = process.cwd(), options = {}) {
  const { visible, resting } = listedWishes(root, options);
  const total = visible.length + resting.length;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!total) {
    console.log('No open wishes.');
    return 0;
  }
  visible.forEach((wish, index) => {
    console.log(`${index + 1}. ${wishLabel(wish)} - ${listStatus(wish, root, now)}${reviewedMarker(wish)}`);
  });
  if (resting.length) {
    console.log(`${resting.length} older ${resting.length === 1 ? 'wish is' : 'wishes are'} resting. See them with atris wish list --all`);
  }
  return 0;
}

function actorName() {
  return process.env.ATRIS_AGENT_ID || process.env.USER || 'operator';
}

function shortText(value, width = 52) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= width) return text;
  return text.slice(0, Math.max(0, width - 3)).trimEnd() + '...';
}

function renderAlignedTable(headers, rows) {
  const widths = headers.map((header, index) => {
    const rowWidth = rows.reduce((max, row) => Math.max(max, String(row[index] || '').length), 0);
    return Math.max(String(header).length, rowWidth);
  });
  const renderRow = (row) => row.map((cell, index) => String(cell || '').padEnd(widths[index])).join('  ').trimEnd();
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  return [renderRow(headers), separator, ...rows.map(renderRow)].join('\n');
}

function latestReview(wish) {
  if (wish && wish.latest_review) return wish.latest_review;
  const reviews = Array.isArray(wish && wish.reviews) ? wish.reviews : [];
  return reviews.length ? reviews[reviews.length - 1] : null;
}

function reviewColumn(wish) {
  const review = latestReview(wish);
  if (!review) return '-';
  const score = review.review_score === undefined || review.review_score === null ? 'n/a' : String(review.review_score);
  return `reviewed/${score}`;
}

function printBoard(root = process.cwd()) {
  const wishes = readWishes(root);
  if (!wishes.length) {
    console.log('No wishes.');
    return 0;
  }
  const rows = wishes.map((wish) => [
    wishLabel(wish),
    shortText(wish.text || wish.task_text || ''),
    operatorStatus(wish, root),
    wish.engine || wish.requested_engine || '-',
    wish.verify_status || '-',
    reviewColumn(wish),
  ]);
  console.log(renderAlignedTable(['wish', 'text', 'status', 'engine', 'verify_status', 'review'], rows));
  return 0;
}

function reviewNudgeWishes(root = process.cwd()) {
  return readWishes(root).filter((wish) => {
    if (!wish || !wish.id) return false;
    if (wishHasReview(wish)) return false;
    if (!shippedWish(wish, root)) return false;
    return !staleUnreviewedShippedWish(wish, root);
  });
}

function printReviewNudges(root = process.cwd()) {
  const wishes = reviewNudgeWishes(root);
  if (!wishes.length) return 0;
  console.log('Wishes ready for review:');
  wishes.forEach((wish) => {
    console.log(`- ${wishLabel(wish)}: atris wish review ${wishRef(wish)} "<one sentence>"`);
  });
  return 0;
}

function scorecardText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readWishReviewRewardRows(root = process.cwd()) {
  const file = path.resolve(root, '..', 'atrisos-backend', '.atris', 'state', 'scorecards.jsonl');
  return readJsonLines(file).filter((row) => {
    const haystack = `${scorecardText(row.source)} ${scorecardText(row.feedback)}`;
    return /wish_review/i.test(haystack);
  });
}

function averageReviewScore(reviews) {
  const scores = reviews
    .filter((review) => review.review_score !== undefined && review.review_score !== null && String(review.review_score).trim() !== '')
    .map((review) => Number(review.review_score))
    .filter((score) => Number.isFinite(score));
  if (!scores.length) return 'n/a';
  const value = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function reviewLine(review) {
  const score = review.review_score === undefined || review.review_score === null ? 'n/a' : String(review.review_score);
  const day = String(review.ts || '').slice(0, 10) || 'unknown-date';
  return `${day} score=${score} ${review.wish_id || 'unknown'} ${shortText(review.review_text || '', 80)}`.trim();
}

function printRewards(root = process.cwd()) {
  const reviews = readWishEvents(root).filter((event) => event && event.kind === 'review');
  const rewardRows = readWishReviewRewardRows(root);
  console.log(`reviews count: ${reviews.length}`);
  console.log(`avg score: ${averageReviewScore(reviews)}`);
  console.log('last 5 review lines:');
  const lastFive = reviews.slice(-5);
  if (!lastFive.length) console.log('- none');
  else lastFive.forEach((review) => console.log(`- ${reviewLine(review)}`));
  console.log(`reward rows found: ${rewardRows.length}`);
  return 0;
}

function reviewableWish(wish) {
  const status = String(wish && wish.status || '').trim();
  // decomposed = split into delegated part-missions; work is in flight or
  // landed, so it is as reviewable as a directly delegated wish.
  return status === 'delegated' || status === 'decomposed' || status === 'complete' || status === 'completed';
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

function reviewWordKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function reviewWordScore(value) {
  const key = reviewWordKey(value);
  return REVIEW_WORD_SCORES.has(key) ? REVIEW_WORD_SCORES.get(key) : null;
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
  const wish = wishes.find((row) => wishMatchesRef(row, ref));
  if (!wish) return { ok: false, message: `No wish found with id ${ref}.` };
  return { ok: true, wish };
}

function wishSteerTime(wish, fallback) {
  const parsed = Date.parse(
    wish.updated_at
      || (wish.latest_steer && wish.latest_steer.ts)
      || wish.dispatched_at
      || wish.ts
      || wish.first_ts
      || '',
  );
  return Number.isFinite(parsed) ? parsed : fallback;
}

function steerableWish(wish, root = process.cwd()) {
  if (!wish || !wish.id) return false;
  const status = String(wish.status || '').trim();
  if (WISH_CLOSED_FOR_STEER.has(status)) return false;
  const missionStatus = latestMissionStatus(root, wish.mission_id);
  return !MISSION_TERMINAL_STATUSES.has(missionStatus);
}

function latestSteerableWish(wishes, root = process.cwd()) {
  let latest = null;
  let latestTime = -Infinity;
  wishes.forEach((wish, index) => {
    if (!steerableWish(wish, root)) return;
    const time = wishSteerTime(wish, index);
    if (time >= latestTime) {
      latest = wish;
      latestTime = time;
    }
  });
  return latest;
}

function resolveSteerTarget(root, ref) {
  const wishes = readWishes(root);
  if (!wishes.length) {
    return { ok: false, message: 'No wishes to steer yet.' };
  }
  if (!ref || ref === 'latest') {
    const latest = latestSteerableWish(wishes, root);
    if (!latest) return { ok: false, message: 'No open wishes to steer.' };
    return { ok: true, wish: latest };
  }
  const wish = wishes.find((row) => wishMatchesRef(row, ref));
  if (!wish) return { ok: false, message: `No wish found with id ${ref}.` };
  return { ok: true, wish };
}

function liveLinkedMission(root, missionId) {
  if (!missionId) return null;
  try {
    const mission = listMissions(root).find((row) => row.id === missionId);
    if (!mission || MISSION_TERMINAL_STATUSES.has(String(mission.status || ''))) return null;
    return mission;
  } catch {
    return null;
  }
}

function deliverSteerToMission(wish, note, root, from) {
  const mission = liveLinkedMission(root, wish.mission_id);
  if (!mission) return null;
  return withRoot(root, () => pingMission([mission.id, note, '--from', from], { silent: true }));
}

function sayWish(positionals, root = process.cwd()) {
  const parts = positionals.slice(1).map(String).filter((value) => value.trim());
  if (!parts.length) {
    console.error('wish say needs a note.');
    return 2;
  }
  const wishes = readWishes(root);
  const isKnownRef = (value) => value === 'latest' || wishes.some((wish) => wishMatchesRef(wish, value)) || looksLikeWishId(value);
  let targetRef = 'latest';
  let noteParts = parts;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (parts.length > 1 && isKnownRef(last)) {
    targetRef = last;
    noteParts = parts.slice(0, -1);
  } else if (parts.length > 1 && isKnownRef(first)) {
    targetRef = first;
    noteParts = parts.slice(1);
  }
  const note = noteParts.join(' ').trim();
  if (!note) {
    console.error('wish say needs a note.');
    return 2;
  }
  const target = resolveSteerTarget(root, targetRef);
  if (!target.ok) {
    console.error(target.message);
    return 2;
  }
  const from = actorName();
  appendWishRecord(root, {
    kind: 'steer',
    wish_id: target.wish.id,
    ts: stampIso(),
    note,
    steered_by: from,
    mission_id: target.wish.mission_id || null,
  });
  const mission = deliverSteerToMission(target.wish, note, root, from);
  const suffix = mission ? ` and sent to ${mission.id}` : '';
  console.log(`Steering captured for ${quoteText(target.wish.text || target.wish.id)}${suffix}.`);
  return 0;
}

function reviewWish(positionals, root = process.cwd(), options = {}) {
  const score = { ok: true, value: options.reviewScore === undefined ? null : options.reviewScore };
  const parts = positionals.slice(1).map(String).filter((value) => value.trim());
  if (!parts.length) {
    console.error('wish review needs one sentence of feedback.');
    return 2;
  }
  let targetRef = 'latest';
  let reviewParts = parts;
  const first = parts[0];
  const wishes = readWishes(root);
  if (first === 'latest' || /^\#?\d+$/.test(first) || looksLikeWishId(first) || wishes.some((wish) => wishMatchesRef(wish, first))) {
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
    review_score: score.value === null ? reviewWordScore(reviewText) : score.value,
    reviewed_by: actorName(),
  });
  console.log(`Review captured for ${quoteText(target.wish.text || target.wish.id)}.`);
  return 0;
}

function startWishDelegation(wish, audit, root, options = {}) {
  try {
    improveWishes(root, { quiet: true });
  } catch {
    // best-effort: lessons ingest must never block a wish run
  }
  const taskText = String(options.taskText || wish.text);
  const recordText = String(options.recordText || wish.text);
  const metricOption = options.metric && options.metric.ok
    ? options.metric
    : (wish.metric ? parseMetricExpression(wish.metric) : null);
  const metricPlan = metricOption && metricOption.ok ? metricOption : null;
  const verifyPlan = metricPlan
    ? { command: metricVerifierCommand(metricPlan), outcome: `metric ${metricPlan.expression} is met`, status: 'metric' }
    : (options.verifyPlan || deriveVerifyPlan(taskText));
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
      parent_id: wish.parent_id || null,
    },
    source: {
      ...(baseRoom.source || {}),
      wish_id: wish.id,
      wish_text: recordText,
      wish_parent_id: wish.parent_id || null,
    },
  };
  const writtenRoom = writeMissionRoomReceipt(room, { root });
  const routeOwner = writtenRoom.room?.member_route?.suggested_member
    || writtenRoom.room?.owner
    || ownerResolution.owner
    || 'mission-lead';
  const note = [
    `Wish: ${taskText}`,
    `Wish label: ${wishLabel(wish)}`,
    `Mission Room: ${writtenRoom.relativePath}`,
    verifyPlan.command
      ? `Verify: ${verifyPlan.command} (${verifyOutcomeText(verifyPlan)})`
      : `Verify: needs human review (${verifyPlan.outcome})`,
    `Budget: ${audit.budget}`,
  ];
  let lessonsBlock = '';
  try {
    lessonsBlock = wishLessonsBrief(root);
  } catch {
    lessonsBlock = '';
  }
  if (lessonsBlock) note.push('', lessonsBlock);
  const noteText = note.join('\n');
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
      noteText,
    ], { warnOperatorTitle: false });
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
    else missionArgs.push('--no-verify');
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
          ...(metricPlan ? { stop_condition: 'verifier green (metric target hit)' } : {}),
          metadata: {
            wish_id: wish.id,
            wish_text: recordText,
            ...(metricPlan ? { metric: metricPlan.expression } : {}),
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
    parent_id: wish.parent_id || undefined,
    dispatched_at: now,
    task_id: taskPayload.task_id,
    mission_id: mission ? mission.id : null,
    engine,
    validator: audit.validator.id,
    budget: audit.budget,
    ...(metricPlan ? { metric: metricPlan.expression } : {}),
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
  else printGranted(options.taskText || wish.text, audit, { ...options, verifyPlan, engine: record.engine, wish });
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
    parent_id: wish.parent_id || undefined,
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
    console.log(`Got it, wish ${wishTitle(wish)}.`);
    console.log('Saved it. I will not start work until you say so.');
  }
  return 0;
}

function builderBlockingQuestions(audit) {
  return (Array.isArray(audit && audit.questions) ? audit.questions : [])
    .filter((question) => !/^Which working (builder|reviewer) should /i.test(String(question || '').trim()));
}

function builderSlice(text, audit, verifyPlan) {
  const exitCriteria = verifyPlan.status === 'derived'
    ? verifyOutcomeText(verifyPlan)
    : 'caller confirms the outcome is done';
  return {
    outcome: String(text || '').trim(),
    exit_criteria: exitCriteria,
    verify: verifyPlan.command || '<add verify command>',
    budget: audit ? audit.budget : inferBudgetTier(text),
  };
}

function printBuilderSlice(wish, slice) {
  console.log(`Builder wish: ${quoteText(wish.text)}`);
  console.log(`Outcome: ${slice.outcome}`);
  console.log(`Exit criteria: ${slice.exit_criteria}.`);
  console.log(`Verify: ${slice.verify}`);
}

function builderWish(wish, audit, root, asJson) {
  const questions = builderBlockingQuestions(audit);
  if (questions.length) return askForInput(wish, { ...audit, questions }, root, asJson, { mode: 'builder' });
  const verifyPlan = deriveVerifyPlan(wish.text);
  const slice = builderSlice(wish.text, audit, verifyPlan);
  appendWishRecord(root, {
    id: wish.id,
    ts: stampIso(),
    text: wish.text,
    status: 'builder',
    mode: 'builder',
    parent_id: wish.parent_id || undefined,
    engine: null,
    validator: audit && audit.validator ? audit.validator.id : null,
    budget: slice.budget,
    verify: verifyPlan.command,
    verify_status: verifyPlan.status,
    verify_outcome: verifyPlan.outcome,
    builder_slice: slice,
    questions: audit ? audit.questions : [],
    ...engineAuditFields(audit),
  });
  if (asJson) {
    console.log(JSON.stringify({
      wish_id: wish.id,
      status: 'builder',
      mode: 'builder',
      task_id: null,
      mission_id: null,
      engine: null,
      budget: slice.budget,
      questions: [],
      verify: verifyPlan.command,
      verify_status: verifyPlan.status,
      slice,
    }, null, 2));
  } else {
    printBuilderSlice(wish, slice);
  }
  return 0;
}

// Plain per-part reply: what started, what lives elsewhere, and one question per unclear part.
function printDecomposed(wish, parts, delegatedParts, waitingParts) {
  console.log(`Got it, wish ${wishTitle(wish)}. It has ${parts.length} parts.`);
  delegatedParts.forEach((part) => {
    console.log(`Starting now: ${part.text}.`);
  });
  const ownHome = waitingParts.filter((part) => part.reason && /not in this checkout/.test(part.reason));
  const unclear = waitingParts.filter((part) => !ownHome.includes(part));
  ownHome.forEach((part) => {
    console.log(`This part lives somewhere else, so I cannot do it from here: ${part.text}.`);
  });
  unclear.forEach((part) => {
    const question = (Array.isArray(part.questions) && part.questions[0])
      || part.reason
      || 'What should be different when this part comes true?';
    console.log(`One question about "${part.text}": ${question}`);
  });
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
    parent_id: wish.parent_id || undefined,
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
  else printDecomposed(wish, parts, delegatedParts, waitingParts);
  return delegatedParts.length ? 0 : 1;
}

function askForInput(wish, audit, root, asJson, extra = {}) {
  appendNeedsInputRecord(wish, audit, root, extra);
  const payload = machineRecord(wish, 'needs_input', audit);
  if (extra.mode) payload.mode = extra.mode;
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else printQuestion(wish, audit.questions[0]);
  return 1;
}

function appendNeedsInputRecord(wish, audit, root, extra = {}) {
  appendWishRecord(root, {
    id: wish.id,
    ts: stampIso(),
    text: wish.text,
    status: 'needs_input',
    parent_id: wish.parent_id || undefined,
    questions: audit.questions,
    vague: !!audit.vague,
    missing_slots: audit.missing_slots || [],
    ...extra,
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

function waitingPartQuestion(part) {
  const questions = Array.isArray(part && part.questions) ? part.questions : [];
  return questions
    .map((question) => String(question || '').trim())
    .find(Boolean)
    || String((part && (part.question || part.reason)) || '').trim();
}

function waitingPartQuestionTs(parent, part) {
  return String((part && (part.question_ts || part.asked_at || part.ts))
    || (parent && (parent.question_ts || parent.asked_at || parent.ts))
    || '').trim();
}

function firstAnswerableWaitingPart(wish) {
  if (!wish || String(wish.status || '') !== 'decomposed') return null;
  const waitingParts = Array.isArray(wish.waiting_parts) ? wish.waiting_parts : [];
  return waitingParts.find((part) => part
    && String(part.text || '').trim()
    && waitingPartQuestion(part));
}

function decomposedPartWishId(parent, part) {
  const explicit = String((part && (part.wish_id || part.id || part.child_wish_id)) || '').trim();
  if (explicit) return explicit;
  const parentId = String((parent && parent.id) || 'wish').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  const partNumber = Number(part && part.part);
  const suffix = Number.isInteger(partNumber) && partNumber > 0 ? String(partNumber) : 'waiting';
  return `${parentId || 'wish'}-part-${suffix}`;
}

function decomposedAnswerTarget(wish, root) {
  const part = firstAnswerableWaitingPart(wish);
  if (!part) return null;
  const text = String(part.text || '').trim();
  const id = decomposedPartWishId(wish, part);
  const existing = readWishes(root).find((row) => row && row.id === id);
  const question = waitingPartQuestion(part);
  return {
    id,
    n: existing && existing.n ? existing.n : nextWishNumber(root),
    ts: waitingPartQuestionTs(wish, part) || wish.ts,
    text,
    status: 'needs_input',
    parent_id: wish.id,
    decomposed_part: part.part,
    questions: [question],
    answers: existing && Array.isArray(existing.answers) ? existing.answers : [],
    _answer_parent: wish,
    _answer_waiting_part: part,
    _answer_question_ts: waitingPartQuestionTs(wish, part) || wish.ts,
  };
}

function answerQuestionTs(wish) {
  return String((wish && wish._answer_question_ts) || (wish && wish.question_ts) || (wish && wish.asked_at) || (wish && wish.ts) || '').trim();
}

function answerQuestionAgeMs(wish, now = Date.now()) {
  const parsed = Date.parse(answerQuestionTs(wish));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, now - parsed);
}

function answerStaleNotice(wish, now = Date.now()) {
  const ageMs = answerQuestionAgeMs(wish, now);
  if (ageMs <= IMPLICIT_ANSWER_STALE_MS) return '';
  const displayWish = (wish && wish._answer_parent) || wish;
  const number = Number(displayWish && displayWish.n);
  const ref = Number.isInteger(number) && number > 0 ? `#${number}` : wishRef(displayWish);
  const label = wishLabel(displayWish).replace(/^#\d+\s*/, '').trim();
  const hours = Math.max(1, Math.floor(ageMs / HOUR_MS));
  return `The wish waiting on you is ${ref}${label ? ` ${label}` : ''}, asked ${hours} hours ago. If you mean that one, say: atris wish answer ${ref} "your words"`;
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
  const builderMode = String(options.asMode || '').trim() === 'builder';
  let engineOverride = '';
  try {
    engineOverride = validateEngineOverride(options.engineOverride, root);
  } catch (error) {
    console.error(error.message || String(error));
    return 2;
  }
  const ts = options.ts || stampIso();
  const wish = {
    id: options.wishId || wishId(text, ts),
    n: nextWishNumber(root),
    ts,
    text,
    status: 'captured',
  };
  if (options.parentId) wish.parent_id = String(options.parentId);
  if (engineOverride) wish.requested_engine = engineOverride;
  if (options.metric && options.metric.ok) wish.metric = options.metric.expression;
  captureWishToJournal(text, root);
  appendWishRecord(root, wish);
  if (typeof options.afterCapture === 'function') options.afterCapture(wish);
  const audit = auditWish(text, root, { engineOverride });
  if (builderMode) return builderWish(wish, audit, root, asJson);
  const parts = analyzeWishParts(text, root);
  if (parts && noMission) return captureOnlyWish(wish, null, root, asJson);
  if (parts) return decomposeWish(wish, parts, root, asJson, { engineOverride });
  if (!audit.ok) return askForInput(wish, audit, root, asJson);
  if (noMission) return captureOnlyWish(wish, audit, root, asJson);
  return delegateWish(wish, audit, root, asJson, options.metric ? { metric: options.metric } : {});
}

function inheritedEngineOverride(parent, explicitEngineOverride = '') {
  const explicit = String(explicitEngineOverride || '').trim();
  if (explicit) return explicit;
  return String(parent && (parent.requested_engine || parent.engine_override) || '').trim();
}

function runAgainWish(positionals, root = process.cwd(), options = {}) {
  const parentId = String(positionals[1] || '').trim();
  const text = positionals.slice(2).join(' ').trim();
  if (!parentId || !text) {
    console.error('wish again needs a parent id and tweak text.');
    return 2;
  }
  const parent = readWishes(root).find((wish) => wishMatchesRef(wish, parentId));
  if (!parent) {
    console.error(`No wish found with id ${parentId}.`);
    return 2;
  }
  const ts = stampIso();
  const nextId = wishId(text, ts);
  const engineOverride = inheritedEngineOverride(parent, options.engineOverride);
  const afterCapture = options.asJson
    ? null
    : () => console.log(`Created follow-up wish ${nextId} from ${parent.id}.`);
  return runCapturedWish(text, root, {
    ...options,
    ts,
    wishId: nextId,
    parentId: parent.id,
    engineOverride,
    afterCapture,
  });
}

// Record the answer against the wish, then dispatch it or ask the next single question.
function applyAnswer(wish, answer, root, options = {}) {
  const asJson = !!options.asJson;
  const noMission = !!options.noMission;
  let engineOverride = '';
  try {
    engineOverride = validateEngineOverride(options.engineOverride, root);
  } catch (error) {
    console.error(error.message || String(error));
    return 2;
  }
  appendWishRecord(root, {
    id: wish.id,
    n: wish.n || undefined,
    ts: stampIso(),
    text: wish.text,
    status: 'needs_input',
    parent_id: wish.parent_id || undefined,
    decomposed_part: wish.decomposed_part || undefined,
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
  return delegateWish(answeredWish, audit, root, asJson, {});
}

function sameWaitingPart(left, right) {
  if (!left || !right) return false;
  const leftPart = Number(left.part);
  const rightPart = Number(right.part);
  if (Number.isInteger(leftPart) && Number.isInteger(rightPart) && leftPart === rightPart) return true;
  return String(left.text || '').trim() === String(right.text || '').trim();
}

function markDecomposedPartAnswered(parent, part, child, root) {
  const now = stampIso();
  const questionTs = waitingPartQuestionTs(parent, part);
  const waitingParts = Array.isArray(parent.waiting_parts) ? parent.waiting_parts : [];
  const remainingWaitingParts = waitingParts
    .filter((waitingPart) => !sameWaitingPart(waitingPart, part))
    .map((waitingPart) => {
      const ts = waitingPartQuestionTs(parent, waitingPart);
      return ts ? { ...waitingPart, question_ts: ts } : waitingPart;
    });
  const answeredPart = {
    ...part,
    status: 'answered',
    child_wish_id: child.id,
    answered_at: now,
    ...(questionTs ? { question_ts: questionTs } : {}),
  };
  const parts = Array.isArray(parent.parts)
    ? parent.parts.map((row) => (sameWaitingPart(row, part)
      ? { ...row, status: 'answered', child_wish_id: child.id }
      : row))
    : undefined;
  appendWishRecord(root, {
    id: parent.id,
    n: parent.n || undefined,
    ts: now,
    text: parent.text,
    status: 'decomposed',
    parent_id: parent.parent_id || undefined,
    task_id: parent.task_id || null,
    mission_id: parent.mission_id || null,
    engine: parent.engine || null,
    validator: parent.validator || null,
    budget: parent.budget || inferBudgetTier(parent.text),
    ...(parts ? { parts } : {}),
    delegated_parts: Array.isArray(parent.delegated_parts) ? parent.delegated_parts : [],
    out_of_scope_parts: Array.isArray(parent.out_of_scope_parts) ? parent.out_of_scope_parts : [],
    waiting_parts: remainingWaitingParts,
    answered_parts: [...(Array.isArray(parent.answered_parts) ? parent.answered_parts : []), answeredPart],
  });
}

function applySelectedAnswer(wish, answer, root, options = {}) {
  if (wish && wish._answer_parent && wish._answer_waiting_part) {
    const child = {
      id: wish.id,
      n: wish.n,
      ts: stampIso(),
      text: wish.text,
      status: 'needs_input',
      parent_id: wish._answer_parent.id,
      decomposed_part: wish._answer_waiting_part.part,
      questions: wish.questions,
      answers: wish.answers,
    };
    const code = applyAnswer(child, answer, root, options);
    if (code !== 2) markDecomposedPartAnswered(wish._answer_parent, wish._answer_waiting_part, child, root);
    return code;
  }
  return applyAnswer(wish, answer, root, options);
}

function waitingAnswerWishes(root = process.cwd()) {
  const waiting = [];
  for (const wish of readWishes(root)) {
    if (!wish || !wish.id) continue;
    if (WAITING_INPUT_STATUSES.has(String(wish.status || '')) && !wish.dispatched_at) {
      waiting.push({
        ...wish,
        _answer_question_ts: answerQuestionTs(wish),
      });
      continue;
    }
    const decomposed = decomposedAnswerTarget(wish, root);
    if (decomposed) waiting.push(decomposed);
  }
  return waiting;
}

// Only #n and wish ids count as explicit targets here. Bare numbers stay part of
// the answer text so "3 login screens" never lands on the wrong wish.
function explicitAnswerRef(value) {
  const text = String(value || '').trim();
  return /^#\d+$/.test(text) || looksLikeWishId(text);
}

// atris wish answer "your words" — answers the pending question of the wish
// that is waiting on you, no list numbers involved.
function answerWish(positionals, root = process.cwd(), options = {}) {
  const parts = positionals.slice(1).map(String).filter((value) => value.trim());
  if (!parts.length) {
    console.error('wish answer needs your answer in plain words.');
    return 2;
  }
  const waiting = waitingAnswerWishes(root);
  if (!waiting.length) {
    console.error('No wish is waiting on an answer.');
    return 2;
  }
  let wish = null;
  let answerParts = parts;
  let hasExplicitRef = false;
  if (parts.length > 1 && explicitAnswerRef(parts[0])) {
    hasExplicitRef = true;
    wish = waiting.find((row) => answerWishMatchesRef(row, parts[0]));
    if (!wish) {
      console.error(`No wish waiting on an answer matches ${parts[0]}.`);
      return 2;
    }
    answerParts = parts.slice(1);
  }
  if (!wish) {
    wish = waiting.reduce((latest, row) => (String(answerQuestionTs(row)) >= String(answerQuestionTs(latest)) ? row : latest), waiting[0]);
  }
  const answer = answerParts.join(' ').trim();
  if (!answer) {
    console.error('wish answer needs your answer in plain words.');
    return 2;
  }
  if (!hasExplicitRef) {
    const notice = answerStaleNotice(wish);
    if (notice) {
      console.error(notice);
      return 2;
    }
  }
  return applySelectedAnswer(wish, answer, root, options);
}

function grantWish(positionals, root = process.cwd(), options = {}) {
  const asJson = !!options.asJson;
  const number = Number(positionals[1]);
  const answer = positionals.slice(2).join(' ').trim();
  if (!Number.isInteger(number) || number <= 0 || !answer) {
    console.error('wish grant needs a list number and an answer.');
    return 2;
  }
  const waiting = listedWishes(root).visible;
  const wish = waiting[number - 1];
  if (!wish) {
    console.error('No wish is waiting at that number.');
    return 2;
  }
  if (!WAITING_INPUT_STATUSES.has(String(wish.status || ''))) {
    console.error('That wish is not waiting on an answer.');
    return 2;
  }
  const vagueFlagged = wish.vague === true
    || (Array.isArray(wish.missing_slots) && wish.missing_slots.length > 0)
    || (Array.isArray(wish.questions) && wish.questions.some((question) => /\b(different|outcome|Who is|What part)\b/i.test(String(question))));
  if (vagueFlagged && !sharesMeaningfulWords(wish.text, answer)) {
    const notice = 'This answer may be for a different wish, so I did not start it.';
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
      console.log(`That answer sounds like a different wish, so I did not start wish ${wishTitle(wish)}.`);
      printList(root);
    }
    return 1;
  }
  return applyAnswer(wish, answer, root, options);
}

module.exports = {
  REVIEW_WORD_SCORES,
  answerWish,
  appendDelegatedWishRecord,
  appendNeedsInputRecord,
  askForInput,
  captureOnlyWish,
  captureWishToJournal,
  delegateWish,
  dispatchWishHeadlessly,
  grantWish,
  metricVerifierCommand,
  listedWishes,
  openWishes,
  parseMetricExpression,
  printBoard,
  printList,
  printReviewNudges,
  printRewards,
  reviewNudgeWishes,
  reviewWordScore,
  reviewWish,
  runAgainWish,
  runCapturedWish,
  sayWish,
  sweepWishes,
  waitingOperatorWishes,
};
