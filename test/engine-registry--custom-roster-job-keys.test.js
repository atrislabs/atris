'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { customRosterJobKeys } = require('../lib/engine-registry');

test('custom job keys stay in saved order and built-in jobs stay out', () => {
  const roster = {
    executor: { engine: 'claude', like: 'build' },
    'small-build': { engine: 'codex', like: 'build', model: 'gpt' },
    navigator: { engine: 'cursor' },
    'deep-review': { engine: 'grok', like: 'review' },
    notes: 'not a pick',
    validator: { engine: 'claude' },
    'search-pass': { engine: 'fable', like: 'search' },
  };
  const before = JSON.parse(JSON.stringify(roster));

  assert.deepStrictEqual(customRosterJobKeys(roster), ['small-build', 'deep-review', 'search-pass']);
  assert.deepStrictEqual(roster, before);
});

test('only real picks count, and number-like keys come out in number order', () => {
  const quiet = Symbol('quiet');
  const roster = {
    'small-build': { engine: 'codex' },
    10: { engine: 'claude' },
    2: { engine: 'grok' },
    spare: 'claude',
    list: [{ engine: 'codex' }],
    blank: { engine: '' },
    zero: { engine: 0 },
    none: { model: 'opus' },
    missing: null,
    executor: { engine: 'claude' },
    'executor-extra': { engine: 'cursor', like: 'build' },
    [quiet]: { engine: 'fable' },
  };

  assert.deepStrictEqual(customRosterJobKeys(roster), ['2', '10', 'small-build', 'executor-extra']);
  assert.deepStrictEqual(customRosterJobKeys([{ engine: 'codex' }, { engine: 'grok' }]), ['0', '1']);
});

test('empty, missing, and non-roster values return no keys', () => {
  assert.deepStrictEqual(customRosterJobKeys(undefined), []);
  assert.deepStrictEqual(customRosterJobKeys(null), []);
  assert.deepStrictEqual(customRosterJobKeys({}), []);
  assert.deepStrictEqual(customRosterJobKeys(''), []);
  assert.deepStrictEqual(customRosterJobKeys(0), []);
  assert.deepStrictEqual(customRosterJobKeys('ab'), []);
  assert.deepStrictEqual(customRosterJobKeys({
    navigator: { engine: 'cursor' },
    executor: { engine: 'claude' },
    validator: { engine: 'grok' },
  }), []);
});
