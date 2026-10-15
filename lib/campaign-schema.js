// Campaign schema: the struct, event types, and actions shared by every
// surface (CLI, backend, desktop, web, terrace). Pure, no I/O.
//
// The fold rules that turn events into state live in
// test/fixtures/campaign/README.md, which is the cross-surface contract.
// Spec: atris/features/campaign/idea.md.

'use strict';

// idea.md "Events" list, plus two the spec's actions need but never named:
// add_budget writes budget_added, veto writes mission_vetoed.
const EVENT_TYPES = Object.freeze([
  'campaign_started', 'seat_filled', 'bet_set', 'attached',
  'mission_proposed', 'mission_claimed', 'mission_started', 'step', 'kept', 'reverted', 'mission_ended',
  'mission_vetoed',
  'judge_ran', 'ask_opened', 'ask_answered',
  'budget_reserved', 'budget_released', 'budget_added',
  'paused', 'resumed', 'stopped', 'home_moved', 'done',
]);

const ACTIONS = Object.freeze([
  'start', 'pause', 'resume', 'answer_ask', 'change_bet', 'add_budget', 'fill_seat', 'veto', 'stop',
]);

const CONFIDENCE = Object.freeze(['open', 'leaning', 'stronger', 'answered']);

const STATES = Object.freeze([
  'running', 'needs_you', 'resting', 'queued', 'done', 'out_of_budget', 'paused',
]);

const STOP_REASONS = Object.freeze(['judge_passed', 'stopped', 'done_by_human', 'budget_spent']);

const MISSION_OUTCOMES = Object.freeze(['kept', 'reverted', 'failed']);

// What a person or agent writes. Everything else is folded from events.
const CAMPAIGN_FIELDS = Object.freeze({
  title: { required: true, type: 'string' },
  judge: { required: true, type: 'string' },
  budget: { required: true, type: 'number' },
  owner: { required: false, type: 'string' },
  seats: { required: false, type: 'array' },
  bet: { required: false, type: 'string' },
  standing: { required: false, type: 'boolean' },
  parent: { required: false, type: 'string' },
});

const CAMPAIGN_ID = /^cmp-[a-z0-9][a-z0-9-]{0,63}$/;
const EVENT_ID = /^[\x21-\x7e]{1,128}$/;
const ORIGIN = /^[A-Za-z0-9._:-]{1,64}$/;
// RFC 3339 with a zone: no surface may read a timestamp in its own timezone.
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// A seat is "member" (role comes from the member's own job) or { member, role }.
function seatErrors(seats) {
  if (!Array.isArray(seats)) return ['seats_not_list'];
  const errors = [];
  for (const seat of seats) {
    if (nonEmpty(seat)) continue;
    if (isObject(seat) && nonEmpty(seat.member) && (seat.role === undefined || seat.role === null || nonEmpty(seat.role))) continue;
    errors.push('bad_seat');
  }
  return errors;
}

// record: the hand-written struct. options.lookup(id) returns another
// campaign record (or null) so the one-level nesting rule can be checked.
function validateCampaign(record, options = {}) {
  const errors = [];
  if (!isObject(record)) return { ok: false, errors: ['not_object'] };
  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(CAMPAIGN_FIELDS, key)) errors.push(`unknown_field:${key}`);
  }
  if (!nonEmpty(record.title)) errors.push('missing_title');
  if (!nonEmpty(record.judge)) errors.push('missing_judge');
  if (!positiveNumber(record.budget)) errors.push('bad_budget');
  if (record.owner !== undefined && !nonEmpty(record.owner)) errors.push('bad_owner');
  if (record.bet !== undefined && !nonEmpty(record.bet)) errors.push('bad_bet');
  if (record.standing !== undefined && typeof record.standing !== 'boolean') errors.push('bad_standing');
  if (record.seats !== undefined) errors.push(...seatErrors(record.seats));
  if (record.parent !== undefined) {
    if (!nonEmpty(record.parent)) {
      errors.push('bad_parent');
    } else if (typeof options.lookup === 'function') {
      const parent = options.lookup(record.parent);
      if (!parent) errors.push('unknown_parent');
      else if (parent.parent) errors.push('nested_parent');
    }
  }
  return { ok: errors.length === 0, errors };
}

// Fields each event type must carry in its data.
const EVENT_DATA_RULES = Object.freeze({
  campaign_started: (d) => [
    nonEmpty(d.title) ? null : 'missing_title',
    nonEmpty(d.judge) ? null : 'missing_judge',
    positiveNumber(d.budget) ? null : 'bad_budget',
    d.seats === undefined ? null : (seatErrors(d.seats)[0] || null),
    d.standing === undefined || typeof d.standing === 'boolean' ? null : 'bad_standing',
  ],
  seat_filled: (d) => [nonEmpty(d.member) ? null : 'missing_member', nonEmpty(d.role) ? null : 'missing_role'],
  bet_set: (d) => [nonEmpty(d.bet) ? null : 'missing_bet'],
  attached: (d) => [nonEmpty(d.parent_id) ? null : 'missing_parent_id'],
  mission_proposed: (d) => [nonEmpty(d.mission_id) ? null : 'missing_mission_id'],
  mission_claimed: (d) => [
    nonEmpty(d.mission_id) ? null : 'missing_mission_id',
    nonEmpty(d.claim_key) ? null : 'missing_claim_key',
  ],
  mission_started: (d) => [
    nonEmpty(d.mission_id) ? null : 'missing_mission_id',
    nonEmpty(d.member) ? null : 'missing_member',
  ],
  step: (d) => [nonEmpty(d.mission_id) ? null : 'missing_mission_id'],
  kept: (d) => [nonEmpty(d.mission_id) ? null : 'missing_mission_id'],
  reverted: (d) => [nonEmpty(d.mission_id) ? null : 'missing_mission_id'],
  // Every mission reports its cost (idea.md review rule 1).
  mission_ended: (d) => [
    nonEmpty(d.mission_id) ? null : 'missing_mission_id',
    MISSION_OUTCOMES.includes(d.outcome) ? null : 'bad_outcome',
    nonNegativeNumber(d.cost_usd) ? null : 'missing_cost',
  ],
  mission_vetoed: (d) => [nonEmpty(d.mission_id) ? null : 'missing_mission_id'],
  judge_ran: (d) => [
    typeof d.passed === 'boolean' ? null : 'missing_passed',
    d.reading === undefined || (typeof d.reading === 'number' && Number.isFinite(d.reading)) ? null : 'bad_reading',
    d.confidence === undefined || ['open', 'leaning', 'stronger'].includes(d.confidence) ? null : 'bad_confidence',
  ],
  ask_opened: (d) => [nonEmpty(d.ask_id) ? null : 'missing_ask_id', nonEmpty(d.question) ? null : 'missing_question'],
  ask_answered: (d) => [nonEmpty(d.ask_id) ? null : 'missing_ask_id', nonEmpty(d.answer) ? null : 'missing_answer'],
  budget_reserved: (d) => [
    nonEmpty(d.mission_id) ? null : 'missing_mission_id',
    positiveNumber(d.amount_usd) ? null : 'bad_amount',
  ],
  budget_released: (d) => [nonEmpty(d.mission_id) ? null : 'missing_mission_id'],
  budget_added: (d) => [positiveNumber(d.amount_usd) ? null : 'bad_amount'],
  paused: () => [],
  resumed: () => [],
  stopped: () => [],
  home_moved: (d) => [nonEmpty(d.to) ? null : 'missing_to'],
  done: () => [],
});

function validateEvent(event) {
  if (!isObject(event)) return { ok: false, errors: ['not_object'] };
  const errors = [];
  if (typeof event.id !== 'string' || !EVENT_ID.test(event.id)) errors.push('bad_id');
  if (typeof event.campaign_id !== 'string' || !CAMPAIGN_ID.test(event.campaign_id)) errors.push('bad_campaign_id');
  if (!EVENT_TYPES.includes(event.type)) errors.push('unknown_type');
  if (typeof event.at !== 'string' || !TIMESTAMP.test(event.at) || Number.isNaN(Date.parse(event.at))) errors.push('bad_at');
  if (typeof event.origin !== 'string' || !ORIGIN.test(event.origin)) errors.push('bad_origin');
  if (!Number.isInteger(event.seq) || event.seq < 1) errors.push('bad_seq');
  if (!nonEmpty(event.actor)) errors.push('missing_actor');
  if (!isObject(event.data)) errors.push('bad_data');
  if (errors.length === 0) {
    for (const code of EVENT_DATA_RULES[event.type](event.data)) if (code) errors.push(code);
  }
  return { ok: errors.length === 0, errors };
}

function isHumanActor(actor) {
  return typeof actor === 'string' && actor.startsWith('human:');
}

module.exports = {
  ACTIONS,
  CAMPAIGN_FIELDS,
  CAMPAIGN_ID,
  CONFIDENCE,
  EVENT_TYPES,
  TIMESTAMP,
  MISSION_OUTCOMES,
  STATES,
  STOP_REASONS,
  isHumanActor,
  validateCampaign,
  validateEvent,
};
