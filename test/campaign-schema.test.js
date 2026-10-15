'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { EVENT_TYPES, validateCampaign, validateEvent } = require('../lib/campaign-schema');

const event = (overrides = {}) => ({
  id: 'evt-1', campaign_id: 'cmp-ship', type: 'campaign_started', at: '2026-10-15T10:00:00Z',
  origin: 'laptop', seq: 1, actor: 'mission-lead',
  data: { title: 'Campaign ships across Atris', judge: 'node scripts/campaign-conformance.js', budget: 500 },
  ...overrides,
});

test('a campaign with title, judge, and budget is valid', () => {
  const result = validateCampaign({
    title: 'Campaign ships across Atris', judge: 'npm run validate:campaign', budget: 500,
    owner: 'mission-lead', seats: ['builder', { member: 'validator', role: 'reviewer' }], standing: false,
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('budget is optional, and a unit needs a budget to count', () => {
  assert.deepEqual(validateCampaign({ title: 't', judge: 'j' }).errors, []);
  assert.deepEqual(validateCampaign({ title: 't', judge: 'j', budget: 2000000, unit: 'tokens' }).errors, []);
  assert.deepEqual(validateCampaign({ title: 't', judge: 'j', budget: 0 }).errors, ['bad_budget']);
  assert.deepEqual(validateCampaign({ title: 't', judge: 'j', budget: 5, unit: 'credits' }).errors, ['bad_unit']);
  assert.deepEqual(validateCampaign({ title: 't', judge: 'j', unit: 'tokens' }).errors, ['unit_without_budget']);
});

test('a campaign without a judge is refused', () => {
  const result = validateCampaign({ title: 'No way to know', budget: 10 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('missing_judge'));
});

test('a parent that has its own parent is refused (one level only)', () => {
  const campaigns = { 'cmp-top': { title: 't', judge: 'j', budget: 1 }, 'cmp-mid': { title: 'm', judge: 'j', budget: 1, parent: 'cmp-top' } };
  const lookup = (id) => campaigns[id] || null;
  assert.deepEqual(validateCampaign({ title: 'a', judge: 'j', budget: 1, parent: 'cmp-top' }, { lookup }).errors, []);
  assert.ok(validateCampaign({ title: 'b', judge: 'j', budget: 1, parent: 'cmp-mid' }, { lookup }).errors.includes('nested_parent'));
});

test('an unknown event type is refused', () => {
  const result = validateEvent(event({ type: 'campaign_exploded' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('unknown_type'));
});

test('a mission that ends without reporting its cost is refused', () => {
  const ended = event({ type: 'mission_ended', data: { mission_id: 'm1', outcome: 'kept' } });
  assert.ok(validateEvent(ended).errors.includes('missing_cost'));
  ended.data.cost_usd = 0;
  assert.equal(validateEvent(ended).ok, true);
});

test('every event type has data rules and a valid start event passes', () => {
  assert.equal(validateEvent(event()).ok, true);
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
  assert.ok(validateEvent(event({ campaign_id: 'Campaign 1' })).errors.includes('bad_campaign_id'));
  assert.ok(validateEvent(event({ seq: 0 })).errors.includes('bad_seq'));
});

test('the schema exports the lists every surface serves', () => {
  const schema = require('../lib/campaign-schema');
  assert.deepEqual(schema.CONFIDENCE, ['open', 'leaning', 'stronger', 'answered']);
  assert.deepEqual(schema.STATES, ['running', 'needs_you', 'resting', 'queued', 'done', 'out_of_budget', 'paused']);
  assert.deepEqual(schema.STOP_REASONS, ['judge_passed', 'stopped', 'done_by_human', 'budget_spent']);
  assert.deepEqual(schema.MISSION_OUTCOMES, ['kept', 'reverted', 'failed']);
  assert.deepEqual(Object.keys(schema.CAMPAIGN_FIELDS).filter((k) => schema.CAMPAIGN_FIELDS[k].required), ['title', 'judge']);
  assert.deepEqual(schema.BUDGET_UNITS, ['dollars', 'tokens']);
  assert.ok(schema.CAMPAIGN_ID.test('cmp-ships-across-atris'));
  assert.ok(!schema.CAMPAIGN_ID.test('ships'));
});
