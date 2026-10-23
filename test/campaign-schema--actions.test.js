'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const schema = require('../lib/campaign-schema');
const { ACTIONS, EVENT_TYPES } = schema;

test('ACTIONS lists the nine campaign actions in order', () => {
  assert.deepEqual([...ACTIONS], [
    'start', 'pause', 'resume', 'answer_ask', 'change_bet', 'add_budget', 'fill_seat', 'veto', 'stop',
  ]);
  assert.equal(ACTIONS.length, 9);
});

test('ACTIONS holds unique snake_case names with no blanks', () => {
  assert.equal(new Set(ACTIONS).size, ACTIONS.length);
  for (const action of ACTIONS) {
    assert.equal(typeof action, 'string');
    assert.match(action, /^[a-z]+(_[a-z]+)*$/, `bad action name: ${action}`);
  }
});

test('ACTIONS is frozen, so a surface cannot add, change, or drop an action', () => {
  assert.equal(Object.isFrozen(ACTIONS), true);
  assert.throws(() => ACTIONS.push('delete'), TypeError);
  assert.throws(() => { ACTIONS[0] = 'launch'; }, TypeError);
  assert.throws(() => ACTIONS.pop(), TypeError);
  assert.equal(ACTIONS.length, 9);
  assert.equal(ACTIONS[0], 'start');
  assert.equal(ACTIONS.includes('delete'), false);
});

test('ACTIONS matching is exact: wrong case, padding, and unknown names are not actions', () => {
  assert.equal(ACTIONS.includes('pause'), true);
  assert.equal(ACTIONS.includes('Pause'), false);
  assert.equal(ACTIONS.includes(' pause'), false);
  assert.equal(ACTIONS.includes('paused'), false);
  assert.equal(ACTIONS.includes(''), false);
  assert.equal(ACTIONS.includes(undefined), false);
  assert.equal(ACTIONS.indexOf('stop'), ACTIONS.length - 1);
});

test('ACTIONS stays in step with the other schema exports', () => {
  assert.equal(require('../lib/campaign-schema').ACTIONS, ACTIONS);
  // Actions are verbs a person asks for; event types are what got recorded.
  // The two lists must not share a name, or a request would read as a fact.
  for (const action of ACTIONS) assert.equal(EVENT_TYPES.includes(action), false, `${action} is also an event type`);
  // The actions that change the record each have an event to land in.
  for (const type of ['paused', 'resumed', 'stopped', 'budget_added', 'mission_vetoed', 'bet_set', 'seat_filled', 'ask_answered']) {
    assert.equal(EVENT_TYPES.includes(type), true, `${type} missing from EVENT_TYPES`);
  }
});
