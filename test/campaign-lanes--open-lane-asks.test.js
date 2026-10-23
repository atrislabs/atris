'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openLaneAsks, LANE_ASK_KIND } = require('../lib/campaign-lanes');

function opened(askId, lane, extra = {}) {
  return { type: 'ask_opened', actor: 'campaign-loop', data: { ask_id: askId, kind: LANE_ASK_KIND, lane, ...extra } };
}

function answered(askId, answer = 'yes') {
  return { type: 'ask_answered', actor: 'keshav', data: { ask_id: askId, answer } };
}

test('returns an empty set when there are no events', () => {
  for (const input of [undefined, null, []]) {
    const result = openLaneAsks(input);
    assert.ok(result instanceof Set);
    assert.equal(result.size, 0);
  }
});

test('an opened protected-lane ask shows its lane until it is answered', () => {
  assert.deepEqual([...openLaneAsks([opened('a1', 'billing')])], ['billing']);
  assert.equal(openLaneAsks([opened('a1', 'billing'), answered('a1')]).size, 0);
});

test('an answer closes the ask whatever the answer says', () => {
  assert.equal(openLaneAsks([opened('a1', 'security'), answered('a1', 'no')]).size, 0);
});

test('only the answered ask closes, other lanes stay open', () => {
  const events = [opened('a1', 'billing'), opened('a2', 'security'), opened('a3', 'deploy'), answered('a2')];
  assert.deepEqual([...openLaneAsks(events)].sort(), ['billing', 'deploy']);
});

test('two open asks on the same lane collapse to one lane, and one answer leaves the lane open', () => {
  const events = [opened('a1', 'billing'), opened('a2', 'billing')];
  assert.deepEqual([...openLaneAsks(events)], ['billing']);
  assert.deepEqual([...openLaneAsks([...events, answered('a1')])], ['billing']);
  assert.equal(openLaneAsks([...events, answered('a1'), answered('a2')]).size, 0);
});

test('an answer to an unknown ask closes nothing', () => {
  assert.deepEqual([...openLaneAsks([opened('a1', 'billing'), answered('zzz')])], ['billing']);
});

test('an answer that arrives before its ask does not stop that ask from opening', () => {
  assert.deepEqual([...openLaneAsks([answered('a1'), opened('a1', 'billing')])], ['billing']);
});

test('a lane can be asked again after an earlier ask on it was answered', () => {
  const events = [opened('a1', 'billing'), answered('a1'), opened('a2', 'billing')];
  assert.deepEqual([...openLaneAsks(events)], ['billing']);
});

test('ignores asks of other kinds and asks with no lane', () => {
  const events = [
    { type: 'ask_opened', actor: 'campaign-loop', data: { ask_id: 'o1', kind: 'budget', lane: 'billing' } },
    { type: 'ask_opened', actor: 'campaign-loop', data: { ask_id: 'o2', lane: 'billing' } },
    { type: 'ask_opened', actor: 'campaign-loop', data: { ask_id: 'o3', kind: LANE_ASK_KIND } },
    { type: 'ask_opened', actor: 'campaign-loop', data: { ask_id: 'o4', kind: LANE_ASK_KIND, lane: '' } },
    { type: 'ask_opened', actor: 'campaign-loop' },
  ];
  assert.equal(openLaneAsks(events).size, 0);
});

test('ignores events that are not ask events, and answers with no data', () => {
  const events = [
    { type: 'campaign_started', actor: 'frontend-dev', data: { title: 'Lock apps' } },
    opened('a1', 'billing'),
    { type: 'mission_started', actor: 'payments-infra', data: { mission_id: 'm1' } },
    { type: 'ask_answered', actor: 'keshav' },
    { type: 'judge_ran' },
  ];
  assert.deepEqual([...openLaneAsks(events)], ['billing']);
});

test('does not change the events it reads, and returns a fresh set each call', () => {
  const events = [opened('a1', 'billing'), opened('a2', 'deploy'), answered('a2')];
  const before = JSON.stringify(events);
  const first = openLaneAsks(events);
  const second = openLaneAsks(events);
  assert.equal(JSON.stringify(events), before);
  assert.notStrictEqual(first, second);
  assert.deepEqual([...first], [...second]);
});
