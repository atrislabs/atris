'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { missionLabel } = require('../commands/agents');

test('missionLabel formats the objective with its number and four meaningful words', () => {
  assert.strictEqual(missionLabel({
    n: 7,
    objective: 'Please fix the broken login screen before release',
    slug: 'ignored-slug',
    id: 'ignored-id',
  }), '#7 fix broken login screen');
  assert.strictEqual(missionLabel({ objective: 'Repair LOGIN, and retry!' }), 'repair login retry');
});

test('missionLabel falls back from an empty objective to the slug and then the id', () => {
  assert.strictEqual(missionLabel({
    objective: '', slug: 'repair-login-screen', id: 'ignored-id',
  }), 'repair login screen');
  assert.strictEqual(missionLabel({ objective: '', slug: '', id: 'mission-42' }), 'mission 42');
});

test('missionLabel handles missing missions and records with no meaningful words', () => {
  assert.strictEqual(missionLabel(null), null);
  assert.strictEqual(missionLabel(undefined), null);
  assert.strictEqual(missionLabel({}), 'unknown');
  assert.strictEqual(missionLabel({ n: 3, objective: 'the and to' }), '#3');
  assert.strictEqual(missionLabel({
    objective: '!!!', id: 'mission-abcdefgh',
  }), 'abcdefgh');
});
