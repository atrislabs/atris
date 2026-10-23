'use strict';

// The question a campaign shows a person when a mission touches a protected lane.
// laneQuestion is pure string work: no files, no env, no clock, so these tests
// only compare its output to fixed expected strings.

const { test } = require('node:test');
const assert = require('node:assert');
const { laneQuestion } = require('../lib/campaign-lanes');

const ELLIPSIS = '…';

// The fixed sentence frame around the quoted objective.
const frame = (member, lane, quoted) =>
  `${member}'s mission touches ${lane}: "${quoted}". Missions that touch ${lane} wait for you. Let this campaign work on ${lane}? Answer yes to allow it.`;

test('a normal objective is quoted in the fixed question frame', () => {
  const q = laneQuestion('billing', 'Ada', 'Raise prices by 5%');
  assert.equal(q, frame('Ada', 'billing', 'Raise prices by 5%'));
  assert.equal(q, `Ada's mission touches billing: "Raise prices by 5%". Missions that touch billing wait for you. Let this campaign work on billing? Answer yes to allow it.`);
});

test('line breaks and runs of spaces collapse to single spaces before quoting', () => {
  const q = laneQuestion('security', 'Ops', '  Rotate\n\nthe   keys \t now  ');
  assert.equal(q, frame('Ops', 'security', 'Rotate the keys now'));
});

test('an objective of exactly 140 characters is quoted whole', () => {
  const objective = 'b'.repeat(140);
  const q = laneQuestion('deploys', 'Ops', objective);
  assert.equal(q, frame('Ops', 'deploys', objective));
  assert.ok(!q.includes(ELLIPSIS));
});

test('an objective of 141 characters is cut to 139 characters plus an ellipsis', () => {
  const q = laneQuestion('customers', 'Ada', 'a'.repeat(141));
  assert.equal(q, frame('Ada', 'customers', `${'a'.repeat(139)}${ELLIPSIS}`));
});

test('length is measured after whitespace collapses, so padding alone does not truncate', () => {
  // Raw length is over 140, but the collapsed objective is just "a b".
  const q = laneQuestion('billing', 'Ada', `a${' '.repeat(200)}b`);
  assert.equal(q, frame('Ada', 'billing', 'a b'));
  assert.ok(!q.includes(ELLIPSIS));
});

test('an empty, blank, null, or missing objective gives an empty quote, not a crash', () => {
  assert.equal(laneQuestion('deploys', 'Ops', ''), frame('Ops', 'deploys', ''));
  assert.equal(laneQuestion('deploys', 'Ops', '   \n\t '), frame('Ops', 'deploys', ''));
  assert.equal(laneQuestion('deploys', 'Ops', null), frame('Ops', 'deploys', ''));
  assert.equal(laneQuestion('deploys', 'Ops'), frame('Ops', 'deploys', ''));
});
