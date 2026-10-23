'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { engineEffortLevels } = require('../lib/runner-command');

test('engineEffortLevels returns configured effort levels for supported engines', () => {
  assert.deepStrictEqual(engineEffortLevels('claude'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(engineEffortLevels('codex'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepStrictEqual(engineEffortLevels('grok'), ['low', 'medium', 'high']);
  assert.deepStrictEqual(engineEffortLevels('agy'), ['low', 'medium', 'high']);
  assert.deepStrictEqual(engineEffortLevels('opencode'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(engineEffortLevels('haiku'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(engineEffortLevels('fable'), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('engineEffortLevels returns empty array for engines without effort configuration', () => {
  assert.deepStrictEqual(engineEffortLevels('atris-fast'), []);
  assert.deepStrictEqual(engineEffortLevels('mercury'), []);
  assert.deepStrictEqual(engineEffortLevels('cursor'), []);
  assert.deepStrictEqual(engineEffortLevels('devin'), []);
  assert.deepStrictEqual(engineEffortLevels('composer'), []);
  assert.deepStrictEqual(engineEffortLevels('commandcode'), []);
});

test('engineEffortLevels resolves runner profile aliases', () => {
  assert.deepStrictEqual(engineEffortLevels('antigravity'), ['low', 'medium', 'high']);
  assert.deepStrictEqual(engineEffortLevels('atris2-fast'), []);
  assert.deepStrictEqual(engineEffortLevels('atris-2-fast'), []);
});

test('engineEffortLevels handles missing, invalid, or unknown engine inputs safely', () => {
  assert.deepStrictEqual(engineEffortLevels('unknown-engine'), []);
  assert.deepStrictEqual(engineEffortLevels(''), []);
  assert.deepStrictEqual(engineEffortLevels(null), []);
  assert.deepStrictEqual(engineEffortLevels(undefined), []);
  assert.deepStrictEqual(engineEffortLevels(123), []);
  assert.deepStrictEqual(engineEffortLevels({}), []);
});
